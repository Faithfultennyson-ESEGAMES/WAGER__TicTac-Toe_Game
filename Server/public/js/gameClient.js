
import audioManager from "./audioManager.js";
import UIManager from "./uiManager.js";
import SocketManager from "./socketManager.js";
import { parseQueryParams, buildRejoinPayload } from "./urlParser.js";

const STORAGE_KEY = 'ttt.session';
const REQUIRED_GAME_IMAGES = [
  'assets/images/grid_background_ready.png',
  'assets/images/x_symbol.png',
  'assets/images/o_symbol.png',
];

class GameClient {
  constructor() {
    this.ui = new UIManager();
    this.params = parseQueryParams();
    this.localPlayer = {
      id: this.params.playerId,
      name: this.params.playerName,
    };

    this.session = null;
    this.turnDurationSec = null;
    this.playerSymbol = null;
    this.gameState = 'created'; // created | waiting | playing | ended
    this.turnTick = null;
    this.endScreenTimer = null;
    this.postGameHoldTimer = null;
    this.moveLock = false;
    this.handlersAttached = false;
    this.placedSymbols = 0;
    this.selectedSymbolIndex = null; // The index of the piece to be moved
    this.readyState = 'not-ready'; // not-ready | sending | ready
    this.readyAction = null;
    this.readyMode = null; // auto | manual | null
    this.autoReadyFailed = false;
    this.joinConfirmed = false;
    this.requiredAssetsReady = false;
    this.requiredAssetsPromise = null;
    this.latestLobbyState = null;
    this.reconnectToken = null;

    let socketUrl;
    try {
      const origin = new URL(this.params.joinUrl).origin;
      socketUrl = origin.replace(/^http/, 'ws');
    } catch (e) {
      socketUrl = null;
    }
    this.socketUrl = socketUrl;
    try {
      // API and game client are served by the same process/origin. The HTTP
      // session route lives at /session/:id (not /api/session/:id).
      this.apiBase = this.params.joinUrl ? new URL(this.params.joinUrl).origin : '';
    } catch (e) {
      this.apiBase = '';
    }

    this.socketManager = new SocketManager({
      url: this.socketUrl,
      connectionCallbacks: {
        onStatusChange: (status, meta) => this.handleConnectionStatus(status, meta),
        onReconnectNeeded: () => this.attemptRejoin(),
      },
    });
  }

  async init() {
    // Audio remains best-effort and independent from gameplay readiness.
    // Browser/WebView gesture restrictions must never block the Ready gate.
    audioManager.init().catch(() => undefined);
    this.bindUIEvents();

    if (!this.params.joinUrl || !this.params.sessionId || !this.localPlayer.id || !this.localPlayer.name) {
      this.ui.showOverlay({
        title: 'Invalid Link',
        message: 'This game link is incomplete. Please ensure you have a valid joinUrl, playerId, and playerName.',
        showSpinner: false,
      });
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: this.params.sessionId || null,
        reason: 'invalid_link',
      });
      return;
    }

    this.ui.showOverlay({
      title: 'Preparing Game',
      message: 'Loading required gameplay assets...',
      showSpinner: true,
    });
    this.ui.setBoardVisible(false);

    // These visuals are mandatory gameplay assets. They can be fetched in
    // parallel with the join handshake, but automatic Ready is not allowed
    // until every one is actually loaded/decoded.
    this.requiredAssetsPromise = this.prepareRequiredAssets()
      .then(() => {
        this.requiredAssetsReady = true;
        this.maybeAutoReady();
      })
      .catch(() => {});

    try {
      await this.socketManager.connect();
      this.attachSocketHandlers();

      this.gameState = 'waiting';
      this.ui.showOverlay({
        title: 'Joining Game Session',
        message: 'Waiting for the other player to join.',
        showSpinner: true,
      });

      // A normal WebView/page reload keeps sessionStorage. Restore the private
      // reconnect token before the very first join so reloads are treated as
      // authorized reconnects instead of new/duplicate players.
      const cached = this.restoreSession();
      const cachedMatchesCurrentPlayer = cached
        && cached.sessionId === this.params.sessionId
        && cached.playerId === this.localPlayer.id;
      if (!cachedMatchesCurrentPlayer && cached) {
        this.clearPersistedSession();
        this.reconnectToken = null;
      }

      const joinPayload = {
        sessionId: this.params.sessionId,
        playerId: this.localPlayer.id,
        playerName: this.localPlayer.name,
        reconnectToken: cachedMatchesCurrentPlayer ? (cached.reconnectToken || null) : null,
      };

      const joinResult = await this.socketManager.emitWithAck('join', joinPayload);
      if (joinResult && joinResult.reconnectToken) {
        this.reconnectToken = joinResult.reconnectToken;
      }
      this.joinConfirmed = true;
      this.persistSession();
      this.maybeAutoReady();

    } catch (error) {
      const reason = error?.message || 'Unknown error';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Could not connect to the game server (${reason}). Please check the link and try again.`,
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', { reason, source: 'init' });
    }
  }

  async prepareRequiredAssets() {
    await Promise.all(REQUIRED_GAME_IMAGES.map((src) => this.loadRequiredImage(src)));
  }

  async loadRequiredImage(src) {
    for (;;) {
      try {
        const image = new Image();
        image.decoding = 'async';
        image.src = src;

        await new Promise((resolve, reject) => {
          if (image.complete) {
            if (image.naturalWidth > 0) resolve();
            else reject(new Error(`Failed to load ${src}`));
            return;
          }
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        });

        if (typeof image.decode === 'function') {
          await image.decode();
        }
        return;
      } catch (error) {
        // Required assets are not optional. Stay in Preparing Game and retry;
        // do not manufacture Ready just because the network was temporarily slow.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  bindUIEvents() {
    this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));
    this.ui.setupMuteButton();
    document.getElementById('result-close-btn').addEventListener('click', () => this.ui.hideResult());

    // Immediate, low-latency click feedback on any interactive control.
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.board-cell, .control-btn, .mute-btn')) {
        this.ui.playClick();
      }
    });

    // First user gesture: unlock audio and start background music (autoplay
    // policies in webviews require a gesture before playback).
    ['pointerdown','click','touchstart','keydown'].forEach(evt => {
      window.addEventListener(evt, () => {
        audioManager.ensureContextReady()?.catch?.(() => {});
        this.ui.startMusic();
      }, { once: true });
    });
  }

  attachSocketHandlers() {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    this.socketManager.on('join-error', (payload) => this.handleJoinError(payload));
    this.socketManager.on('lobby-state', (payload) => this.handleLobbyState(payload));
    this.socketManager.on('waiting-for-player', () => this.handleWaitingForPlayer());
    this.socketManager.on('ready-confirmed', (payload) => this.handleReadyConfirmed(payload));
    this.socketManager.on('ready-error', (payload) => this.handleReadyError(payload));
    this.socketManager.on('session-ended', (payload) => this.handleSessionEnded(payload));
    this.socketManager.on('game-found', (payload) => this.handleGameFound(payload));
    this.socketManager.on('turn-started', (payload) => this.handleTurnStarted(payload));
    this.socketManager.on('move-applied', (payload) => this.handleMoveApplied(payload));
    this.socketManager.on('move-error', (payload) => this.handleMoveError(payload));
    this.socketManager.on('game-ended', (payload) => this.handleGameEnded(payload));
    this.socketManager.on('player-disconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'disconnected'));
    this.socketManager.on('player-reconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'reconnected'));
  }

  handleJoinError(payload) {
    this.joinConfirmed = false;
    if (this.readyAction) {
      this.readyAction.cancel();
      this.readyAction = null;
    }
    this.readyState = 'not-ready';
    this.readyMode = null;
    this.latestLobbyState = null;
    this.ui.showOverlay({
        title: "Could Not Join",
        message: payload.message || "An unknown error occurred.",
        showSpinner: false,
    });
    this.broadcastEvent('INVALID_SESSION', {
      sessionId: this.params.sessionId || null,
      reason: payload?.message || 'join_error',
    });
  }

  handleWaitingForPlayer() {
    if (this.gameState === 'ended' || this.gameState === 'playing') return;
    this.ui.showOverlay({
      title: 'Waiting for Opponent',
      message: 'Waiting for the other player to join.',
      showSpinner: true,
    });
  }

  handleLobbyState(state = {}) {
    if (this.gameState === 'ended' || state.status === 'active') return;

    this.gameState = 'waiting';
    this.latestLobbyState = state;
    const players = Array.isArray(state.players) ? state.players : [];
    const me = players.find((player) => player.playerId === this.localPlayer.id);
    const opponent = players.find((player) => player.playerId !== this.localPlayer.id);

    // Never invent eligibility locally. Automatic Ready is possible only once
    // the authoritative lobby state contains this authenticated player.
    if (!me) {
      this.ui.showOverlay({
        title: 'Joining Game Session',
        message: 'Confirming your player identity...',
        showSpinner: true,
      });
      return;
    }

    if (me?.ready) {
      this.readyState = 'ready';
      if (this.readyAction) {
        this.readyAction.cancel();
        this.readyAction = null;
      }
    }

    if (players.length < 2 || !opponent?.connected) {
      this.readyState = me?.ready ? 'ready' : 'not-ready';
      this.ui.showOverlay({
        title: 'Waiting for Opponent',
        message: players.length < 2
          ? 'Waiting for the other player to join.'
          : 'Your opponent disconnected. Waiting for them to reconnect.',
        showSpinner: true,
      });
      return;
    }

    if (me.ready) {
      this.ui.showOverlay({
        title: 'Ready, Waiting for Other Players',
        message: opponent?.ready ? 'Starting game...' : 'Ready confirmed by the server. Waiting for the other player.',
        showSpinner: !opponent?.ready,
      });
      return;
    }

    this.readyState = 'not-ready';

    if (!this.joinConfirmed || !this.requiredAssetsReady) {
      this.ui.showOverlay({
        title: 'Preparing Game',
        message: this.requiredAssetsReady
          ? 'Confirming your game session...'
          : 'Loading required gameplay assets...',
        showSpinner: true,
      });
      return;
    }

    this.maybeAutoReady(state);
  }

  maybeAutoReady(state = this.latestLobbyState) {
    if (this.gameState !== 'waiting'
      || !this.joinConfirmed
      || !this.requiredAssetsReady
      || this.autoReadyFailed
      || this.readyState !== 'not-ready'
      || !state
      || state.status !== 'pending') {
      return;
    }

    const players = Array.isArray(state.players) ? state.players : [];
    const me = players.find((player) => player.playerId === this.localPlayer.id);
    const opponent = players.find((player) => player.playerId !== this.localPlayer.id);

    if (!me || me.ready || !me.connected || !opponent || !opponent.connected) {
      return;
    }

    this.handleReadyClick({ automatic: true });
  }

  handleReadyClick({ automatic = false } = {}) {
    if (this.readyState === 'ready'
      || this.readyState === 'sending'
      || !this.params.sessionId
      || !this.joinConfirmed
      || !this.requiredAssetsReady) {
      return;
    }

    if (!automatic) this.autoReadyFailed = false;
    this.readyMode = automatic ? 'auto' : 'manual';
    this.readyState = 'sending';
    this.ui.showOverlay({
      title: 'Confirming Ready',
      message: 'Sending your Ready status to the server...',
      showSpinner: true,
    });
    this.readyAction = this.socketManager.sendReliably('player-ready', {
      sessionId: this.params.sessionId,
      playerId: this.localPlayer.id,
    }, {
      intervalMs: 3000,
      maxAttempts: 8,
      onExhausted: () => {
        if (this.readyState !== 'sending') return;
        const automaticAttempt = this.readyMode === 'auto';
        this.readyState = 'not-ready';
        this.readyAction = null;
        this.readyMode = null;
        if (automaticAttempt) this.autoReadyFailed = true;
        this.ui.showOverlay({
          title: 'Ready Not Confirmed',
          message: automaticAttempt
            ? 'Automatic Ready could not be confirmed. Tap Ready to try again.'
            : 'The server did not confirm your Ready status. Please try again.',
          actionLabel: 'Ready',
          actionHandler: () => this.handleReadyClick(),
          showSpinner: false,
        });
      },
    });
  }

  handleReadyConfirmed({ playerId } = {}) {
    if (playerId !== this.localPlayer.id) return;
    this.readyState = 'ready';
    this.readyMode = null;
    this.autoReadyFailed = false;
    if (this.readyAction) {
      this.readyAction.cancel();
      this.readyAction = null;
    }
    this.ui.showOverlay({
      title: 'Ready, Waiting for Other Players',
      message: 'Ready confirmed by the server. Waiting for the other player.',
      showSpinner: true,
    });
  }

  handleReadyError(payload = {}) {
    const automaticAttempt = this.readyMode === 'auto';
    this.readyState = 'not-ready';
    this.readyMode = null;
    if (automaticAttempt) this.autoReadyFailed = true;
    if (this.readyAction) {
      this.readyAction.cancel();
      this.readyAction = null;
    }
    this.ui.showOverlay({
      title: 'Ready Failed',
      message: automaticAttempt
        ? 'Automatic Ready could not be confirmed. Tap Ready to try again.'
        : (payload.message || 'Your Ready status could not be confirmed. Please try again.'),
      actionLabel: 'Ready',
      actionHandler: () => this.handleReadyClick(),
      showSpinner: false,
    });
  }

  handleSessionEnded(payload = {}) {
    if (this.gameState === 'ended') return;
    if (this.readyAction) {
      this.readyAction.cancel();
      this.readyAction = null;
    }
    this.handleGameEnded(payload);
  }

  handleGameFound(session) {
    if (session.status === 'ended') {
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: session.sessionId || this.params.sessionId || null,
        reason: 'session_ended',
      });
      this.handleGameEnded({ sessionId: session.sessionId });
      return;
    }

    const normalizedPlayers = this.normalizePlayers(session.players);
    this.gameState = 'playing';
    this.readyState = 'ready';
    this.readyMode = null;
    this.autoReadyFailed = false;
    if (this.readyAction) {
      this.readyAction.cancel();
      this.readyAction = null;
    }
    this.session = {
      sessionId: session.sessionId,
      players: normalizedPlayers,
      board: session.board || Array(9).fill(null),
      turnDurationSec: session.turnDurationSec,
      currentTurnPlayerId: session.currentTurnPlayerId || null,
      turnExpiresAt: session.turnExpiresAt || null,
      status: 'active',
    };
    this.turnDurationSec = session.turnDurationSec || null;
    this.playerSymbol = this.resolvePlayerSymbol(this.session);
    this.placedSymbols = this.session.board.filter(s => s === this.playerSymbol).length;
    this.persistSession();

    this.ui.markWinningCells([]);
    this.ui.updatePlayers(this.session.players);
    this.ui.setBoardVisible(true);
    this.ui.setBoardState(this.session.board);
    this.ui.hideOverlay();
    const turnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
    this.ui.setCurrentTurn(turnSymbol, { message: 'Game starting!' });

    if (session.turnExpiresAt) {
      this.startTurnTimer(session.turnExpiresAt);
    } else {
      this.ui.updateTimer('--');
    }
  }

  handleTurnStarted({ currentTurnPlayerId, expiresAt }) {
    if (!this.session) return;
    this.session.currentTurnPlayerId = currentTurnPlayerId;
    this.session.expiresAt = expiresAt;
    const symbol = this.getSymbolForPlayerId(currentTurnPlayerId);
    this.ui.setCurrentTurn(symbol, {});
    this.startTurnTimer(expiresAt);
  }

  handleMoveApplied({ board, currentTurnPlayerId }) {
    if (!this.session) return;
    const previousBoard = Array.isArray(this.session.board) ? [...this.session.board] : Array(9).fill(null);
    this.session.board = board;
    this.session.currentTurnPlayerId = currentTurnPlayerId;
    this.moveLock = false;
    this.placedSymbols = this.session.board.filter(s => s === this.playerSymbol).length;
    this.selectedSymbolIndex = null; // Reset selection
    this.ui.setSelectedSymbol(null);

    const placedIndex = board.findIndex((cell, idx) => cell && cell !== previousBoard[idx]);
    if (placedIndex >= 0) {
      this.ui.onMovePlaced(board[placedIndex]);
    }
    this.ui.setBoardState(board);
    const symbol = this.getSymbolForPlayerId(currentTurnPlayerId);
    this.ui.setCurrentTurn(symbol, {});
    this.stopTurnTimer();
    this.ui.updateTimer('--');
  }

  handleGameEnded({ sessionId, reason, winState, winnerPlayerId, players = [] } = {}) {
    if (this.gameState === 'ended') return;
    this.gameState = 'ended';
    this.moveLock = true;
    this.stopTurnTimer();
    this.ui.stopTimerWarning();

    this.clearPersistedSession();
    this.ui.hideOverlay();
    clearTimeout(this.postGameHoldTimer);
    this.postGameHoldTimer = null;
    clearInterval(this.endScreenTimer);
    this.endScreenTimer = null;

    const outcome = (reason === 'win' || winState === 'win')
      ? 'win'
      : (reason === 'draw' || winState === 'draw') ? 'draw' : 'none';
    const payloadPlayers = Array.isArray(players) && players.length ? this.normalizePlayers(players) : null;
    const finalPlayers = payloadPlayers || this.session?.players || { X: {}, O: {} };
    const playerList = Object.values(finalPlayers).filter((player) => player && player.id);
    const winner = outcome === 'win' ? playerList.find((player) => player.id === winnerPlayerId) || null : null;
    const loser = outcome === 'win' ? playerList.find((player) => player.id !== winnerPlayerId) || null : null;

    const leaderboardRows = outcome === 'win'
      ? [
          { rank: 1, name: winner?.name || 'Winner', symbol: winner?.symbol || '', status: 'WINNER' },
          { rank: 2, name: loser?.name || 'Loser', symbol: loser?.symbol || '', status: 'LOSER' },
        ]
      : outcome === 'draw'
        ? playerList.map((player, index) => ({
            rank: index + 1,
            name: player.name || 'Player',
            symbol: player.symbol || '',
            status: 'DRAW',
          }))
        : [];

    if (outcome === 'win' || outcome === 'draw') {
      this.ui.onGameEnded({
        outcome,
        isLocalWinner: outcome === 'win' && winnerPlayerId === this.localPlayer.id,
      });
    }

    const gameplayResult = outcome === 'win' || outcome === 'draw';
    const holdMs = gameplayResult && this.session ? 7000 : 0;

    if (holdMs > 0) {
      // Preserve the final board long enough for both players to see exactly
      // how the winning/drawing move completed. The top banner carries the
      // result while the board remains read-only behind it.
      this.ui.setBoardVisible(true);
      this.ui.setCurrentTurn(null, { message: 'Game Ended' });
      this.ui.updateTimer('--');
      this.ui.showGameEndedBanner({
        outcome,
        winnerName: winner?.name || null,
        loserName: loser?.name || null,
      });
    } else {
      this.ui.setBoardVisible(false);
    }

    const showFinalScreen = () => {
      this.postGameHoldTimer = null;
      this.ui.setBoardVisible(false);
      this.ui.showEndScreen({ outcome, rows: leaderboardRows });
      let seconds = 0;
      this.ui.updateEndScreenTimer(seconds);
      this.endScreenTimer = setInterval(() => {
        seconds++;
        this.ui.updateEndScreenTimer(seconds);
        if (seconds >= 60) {
          clearInterval(this.endScreenTimer);
          this.endScreenTimer = null;
          this.ui.updateEndScreenMessage("Session window expired");
        }
      }, 1000);
    };

    if (holdMs > 0) {
      this.postGameHoldTimer = setTimeout(showFinalScreen, holdMs);
    } else {
      showFinalScreen();
    }
  }

  handlePlayerStatusUpdate({ playerId, status }, type) {
    if (!this.session) return;
    const targetId = playerId;

    const playerEntry = Object.entries(this.session.players).find(([, p]) => p.id === targetId);
    const player = playerEntry ? playerEntry[1] : null;
    if (player) {
      player.connected = (type === 'reconnected');
      this.ui.updatePlayers(this.session.players);
      this.ui.toast(`Player ${player.name} has ${type}.`);
    }
  }

  handleConnectionStatus(status, meta = {}) {
    this.ui.setConnectionStatus(status, status.charAt(0).toUpperCase() + status.slice(1));

    if (this.gameState === 'ended') {
      return;
    }

    if (status === 'connected') {
      if (this.gameState === 'playing') {
        this.ui.showOverlay({
          title: 'Rejoining Session',
          message: 'Restoring your game...',
          showSpinner: true,
        });
        this.ui.setBoardVisible(false);
      } else {
        this.ui.showOverlay({
          title: 'Joining Game Session',
          message: 'Waiting for the other player to join.',
          showSpinner: true,
        });
      }
    } else if (status === 'disconnected' || status === 'reconnecting') {
      this.joinConfirmed = false;
      if (this.gameState === 'waiting') {
        if (this.readyAction) {
          this.readyAction.cancel();
          this.readyAction = null;
        }
        this.readyState = 'not-ready';
        this.readyMode = null;
        this.autoReadyFailed = false;
        this.latestLobbyState = null;
      }
      this.ui.setBoardVisible(false);
      this.ui.showOverlay({
        title: 'Connection Lost',
        message: 'Attempting to restore connection...',
        showSpinner: true,
      });
    } else if (status === 'error' && meta?.error === 'reconnect_failed') {
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: 'Could not reconnect to the game server. Please try again.',
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', {
        reason: 'reconnect_failed',
        source: 'rejoin',
      });
    }
  }

  async attemptRejoin() {
    this.joinConfirmed = false;
    const cached = this.restoreSession();
    if (!cached) {
        this.ui.showOverlay({
            title: 'Cannot Rejoin',
            message: 'No previous session data found. Please use a valid game link to join.',
            showSpinner: false,
        });
        this.broadcastEvent('INVALID_SESSION', {
          sessionId: null,
          reason: 'missing_session',
        });
        return;
    }

    this.ui.showOverlay({
      title: 'Rejoining Session',
      message: 'Attempting to reconnect to your previous game...',
      showSpinner: true,
    });

    try {
      await this.socketManager.connect();
      const joinResult = await this.socketManager.emitWithAck('join', {
        sessionId: cached.sessionId,
        playerId: this.localPlayer.id,
        playerName: this.localPlayer.name,
        reconnectToken: cached.reconnectToken || this.reconnectToken || null,
      });
      if (joinResult && joinResult.reconnectToken) {
        this.reconnectToken = joinResult.reconnectToken;
      }
      this.joinConfirmed = true;
      this.persistSession();
      this.maybeAutoReady();
    } catch (error) {
      const reason = error?.message || 'Connection failed';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Could not reconnect to the game server (${reason}). Please check the link and try again.`,
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', { reason, source: 'rejoin' });
      return;
    }

    const state = await this.fetchSessionState(cached.sessionId);
    if (state && state.status !== 'ended') {
      if (state.status === 'active') {
        this.handleGameFound(state);
      } else {
        this.handleLobbyState(state);
      }
      this.playerSymbol = this.resolvePlayerSymbol(state);
      this.persistSession();
      this.ui.toast('Successfully rejoined session.');
    } else {
      this.clearPersistedSession();
      this.ui.showOverlay({
        title: 'Session Unavailable',
        message: 'The previous session has ended or could not be found.',
        showSpinner: false,
      });
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: cached.sessionId || null,
        reason: 'session_unavailable',
      });
    }
  }

  handleCellSelection(index) {
    if (this.gameState !== 'playing' || !this.session || this.moveLock) {
      return;
    }
    audioManager.ensureContextReady()?.catch?.(() => {});
    const currentTurnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
    if (this.playerSymbol !== currentTurnSymbol) {
      this.ui.toast('Not your turn.');
      return;
    }

    // Stage 1: Placing the first 3 symbols
    if (this.placedSymbols < 3) {
        if (this.session.board[index]) {
            this.ui.toast('Cell already taken.');
            return;
        }

        this.moveLock = true;
        const movePayload = {
            sessionId: this.session.sessionId,
            playerId: this.localPlayer.id,
            position: index,
        };

        this.socketManager.emit('make-move', movePayload).catch(err => {
            this.moveLock = false;
            this.ui.toast('Move submission failed.');
        });
    } else {
      // Stage 2: Relocating symbols
        if (this.selectedSymbolIndex === null) {
            // Step 1: Select a piece to move
            if (this.session.board[index] !== this.playerSymbol) {
                this.ui.toast('Select one of your symbols to move.');
                return;
            }
            this.selectedSymbolIndex = index;
            this.ui.setSelectedSymbol(index);
            this.ui.toast('Select an empty cell to move to.');
        } else {
            // Step 2: Select an empty destination cell
            if (this.session.board[index] !== null) {
                 if (index === this.selectedSymbolIndex) { // Allow deselecting
                    this.selectedSymbolIndex = null;
                    this.ui.setSelectedSymbol(null);
                    return;
                }
                this.ui.toast('Destination cell must be empty.');
                return;
            }

            this.moveLock = true;
            const relocatePayload = {
                sessionId: this.session.sessionId,
                playerId: this.localPlayer.id,
                from: this.selectedSymbolIndex,
                to: index,
            };

            this.socketManager.emit('relocate-move', relocatePayload).catch(err => {
                this.moveLock = false;
                this.ui.toast('Relocation failed.');
            });
        }
    }
  }

  handleMoveError(error = {}) {
    this.moveLock = false;
    const message = error?.message || 'Move was rejected.';
    this.ui.toast(message);
    // If the error was due to a bad selection, reset the UI state
    if (this.selectedSymbolIndex !== null) {
        this.selectedSymbolIndex = null;
        this.ui.setSelectedSymbol(null);
    }
  }

  resolvePlayerSymbol(session) {
    const players = Array.isArray(session.players) ? this.normalizePlayers(session.players) : session.players;
    if (players?.X?.id === this.localPlayer.id) return 'X';
    if (players?.O?.id === this.localPlayer.id) return 'O';
    return null;
  }

  normalizePlayers(players = []) {
    const normalized = { X: {}, O: {} };
    players.forEach((player) => {
      if (!player || !player.symbol) return;
      normalized[player.symbol] = {
        id: player.playerId,
        name: player.playerName,
        symbol: player.symbol,
        connected: player.connected !== false,
        ready: Boolean(player.ready),
      };
    });
    return normalized;
  }

  getSymbolForPlayerId(playerId) {
    if (!playerId || !this.session?.players) return null;
    const entry = Object.entries(this.session.players).find(([, p]) => p.id === playerId);
    return entry ? entry[0] : null;
  }

  startTurnTimer(turnExpiresAt) {
    this.stopTurnTimer();
    if (!turnExpiresAt) {
      this.ui.updateTimer('--');
      return;
    }
    const expiry = new Date(turnExpiresAt).getTime();
    const totalDurationSec = this.computeTurnDurationSec(expiry);
    const cautionThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.5));
    const warnThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.3));

    this.turnTick = setInterval(() => {
      const remaining = Math.max(0, expiry - this.socketManager.now());
      const seconds = Math.ceil(remaining / 1000);
      const display = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      let state = 'normal';
      if (seconds <= warnThresholdSec) {
        state = 'danger';
        this.ui.startTimerWarning();
      } else if (seconds <= cautionThresholdSec) {
        state = 'warning';
        this.ui.stopTimerWarning();
      } else {
        this.ui.stopTimerWarning();
      }
      this.ui.updateTimer(display, state);
      if (remaining <= 0) {
        this.ui.stopTimerWarning();
        this.stopTurnTimer();
      }
    }, 500);
  }

  computeTurnDurationSec(expiryMs) {
    if (this.turnDurationSec) return this.turnDurationSec;
    const guess = Math.ceil((expiryMs - this.socketManager.now()) / 1000);
    return Math.max(guess, 1);
  }

  stopTurnTimer() {
    clearInterval(this.turnTick);
    this.turnTick = null;
  }

  persistSession() {
    const sessionId = this.session?.sessionId || this.params.sessionId;
    if (!sessionId || !this.localPlayer.id) return;
    const data = JSON.stringify({
      sessionId,
      playerId: this.localPlayer.id,
      symbol: this.playerSymbol || null,
      reconnectToken: this.reconnectToken || null,
    });
    try {
      sessionStorage.setItem(STORAGE_KEY, data);
    } catch (error) {
      // Some privacy-restricted WebViews disable sessionStorage. The live
      // socket remains usable; only refresh/reconnect persistence is lost.
    }
  }

  restoreSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data.reconnectToken) {
        this.reconnectToken = data.reconnectToken;
      }
      return data;
    } catch (error) {
      return null;
    }
  }

  clearPersistedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  async fetchSessionState(sessionId) {
    if (!this.apiBase) return null;
    try {
      // no-store: session state must always be fresh inside app/website webviews.
      const response = await fetch(`${this.apiBase}/session/${sessionId}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  broadcastEvent(type, payload) {
    if (typeof window.broadcastEvent === 'function') {
      window.broadcastEvent(type, payload);
    }
  }
}

export default GameClient;
