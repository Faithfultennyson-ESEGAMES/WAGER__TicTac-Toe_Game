(() => {
  // public/js/audioManager.js
  var MUTE_STORAGE_KEY = "ttt.muted";
  var MANIFEST = {
    bgMusic: "./assets/sounds/bg_music.mp3",
    xPlace: "./assets/sounds/x_place.mp3",
    oPlace: "./assets/sounds/o_place.mp3",
    timerWarning: "./assets/sounds/timer_warning.mp3",
    uiClick: "./assets/sounds/ui_click.wav",
    gameWon: "./assets/sounds/GameWon.mp3",
    gameLost: "./assets/sounds/GameLost.mp3"
  };
  var VOLUMES = {
    bgMusic: 0.18,
    xPlace: 0.9,
    oPlace: 0.9,
    gameWon: 0.9,
    gameLost: 0.9,
    timerWarning: 0.8,
    uiClick: 0.35
  };
  var LOOPING = /* @__PURE__ */ new Set(["bgMusic", "timerWarning"]);
  var UNLOCK_EVENTS = ["pointerdown", "touchstart", "touchend", "mousedown", "click", "keydown"];
  var AudioManager = class {
    constructor() {
      this.enabled = true;
      this.initialized = false;
      this.muted = this.loadMutedPreference();
      this.audioContext = null;
      this.masterGain = null;
      this.musicGain = null;
      this.sfxGain = null;
      this.buffers = {};
      this.elements = {};
      this.musicSource = null;
      this.musicElement = null;
      this.musicWanted = false;
      this.timerSource = null;
      this.timerElement = null;
      this.timerWarningActive = false;
      this.unlocked = false;
      this._unlockHandler = null;
      this.ready = Promise.resolve();
    }
    /* ------------------------------------------------------------------ prefs */
    loadMutedPreference() {
      try {
        return localStorage.getItem(MUTE_STORAGE_KEY) === "1";
      } catch (error) {
        return false;
      }
    }
    persistMutedPreference() {
      try {
        localStorage.setItem(MUTE_STORAGE_KEY, this.muted ? "1" : "0");
      } catch (error) {
      }
    }
    /* -------------------------------------------------------------- lifecycle */
    async init() {
      if (this.initialized || !this.enabled) {
        return this.ready;
      }
      this.initialized = true;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        try {
          this.audioContext = new Ctx();
          this.masterGain = this.audioContext.createGain();
          this.masterGain.gain.value = this.muted ? 0 : 1;
          this.masterGain.connect(this.audioContext.destination);
          this.musicGain = this.audioContext.createGain();
          this.musicGain.gain.value = VOLUMES.bgMusic;
          this.musicGain.connect(this.masterGain);
          this.sfxGain = this.audioContext.createGain();
          this.sfxGain.gain.value = 1;
          this.sfxGain.connect(this.masterGain);
        } catch (error) {
          this.audioContext = null;
        }
      }
      this.setupUnlock();
      this.ready = Promise.all(
        Object.entries(MANIFEST).map(([name, src]) => this.preload(name, src))
      ).then(() => void 0);
      await this.ready;
      return this.ready;
    }
    async preload(name, src) {
      try {
        const el = new Audio();
        el.preload = "auto";
        el.src = src;
        if (LOOPING.has(name)) el.loop = true;
        if (typeof VOLUMES[name] === "number") el.volume = VOLUMES[name];
        el.load();
        this.elements[name] = el;
        if (name === "bgMusic") this.musicElement = el;
        if (name === "timerWarning") this.timerElement = el;
      } catch (error) {
      }
      if (!this.audioContext) return;
      try {
        const response = await fetch(src, { cache: "force-cache" });
        const arrayBuffer = await response.arrayBuffer();
        this.buffers[name] = await this.decodeAudio(arrayBuffer);
      } catch (error) {
      }
    }
    // Promise + legacy-callback compatible decode (older Safari uses callbacks).
    decodeAudio(arrayBuffer) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const ok = (buf) => {
          if (!settled) {
            settled = true;
            resolve(buf);
          }
        };
        const fail = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        try {
          const maybePromise = this.audioContext.decodeAudioData(arrayBuffer, ok, fail);
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(ok, fail);
          }
        } catch (error) {
          fail(error);
        }
      });
    }
    /* ------------------------------------------------------------------ unlock */
    // Keep trying to unlock on ANY gesture until the context is actually
    // running, then prime the <audio> fallbacks and detach.
    setupUnlock() {
      if (this._unlockHandler) return;
      this._unlockHandler = () => {
        this.resume();
        if (this.audioContext && this.audioContext.state === "running") {
          this.finishUnlock();
        } else if (!this.audioContext) {
          this.finishUnlock();
        }
      };
      UNLOCK_EVENTS.forEach((evt) => window.addEventListener(evt, this._unlockHandler, { passive: true }));
      if (this.audioContext) {
        this.audioContext.addEventListener("statechange", () => {
          if (this.audioContext.state === "running") this.finishUnlock();
        });
      }
    }
    finishUnlock() {
      if (this.unlocked) return;
      this.unlocked = true;
      Object.entries(this.elements).forEach(([name, el]) => {
        if (name === "bgMusic" || name === "timerWarning") return;
        try {
          const prevMuted = el.muted;
          el.muted = true;
          const p = el.play();
          const restore = () => {
            try {
              el.pause();
              el.currentTime = 0;
              el.muted = prevMuted;
            } catch (e) {
            }
          };
          if (p && typeof p.then === "function") p.then(restore, () => {
            el.muted = prevMuted;
          });
          else restore();
        } catch (error) {
        }
      });
      this.startMusic();
      UNLOCK_EVENTS.forEach((evt) => window.removeEventListener(evt, this._unlockHandler, { passive: true }));
      this._unlockHandler = null;
    }
    resume() {
      if (this.audioContext && this.audioContext.state !== "running") {
        return this.audioContext.resume().catch(() => {
        });
      }
      return Promise.resolve();
    }
    // Back-compat: callers still invoke this before playing.
    ensureContextReady() {
      return this.resume();
    }
    /* -------------------------------------------------------------------- mute */
    setMuted(muted) {
      this.muted = Boolean(muted);
      this.persistMutedPreference();
      if (this.masterGain) {
        this.masterGain.gain.value = this.muted ? 0 : 1;
      }
      Object.values(this.elements).forEach((el) => {
        try {
          el.muted = this.muted;
        } catch (error) {
        }
      });
      if (!this.audioContext) {
        if (this.muted) {
          this.stopMusic();
          this.stopTimerWarning();
        } else if (this.musicWanted) {
          this.startMusic();
        }
      } else if (!this.muted && this.musicWanted && !this.musicSource) {
        this.startMusic();
      }
      return this.muted;
    }
    toggleMuted() {
      return this.setMuted(!this.muted);
    }
    isMuted() {
      return this.muted;
    }
    /* -------------------------------------------------------------- one-shots */
    play(name) {
      if (!this.enabled) return;
      if (this.muted) return;
      if (this.audioContext && this.buffers[name]) {
        this.resume();
        try {
          const source = this.audioContext.createBufferSource();
          source.buffer = this.buffers[name];
          const gain = this.audioContext.createGain();
          gain.gain.value = typeof VOLUMES[name] === "number" ? VOLUMES[name] : 0.9;
          source.connect(gain);
          gain.connect(this.sfxGain);
          source.start(0);
          return;
        } catch (error) {
        }
      }
      const el = this.elements[name];
      if (!el) return;
      try {
        const node = el.cloneNode(true);
        node.volume = typeof VOLUMES[name] === "number" ? VOLUMES[name] : 0.9;
        node.muted = this.muted;
        const p = node.play();
        if (p && p.catch) p.catch(() => {
        });
      } catch (error) {
      }
    }
    /* ------------------------------------------------------------------ music */
    startMusic() {
      this.musicWanted = true;
      if (this.muted && !this.audioContext) return;
      if (this.audioContext && this.buffers.bgMusic) {
        if (this.musicSource) return;
        if (this.musicElement && !this.musicElement.paused) {
          try {
            this.musicElement.pause();
            this.musicElement.currentTime = 0;
          } catch (error) {
          }
        }
        this.resume();
        try {
          const source = this.audioContext.createBufferSource();
          source.buffer = this.buffers.bgMusic;
          source.loop = true;
          source.connect(this.musicGain);
          source.start(0);
          source.onended = () => {
            if (this.musicSource === source) this.musicSource = null;
          };
          this.musicSource = source;
          return;
        } catch (error) {
        }
      }
      if (this.musicSource) return;
      const el = this.musicElement;
      if (el) {
        el.loop = true;
        el.muted = this.muted;
        if (!el.paused) return;
        const p = el.play();
        if (p && p.catch) p.catch(() => {
        });
      }
    }
    stopMusic() {
      if (this.musicSource) {
        try {
          this.musicSource.stop(0);
        } catch (e) {
        }
        try {
          this.musicSource.disconnect();
        } catch (e) {
        }
        this.musicSource = null;
      }
      if (this.musicElement) {
        try {
          this.musicElement.pause();
        } catch (e) {
        }
      }
    }
    stopMusicForGameEnd() {
      this.musicWanted = false;
      this.stopMusic();
    }
    /* ---------------------------------------------------------- timer warning */
    startTimerWarning() {
      if (this.muted || this.timerWarningActive) return;
      this.timerWarningActive = true;
      if (this.audioContext && this.buffers.timerWarning) {
        this.resume();
        try {
          const source = this.audioContext.createBufferSource();
          source.buffer = this.buffers.timerWarning;
          source.loop = true;
          const gain = this.audioContext.createGain();
          gain.gain.value = VOLUMES.timerWarning;
          source.connect(gain);
          gain.connect(this.sfxGain);
          source.start(0);
          this.timerSource = source;
          return;
        } catch (error) {
        }
      }
      const el = this.timerElement;
      if (el) {
        el.loop = true;
        el.muted = this.muted;
        el.currentTime = 0;
        const p = el.play();
        if (p && p.catch) p.catch(() => {
        });
      }
    }
    stopTimerWarning() {
      if (this.timerSource) {
        try {
          this.timerSource.stop(0);
        } catch (e) {
        }
        try {
          this.timerSource.disconnect();
        } catch (e) {
        }
        this.timerSource = null;
      }
      if (this.timerElement) {
        try {
          this.timerElement.pause();
          this.timerElement.currentTime = 0;
        } catch (e) {
        }
      }
      this.timerWarningActive = false;
    }
    /* -------------------------------------------------------------- ui click */
    // Use a real preloaded click asset instead of relying on an oscillator being
    // created at exactly the moment a WebView finishes resuming AudioContext.
    // play() already handles both WebAudio buffers and HTMLAudio fallback.
    playClick() {
      this.play("uiClick");
    }
  };
  var audioManager = new AudioManager();
  var audioManager_default = audioManager;

  // public/js/uiManager.js
  var UIManager = class {
    constructor() {
      this.boardEl = document.getElementById("game-board");
      this.boardWrapper = document.getElementById("board-wrapper");
      this.cells = Array.from(this.boardEl.querySelectorAll(".board-cell"));
      this.playerCards = {
        X: document.getElementById("player-x"),
        O: document.getElementById("player-o")
      };
      this.playerNames = {
        X: document.getElementById("player-x-name"),
        O: document.getElementById("player-o-name")
      };
      this.playerStakes = {
        X: document.getElementById("player-x-stake"),
        O: document.getElementById("player-o-stake")
      };
      this.turnTextEl = document.getElementById("turn-text");
      this.timerEl = document.getElementById("turn-timer");
      this.statusIndicator = document.getElementById("status-indicator");
      this.statusText = document.getElementById("status-text");
      this.overlay = document.getElementById("overlay");
      this.overlayTitle = document.getElementById("overlay-title");
      this.overlayMessage = document.getElementById("overlay-message");
      this.overlayAction = document.getElementById("overlay-action");
      this.overlaySpinner = document.getElementById("overlay-spinner");
      this.resultModal = document.getElementById("result-modal");
      this.resultTitle = document.getElementById("result-title");
      this.resultSummary = document.getElementById("result-summary");
      this.endLeaderboard = document.getElementById("end-leaderboard");
      this.muteBtn = document.getElementById("mute-btn");
      this.muteIcon = document.getElementById("mute-icon");
      this.toastEl = null;
      this.lastMoveSoundAt = 0;
    }
    // Wire the master mute toggle and reflect the persisted preference.
    setupMuteButton() {
      if (!this.muteBtn) return;
      this.renderMuteState(audioManager_default.isMuted());
      this.muteBtn.addEventListener("click", () => {
        const muted = audioManager_default.toggleMuted();
        this.renderMuteState(muted);
        if (!muted) {
          audioManager_default.ensureContextReady().catch(() => {
          });
          audioManager_default.startMusic();
          audioManager_default.playClick();
        }
      });
    }
    renderMuteState(muted) {
      if (!this.muteBtn) return;
      this.muteBtn.classList.toggle("muted", muted);
      this.muteBtn.setAttribute("aria-pressed", String(muted));
      this.muteBtn.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
      if (this.muteIcon) {
        this.muteIcon.src = muted ? "assets/icons/speaker_off.svg" : "assets/icons/speaker_on.svg";
      }
    }
    playClick() {
      audioManager_default.playClick();
    }
    startMusic() {
      audioManager_default.startMusic();
    }
    bindBoardHandlers(handler) {
      this.cells.forEach((cell) => {
        cell.addEventListener("click", () => {
          handler(Number(cell.dataset.index));
        });
      });
    }
    setBoardVisible(visible) {
      if (!this.boardWrapper) return;
      this.boardWrapper.classList.toggle("hidden", !visible);
      this.boardWrapper.setAttribute("aria-hidden", String(!visible));
    }
    setBoardState(board) {
      board.forEach((value, index) => {
        const cell = this.cells[index];
        if (!cell) return;
        if (!value) {
          cell.textContent = "";
          cell.dataset.symbol = "";
          cell.classList.remove("winning");
          return;
        }
        cell.textContent = value;
        cell.dataset.symbol = value;
      });
    }
    setSelectedSymbol(index) {
      this.cells.forEach((cell, i) => {
        cell.classList.toggle("selected", i === index);
      });
    }
    markWinningCells(cells = []) {
      this.cells.forEach((cell, index) => {
        if (cells.includes(index)) {
          cell.classList.add("winning");
        } else {
          cell.classList.remove("winning");
        }
      });
    }
    formatPlayerName(name) {
      if (name === null || name === void 0) {
        return "Waiting...";
      }
      const text = String(name).trim();
      if (!text) {
        return "Waiting...";
      }
      if (text.length <= 12) {
        return text;
      }
      return "".concat(text.slice(0, 10), "..");
    }
    updatePlayers(players = {}) {
      ["X", "O"].forEach((symbol) => {
        const card = this.playerCards[symbol];
        const info = players[symbol] || {};
        this.playerNames[symbol].textContent = this.formatPlayerName(info.name);
        this.playerStakes[symbol].textContent = info.stake ? "".concat(info.stake, " credits") : "";
        card.classList.toggle("disconnected", info.connected === false);
      });
    }
    setCurrentTurn(symbol, options = {}) {
      this.turnTextEl.textContent = symbol ? "".concat(symbol, " turn") : options.message || "Waiting for players...";
      this.playerCards.X.classList.toggle("active", symbol === "X");
      this.playerCards.O.classList.toggle("active", symbol === "O");
    }
    updateTimer(label, state = "normal") {
      this.timerEl.textContent = label;
      this.timerEl.classList.remove("warning", "danger");
      if (state === "warning") {
        this.timerEl.classList.add("warning");
      }
      if (state === "danger") {
        this.timerEl.classList.add("danger");
      }
    }
    setConnectionStatus(status, message) {
      this.statusIndicator.classList.remove("connected", "connecting", "disconnected");
      this.statusIndicator.classList.add(status);
      if (message) {
        this.statusText.textContent = message;
      }
    }
    showOverlay({ title, message, actionLabel, actionHandler, showSpinner = true }) {
      this.overlay.classList.remove("banner", "results");
      this.overlay.classList.remove("hidden");
      this.overlayTitle.textContent = title;
      this.overlayMessage.textContent = message;
      this.overlaySpinner.classList.toggle("hidden", !showSpinner);
      this.clearEndLeaderboard();
      if (actionLabel && actionHandler) {
        this.overlayAction.textContent = actionLabel;
        this.overlayAction.onclick = actionHandler;
        this.overlayAction.classList.remove("hidden");
      } else {
        this.overlayAction.classList.add("hidden");
        this.overlayAction.onclick = null;
      }
    }
    hideOverlay() {
      this.overlay.classList.add("hidden");
      this.overlay.classList.remove("banner");
    }
    clearEndLeaderboard() {
      if (!this.endLeaderboard) return;
      this.endLeaderboard.innerHTML = "";
      this.endLeaderboard.classList.add("hidden");
    }
    renderEndLeaderboard(rows = []) {
      if (!this.endLeaderboard) return;
      this.endLeaderboard.innerHTML = "";
      rows.forEach((row) => {
        const item = document.createElement("div");
        const statusClass = row.status === "WINNER" ? "winner" : row.status === "LOSER" ? "loser" : "draw";
        item.className = "leaderboard-row ".concat(statusClass);
        const rank = document.createElement("span");
        rank.className = "leaderboard-rank";
        rank.textContent = "#".concat(row.rank);
        const identity = document.createElement("div");
        identity.className = "leaderboard-identity";
        const name = document.createElement("strong");
        name.textContent = row.name || "Player";
        const symbol = document.createElement("span");
        symbol.textContent = row.symbol ? "Symbol ".concat(row.symbol) : "";
        identity.append(name, symbol);
        const status = document.createElement("span");
        status.className = "leaderboard-status";
        status.textContent = row.status || "";
        item.append(rank, identity, status);
        this.endLeaderboard.appendChild(item);
      });
      this.endLeaderboard.classList.toggle("hidden", rows.length === 0);
    }
    showGameEndedBanner({ outcome, winnerName, loserName } = {}) {
      this.showOverlay({
        title: "Game Ended",
        message: outcome === "win" ? "Winner: ".concat(winnerName || "Player", " \xB7 Loser: ").concat(loserName || "Player") : "Draw \xB7 Both players finished level",
        showSpinner: false
      });
      this.overlay.classList.add("banner");
    }
    showResult({ title, summary }) {
      this.resultTitle.textContent = title;
      this.resultSummary.textContent = summary;
      this.resultModal.classList.remove("hidden");
    }
    hideResult() {
      this.resultModal.classList.add("hidden");
    }
    toast(message, duration = 2500) {
      if (!this.toastEl) {
        this.toastEl = document.createElement("div");
        this.toastEl.className = "toast";
        document.body.appendChild(this.toastEl);
      }
      this.toastEl.textContent = message;
      this.toastEl.classList.add("show");
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toastEl.classList.remove("show");
      }, duration);
    }
    onMovePlaced(symbol) {
      var _a, _b;
      (_b = (_a = audioManager_default.ensureContextReady()) == null ? void 0 : _a.catch) == null ? void 0 : _b.call(_a, () => {
      });
      const now = Date.now();
      if (now - this.lastMoveSoundAt < 150) {
        return;
      }
      this.lastMoveSoundAt = now;
      audioManager_default.play(symbol === "X" ? "xPlace" : "oPlace");
    }
    onGameEnded({ outcome, isLocalWinner }) {
      var _a, _b;
      (_b = (_a = audioManager_default.ensureContextReady()) == null ? void 0 : _a.catch) == null ? void 0 : _b.call(_a, () => {
      });
      audioManager_default.stopMusicForGameEnd();
      if (outcome !== "win") return;
      audioManager_default.play(isLocalWinner ? "gameWon" : "gameLost");
    }
    toggleAudio(muted) {
      audioManager_default.setMuted(muted);
    }
    stopTimerWarning() {
      audioManager_default.stopTimerWarning();
    }
    startTimerWarning() {
      audioManager_default.startTimerWarning();
    }
    // End screen helpers (overlay-driven)
    showEndScreen({ outcome, rows = [] } = {}) {
      this.showOverlay({
        title: "Match Results",
        message: outcome === "draw" ? "Final leaderboard \xB7 Draw" : "Final leaderboard",
        showSpinner: false
      });
      this.overlay.classList.add("results");
      this.renderEndLeaderboard(rows);
    }
    updateEndScreenTimer(seconds) {
      if (Number.isFinite(seconds)) {
        this.overlayMessage.textContent = "Final leaderboard \xB7 ".concat(seconds, "s");
      }
    }
    updateEndScreenMessage(message) {
      this.overlayMessage.textContent = message;
    }
  };
  var uiManager_default = UIManager;

  // public/js/connectionManager.js
  var ConnectionManager = class {
    constructor({ onStatusChange, onReconnectNeeded }) {
      this.onStatusChange = onStatusChange;
      this.onReconnectNeeded = onReconnectNeeded;
      this.status = "connecting";
      this.reconnectDelay = 1e3;
      this.retryTimer = null;
    }
    setStatus(status, meta = {}) {
      this.status = status;
      if (typeof this.onStatusChange === "function") {
        this.onStatusChange(status, meta);
      }
    }
    scheduleReconnect(callback) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (typeof callback === "function") {
          callback();
        }
        if (typeof this.onReconnectNeeded === "function") {
          this.onReconnectNeeded();
        }
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 1e4);
    }
    resetBackoff() {
      this.reconnectDelay = 1e3;
      clearTimeout(this.retryTimer);
    }
  };
  var connectionManager_default = ConnectionManager;

  // public/js/socketManager.js
  var SocketManager = class {
    constructor({ url, authToken, connectionCallbacks = {} }) {
      this.url = url;
      this.authToken = authToken;
      this.socket = null;
      this.registeredHandlers = /* @__PURE__ */ new Map();
      this.connectionManager = new connectionManager_default(connectionCallbacks);
      this.clockOffsetMs = 0;
      this.reliableActions = /* @__PURE__ */ new Map();
      this.hasConnected = false;
    }
    async connect() {
      var _a;
      if ((_a = this.socket) == null ? void 0 : _a.connected) {
        return this.socket;
      }
      await this._waitForSocketIo();
      this.connectionManager.setStatus("connecting");
      return new Promise((resolve, reject) => {
        if (this.socket) {
          this.socket.once("connect", () => resolve(this.socket));
          this.socket.connect();
          return;
        }
        this.socket = window.io(this.url, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          upgrade: true,
          reconnection: true,
          reconnectionDelay: 1e3,
          reconnectionDelayMax: 5e3,
          reconnectionAttempts: 5,
          withCredentials: false,
          auth: this.authToken ? { token: this.authToken } : void 0
        });
        this._setupCoreListeners();
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Connection timeout"));
        }, 8e3);
        const onConnect = () => {
          this.connectionManager.resetBackoff();
          this.connectionManager.setStatus("connected");
          cleanup();
          resolve(this.socket);
        };
        const onError = (error) => {
          this.connectionManager.setStatus("error", { error });
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.socket.off("connect", onConnect);
          this.socket.off("connect_error", onError);
          this.socket.off("error", onError);
        };
        this.socket.on("connect_error", onError);
        this.socket.on("error", onError);
        this.socket.once("connect", onConnect);
      });
    }
    // Polls to check if the main socket.io script has loaded.
    async _waitForSocketIo(maxWaitMs = 1e4) {
      return new Promise((resolve, reject) => {
        if (typeof window.io === "function") {
          return resolve();
        }
        const interval = 100;
        let elapsedTime = 0;
        const handle = setInterval(() => {
          if (typeof window.io === "function") {
            clearInterval(handle);
            return resolve();
          }
          elapsedTime += interval;
          if (elapsedTime >= maxWaitMs) {
            clearInterval(handle);
            reject(new Error("Socket.IO client library not loaded."));
          }
        }, interval);
      });
    }
    _setupCoreListeners() {
      if (!this.socket) return;
      this.socket.on("connect", () => {
        const isReconnect = this.hasConnected;
        this.hasConnected = true;
        this.connectionManager.setStatus("connected");
        this.syncClock();
        if (isReconnect && typeof this.connectionManager.onReconnectNeeded === "function") {
          this.connectionManager.onReconnectNeeded();
        }
      });
      this.socket.on("disconnect", (reason) => {
        this.connectionManager.setStatus("disconnected", { reason });
      });
      this.socket.io.on("reconnect_attempt", (attempt) => {
        this.connectionManager.setStatus("reconnecting", { attempt });
      });
      this.socket.io.on("reconnect_failed", () => {
        this.connectionManager.setStatus("error", { error: "reconnect_failed" });
      });
      this.socket.on("connect_error", (error) => {
        this.connectionManager.setStatus("error", { error });
      });
    }
    // Measures the offset between this device's clock and the server's clock
    // by round-tripping a 'time-sync' event a few times and keeping the
    // sample with the lowest RTT (least jitter). The result is applied via
    // now() so countdowns rendered against server timestamps aren't thrown
    // off by a wrong/unsynced device clock.
    syncClock(samples = 3) {
      if (!this.socket) return;
      let bestRtt = Infinity;
      let completed = 0;
      const runSample = () => {
        const sentAt = Date.now();
        this.socket.emit("time-sync", sentAt, (serverTime) => {
          const receivedAt = Date.now();
          const rtt = receivedAt - sentAt;
          if (rtt < bestRtt) {
            bestRtt = rtt;
            this.clockOffsetMs = serverTime + rtt / 2 - receivedAt;
          }
          completed += 1;
          if (completed < samples) runSample();
        });
      };
      runSample();
    }
    // Current time corrected by the measured server clock offset. Use this
    // instead of raw Date.now() whenever comparing against a server-issued
    // absolute timestamp (e.g. turn expiry).
    now() {
      return Date.now() + this.clockOffsetMs;
    }
    on(event, handler) {
      var _a;
      if (!this.socket) throw new Error("Socket not initialized yet");
      this.socket.on(event, handler);
      this.registeredHandlers.set(event, ((_a = this.registeredHandlers.get(event)) == null ? void 0 : _a.add(handler)) || /* @__PURE__ */ new Set([handler]));
    }
    off(event, handler) {
      var _a;
      if (!this.socket) return;
      this.socket.off(event, handler);
      (_a = this.registeredHandlers.get(event)) == null ? void 0 : _a.delete(handler);
    }
    // Returns a Promise so callers can .catch() dispatch failures instead of
    // relying on a server-side ack: none of this server's handlers
    // (join/make-move/relocate-move) ever invoke the Socket.IO ack callback —
    // they report outcomes via separate broadcast events (move-applied /
    // move-error) instead. So this resolves once the event has been handed
    // off to the socket successfully, and rejects if that dispatch couldn't
    // happen at all (no socket, or socket.emit throwing synchronously). The
    // optional callback is still wired through as the ack listener in case a
    // future event does start acking.
    emit(event, payload = {}, callback = () => {
    }) {
      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject(new Error("Socket not connected yet"));
          return;
        }
        try {
          this.socket.emit(event, payload, callback);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }
    emitWithAck(event, payload = {}, timeoutMs = 5e3) {
      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject(new Error("Socket not connected yet"));
          return;
        }
        const timer = setTimeout(() => reject(new Error("".concat(event, " acknowledgement timeout"))), timeoutMs);
        try {
          this.socket.emit(event, payload, (response) => {
            clearTimeout(timer);
            if ((response == null ? void 0 : response.success) === false) {
              reject(new Error(response.message || "".concat(event, " was rejected")));
              return;
            }
            resolve(response || { success: true });
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    }
    makeMove(payload) {
      return this.emit("make-move", payload);
    }
    sendReliably(event, payload, { intervalMs = 3e3, maxAttempts = 8, onExhausted } = {}) {
      const key = "".concat(event, ":").concat((payload == null ? void 0 : payload.sessionId) || "", ":").concat((payload == null ? void 0 : payload.playerId) || "");
      this.stopReliable(key);
      let attempts = 0;
      const fire = () => {
        if (attempts >= maxAttempts) {
          const action2 = this.reliableActions.get(key);
          this.stopReliable(key);
          if (typeof onExhausted === "function") onExhausted((action2 == null ? void 0 : action2.attempts) || attempts);
          return;
        }
        attempts += 1;
        const action = this.reliableActions.get(key);
        if (action) action.attempts = attempts;
        this.emit(event, payload).catch(() => {
        });
      };
      const timer = setInterval(() => {
        if (this.reliableActions.has(key)) fire();
      }, intervalMs);
      this.reliableActions.set(key, { timer, attempts: 0 });
      fire();
      return { key, cancel: () => this.stopReliable(key) };
    }
    stopReliable(key) {
      const action = this.reliableActions.get(key);
      if (!action) return;
      clearInterval(action.timer);
      this.reliableActions.delete(key);
    }
    stopAllReliable() {
      for (const action of this.reliableActions.values()) {
        clearInterval(action.timer);
      }
      this.reliableActions.clear();
    }
    disconnect() {
      this.stopAllReliable();
      if (!this.socket) return;
      this.registeredHandlers.forEach((handlers, event) => {
        handlers.forEach((handler) => this.socket.off(event, handler));
      });
      this.socket.disconnect();
      this.socket = null;
      this.registeredHandlers.clear();
    }
  };
  var socketManager_default = SocketManager;

  // public/js/urlParser.js
  var parseQueryParams = () => {
    const params = new URLSearchParams(window.location.search);
    const explicitJoinUrl = params.get("joinUrl");
    const playerId = params.get("playerId");
    const playerName = params.get("playerName");
    const currentPathMatch = window.location.pathname.match(/\/session\/([^\/]+)\/join\/?$/);
    const joinUrl = explicitJoinUrl || (currentPathMatch ? "".concat(window.location.origin).concat(window.location.pathname) : null);
    let sessionId = null;
    if (joinUrl) {
      try {
        const path = new URL(joinUrl, window.location.origin).pathname;
        const match = path.match(/\/session\/([^\/]+)/);
        if (match && match[1]) {
          sessionId = match[1];
        }
      } catch (e) {
      }
    }
    const parsed = {
      joinUrl,
      sessionId,
      playerId,
      playerName,
      raw: params
    };
    return parsed;
  };

  // public/js/gameClient.js
  var STORAGE_KEY = "ttt.session";
  var REQUIRED_GAME_IMAGES = [
    "assets/images/grid_background_ready.png",
    "assets/images/x_symbol.png",
    "assets/images/o_symbol.png"
  ];
  var GameClient = class {
    constructor() {
      this.ui = new uiManager_default();
      this.params = parseQueryParams();
      this.localPlayer = {
        id: this.params.playerId,
        name: this.params.playerName
      };
      this.session = null;
      this.turnDurationSec = null;
      this.playerSymbol = null;
      this.gameState = "created";
      this.turnTick = null;
      this.endScreenTimer = null;
      this.postGameHoldTimer = null;
      this.moveLock = false;
      this.handlersAttached = false;
      this.placedSymbols = 0;
      this.selectedSymbolIndex = null;
      this.readyState = "not-ready";
      this.readyAction = null;
      this.readyMode = null;
      this.autoReadyFailed = false;
      this.joinConfirmed = false;
      this.requiredAssetsReady = false;
      this.requiredAssetsPromise = null;
      this.latestLobbyState = null;
      this.reconnectToken = null;
      let socketUrl;
      try {
        const origin = new URL(this.params.joinUrl).origin;
        socketUrl = origin.replace(/^http/, "ws");
      } catch (e) {
        socketUrl = null;
      }
      this.socketUrl = socketUrl;
      try {
        this.apiBase = this.params.joinUrl ? new URL(this.params.joinUrl).origin : "";
      } catch (e) {
        this.apiBase = "";
      }
      this.socketManager = new socketManager_default({
        url: this.socketUrl,
        connectionCallbacks: {
          onStatusChange: (status, meta) => this.handleConnectionStatus(status, meta),
          onReconnectNeeded: () => this.attemptRejoin()
        }
      });
    }
    async init() {
      audioManager_default.init().catch(() => void 0);
      this.bindUIEvents();
      if (!this.params.joinUrl || !this.params.sessionId || !this.localPlayer.id || !this.localPlayer.name) {
        this.ui.showOverlay({
          title: "Invalid Link",
          message: "This game link is incomplete. Please ensure you have a valid joinUrl, playerId, and playerName.",
          showSpinner: false
        });
        this.broadcastEvent("INVALID_SESSION", {
          sessionId: this.params.sessionId || null,
          reason: "invalid_link"
        });
        return;
      }
      this.ui.showOverlay({
        title: "Preparing Game",
        message: "Loading required gameplay assets...",
        showSpinner: true
      });
      this.ui.setBoardVisible(false);
      this.requiredAssetsPromise = this.prepareRequiredAssets().then(() => {
        this.requiredAssetsReady = true;
        this.maybeAutoReady();
      }).catch(() => {
      });
      try {
        await this.socketManager.connect();
        this.attachSocketHandlers();
        this.gameState = "waiting";
        this.ui.showOverlay({
          title: "Joining Game Session",
          message: "Waiting for the other player to join.",
          showSpinner: true
        });
        const cached = this.restoreSession();
        const cachedMatchesCurrentPlayer = cached && cached.sessionId === this.params.sessionId && cached.playerId === this.localPlayer.id;
        if (!cachedMatchesCurrentPlayer && cached) {
          this.clearPersistedSession();
          this.reconnectToken = null;
        }
        const joinPayload = {
          sessionId: this.params.sessionId,
          playerId: this.localPlayer.id,
          playerName: this.localPlayer.name,
          reconnectToken: cachedMatchesCurrentPlayer ? cached.reconnectToken || null : null
        };
        const joinResult = await this.socketManager.emitWithAck("join", joinPayload);
        if (joinResult && joinResult.reconnectToken) {
          this.reconnectToken = joinResult.reconnectToken;
        }
        this.joinConfirmed = true;
        this.persistSession();
        this.maybeAutoReady();
      } catch (error) {
        const reason = (error == null ? void 0 : error.message) || "Unknown error";
        this.ui.showOverlay({
          title: "Connection Failed",
          message: "Could not connect to the game server (".concat(reason, "). Please check the link and try again."),
          showSpinner: false
        });
        this.broadcastEvent("CONNECTION_FAILED", { reason, source: "init" });
      }
    }
    async prepareRequiredAssets() {
      await Promise.all(REQUIRED_GAME_IMAGES.map((src) => this.loadRequiredImage(src)));
    }
    async loadRequiredImage(src) {
      for (; ; ) {
        try {
          const image = new Image();
          image.decoding = "async";
          image.src = src;
          await new Promise((resolve, reject) => {
            if (image.complete) {
              if (image.naturalWidth > 0) resolve();
              else reject(new Error("Failed to load ".concat(src)));
              return;
            }
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", () => reject(new Error("Failed to load ".concat(src))), { once: true });
          });
          if (typeof image.decode === "function") {
            await image.decode();
          }
          return;
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
        }
      }
    }
    bindUIEvents() {
      this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));
      this.ui.setupMuteButton();
      document.getElementById("result-close-btn").addEventListener("click", () => this.ui.hideResult());
      document.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".board-cell, .control-btn, .mute-btn")) {
          this.ui.playClick();
        }
      });
      ["pointerdown", "click", "touchstart", "keydown"].forEach((evt) => {
        window.addEventListener(evt, () => {
          var _a, _b;
          (_b = (_a = audioManager_default.ensureContextReady()) == null ? void 0 : _a.catch) == null ? void 0 : _b.call(_a, () => {
          });
          this.ui.startMusic();
        }, { once: true });
      });
    }
    attachSocketHandlers() {
      if (this.handlersAttached) return;
      this.handlersAttached = true;
      this.socketManager.on("join-error", (payload) => this.handleJoinError(payload));
      this.socketManager.on("lobby-state", (payload) => this.handleLobbyState(payload));
      this.socketManager.on("waiting-for-player", () => this.handleWaitingForPlayer());
      this.socketManager.on("ready-confirmed", (payload) => this.handleReadyConfirmed(payload));
      this.socketManager.on("ready-error", (payload) => this.handleReadyError(payload));
      this.socketManager.on("session-ended", (payload) => this.handleSessionEnded(payload));
      this.socketManager.on("game-found", (payload) => this.handleGameFound(payload));
      this.socketManager.on("turn-started", (payload) => this.handleTurnStarted(payload));
      this.socketManager.on("move-applied", (payload) => this.handleMoveApplied(payload));
      this.socketManager.on("move-error", (payload) => this.handleMoveError(payload));
      this.socketManager.on("game-ended", (payload) => this.handleGameEnded(payload));
      this.socketManager.on("player-disconnected", (payload) => this.handlePlayerStatusUpdate(payload, "disconnected"));
      this.socketManager.on("player-reconnected", (payload) => this.handlePlayerStatusUpdate(payload, "reconnected"));
    }
    handleJoinError(payload) {
      this.joinConfirmed = false;
      if (this.readyAction) {
        this.readyAction.cancel();
        this.readyAction = null;
      }
      this.readyState = "not-ready";
      this.readyMode = null;
      this.latestLobbyState = null;
      this.ui.showOverlay({
        title: "Could Not Join",
        message: payload.message || "An unknown error occurred.",
        showSpinner: false
      });
      this.broadcastEvent("INVALID_SESSION", {
        sessionId: this.params.sessionId || null,
        reason: (payload == null ? void 0 : payload.message) || "join_error"
      });
    }
    handleWaitingForPlayer() {
      if (this.gameState === "ended" || this.gameState === "playing") return;
      this.ui.showOverlay({
        title: "Waiting for Opponent",
        message: "Waiting for the other player to join.",
        showSpinner: true
      });
    }
    handleLobbyState(state = {}) {
      if (this.gameState === "ended" || state.status === "active") return;
      this.gameState = "waiting";
      this.latestLobbyState = state;
      const players = Array.isArray(state.players) ? state.players : [];
      const me = players.find((player) => player.playerId === this.localPlayer.id);
      const opponent = players.find((player) => player.playerId !== this.localPlayer.id);
      if (!me) {
        this.ui.showOverlay({
          title: "Joining Game Session",
          message: "Confirming your player identity...",
          showSpinner: true
        });
        return;
      }
      if (me == null ? void 0 : me.ready) {
        this.readyState = "ready";
        if (this.readyAction) {
          this.readyAction.cancel();
          this.readyAction = null;
        }
      }
      if (players.length < 2 || !(opponent == null ? void 0 : opponent.connected)) {
        this.readyState = (me == null ? void 0 : me.ready) ? "ready" : "not-ready";
        this.ui.showOverlay({
          title: "Waiting for Opponent",
          message: players.length < 2 ? "Waiting for the other player to join." : "Your opponent disconnected. Waiting for them to reconnect.",
          showSpinner: true
        });
        return;
      }
      if (me.ready) {
        this.ui.showOverlay({
          title: "Ready, Waiting for Other Players",
          message: (opponent == null ? void 0 : opponent.ready) ? "Starting game..." : "Ready confirmed by the server. Waiting for the other player.",
          showSpinner: !(opponent == null ? void 0 : opponent.ready)
        });
        return;
      }
      this.readyState = "not-ready";
      if (!this.joinConfirmed || !this.requiredAssetsReady) {
        this.ui.showOverlay({
          title: "Preparing Game",
          message: this.requiredAssetsReady ? "Confirming your game session..." : "Loading required gameplay assets...",
          showSpinner: true
        });
        return;
      }
      this.maybeAutoReady(state);
    }
    maybeAutoReady(state = this.latestLobbyState) {
      if (this.gameState !== "waiting" || !this.joinConfirmed || !this.requiredAssetsReady || this.autoReadyFailed || this.readyState !== "not-ready" || !state || state.status !== "pending") {
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
      if (this.readyState === "ready" || this.readyState === "sending" || !this.params.sessionId || !this.joinConfirmed || !this.requiredAssetsReady) {
        return;
      }
      if (!automatic) this.autoReadyFailed = false;
      this.readyMode = automatic ? "auto" : "manual";
      this.readyState = "sending";
      this.ui.showOverlay({
        title: "Confirming Ready",
        message: "Sending your Ready status to the server...",
        showSpinner: true
      });
      this.readyAction = this.socketManager.sendReliably("player-ready", {
        sessionId: this.params.sessionId,
        playerId: this.localPlayer.id
      }, {
        intervalMs: 3e3,
        maxAttempts: 8,
        onExhausted: () => {
          if (this.readyState !== "sending") return;
          const automaticAttempt = this.readyMode === "auto";
          this.readyState = "not-ready";
          this.readyAction = null;
          this.readyMode = null;
          if (automaticAttempt) this.autoReadyFailed = true;
          this.ui.showOverlay({
            title: "Ready Not Confirmed",
            message: automaticAttempt ? "Automatic Ready could not be confirmed. Tap Ready to try again." : "The server did not confirm your Ready status. Please try again.",
            actionLabel: "Ready",
            actionHandler: () => this.handleReadyClick(),
            showSpinner: false
          });
        }
      });
    }
    handleReadyConfirmed({ playerId } = {}) {
      if (playerId !== this.localPlayer.id) return;
      this.readyState = "ready";
      this.readyMode = null;
      this.autoReadyFailed = false;
      if (this.readyAction) {
        this.readyAction.cancel();
        this.readyAction = null;
      }
      this.ui.showOverlay({
        title: "Ready, Waiting for Other Players",
        message: "Ready confirmed by the server. Waiting for the other player.",
        showSpinner: true
      });
    }
    handleReadyError(payload = {}) {
      const automaticAttempt = this.readyMode === "auto";
      this.readyState = "not-ready";
      this.readyMode = null;
      if (automaticAttempt) this.autoReadyFailed = true;
      if (this.readyAction) {
        this.readyAction.cancel();
        this.readyAction = null;
      }
      this.ui.showOverlay({
        title: "Ready Failed",
        message: automaticAttempt ? "Automatic Ready could not be confirmed. Tap Ready to try again." : payload.message || "Your Ready status could not be confirmed. Please try again.",
        actionLabel: "Ready",
        actionHandler: () => this.handleReadyClick(),
        showSpinner: false
      });
    }
    handleSessionEnded(payload = {}) {
      if (this.gameState === "ended") return;
      if (this.readyAction) {
        this.readyAction.cancel();
        this.readyAction = null;
      }
      this.handleGameEnded(payload);
    }
    handleGameFound(session) {
      if (session.status === "ended") {
        this.broadcastEvent("INVALID_SESSION", {
          sessionId: session.sessionId || this.params.sessionId || null,
          reason: "session_ended"
        });
        this.handleGameEnded({ sessionId: session.sessionId });
        return;
      }
      const normalizedPlayers = this.normalizePlayers(session.players);
      this.gameState = "playing";
      this.readyState = "ready";
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
        status: "active"
      };
      this.turnDurationSec = session.turnDurationSec || null;
      this.playerSymbol = this.resolvePlayerSymbol(this.session);
      this.placedSymbols = this.session.board.filter((s) => s === this.playerSymbol).length;
      this.persistSession();
      this.ui.markWinningCells([]);
      this.ui.updatePlayers(this.session.players);
      this.ui.setBoardVisible(true);
      this.ui.setBoardState(this.session.board);
      this.ui.hideOverlay();
      const turnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
      this.ui.setCurrentTurn(turnSymbol, { message: "Game starting!" });
      if (session.turnExpiresAt) {
        this.startTurnTimer(session.turnExpiresAt);
      } else {
        this.ui.updateTimer("--");
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
      this.placedSymbols = this.session.board.filter((s) => s === this.playerSymbol).length;
      this.selectedSymbolIndex = null;
      this.ui.setSelectedSymbol(null);
      const placedIndex = board.findIndex((cell, idx) => cell && cell !== previousBoard[idx]);
      if (placedIndex >= 0) {
        this.ui.onMovePlaced(board[placedIndex]);
      }
      this.ui.setBoardState(board);
      const symbol = this.getSymbolForPlayerId(currentTurnPlayerId);
      this.ui.setCurrentTurn(symbol, {});
      this.stopTurnTimer();
      this.ui.updateTimer("--");
    }
    handleGameEnded({ sessionId, reason, winState, winnerPlayerId, players = [] } = {}) {
      var _a;
      if (this.gameState === "ended") return;
      this.gameState = "ended";
      this.moveLock = true;
      this.stopTurnTimer();
      this.ui.stopTimerWarning();
      this.clearPersistedSession();
      this.ui.hideOverlay();
      clearTimeout(this.postGameHoldTimer);
      this.postGameHoldTimer = null;
      clearInterval(this.endScreenTimer);
      this.endScreenTimer = null;
      const outcome = reason === "win" || winState === "win" ? "win" : reason === "draw" || winState === "draw" ? "draw" : "none";
      const payloadPlayers = Array.isArray(players) && players.length ? this.normalizePlayers(players) : null;
      const finalPlayers = payloadPlayers || ((_a = this.session) == null ? void 0 : _a.players) || { X: {}, O: {} };
      const playerList = Object.values(finalPlayers).filter((player) => player && player.id);
      const winner = outcome === "win" ? playerList.find((player) => player.id === winnerPlayerId) || null : null;
      const loser = outcome === "win" ? playerList.find((player) => player.id !== winnerPlayerId) || null : null;
      const leaderboardRows = outcome === "win" ? [
        { rank: 1, name: (winner == null ? void 0 : winner.name) || "Winner", symbol: (winner == null ? void 0 : winner.symbol) || "", status: "WINNER" },
        { rank: 2, name: (loser == null ? void 0 : loser.name) || "Loser", symbol: (loser == null ? void 0 : loser.symbol) || "", status: "LOSER" }
      ] : outcome === "draw" ? playerList.map((player, index) => ({
        rank: index + 1,
        name: player.name || "Player",
        symbol: player.symbol || "",
        status: "DRAW"
      })) : [];
      if (outcome === "win" || outcome === "draw") {
        this.ui.onGameEnded({
          outcome,
          isLocalWinner: outcome === "win" && winnerPlayerId === this.localPlayer.id
        });
      }
      const gameplayResult = outcome === "win" || outcome === "draw";
      const holdMs = gameplayResult && this.session ? 7e3 : 0;
      if (holdMs > 0) {
        this.ui.setBoardVisible(true);
        this.ui.setCurrentTurn(null, { message: "Game Ended" });
        this.ui.updateTimer("--");
        this.ui.showGameEndedBanner({
          outcome,
          winnerName: (winner == null ? void 0 : winner.name) || null,
          loserName: (loser == null ? void 0 : loser.name) || null
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
        }, 1e3);
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
        player.connected = type === "reconnected";
        this.ui.updatePlayers(this.session.players);
        this.ui.toast("Player ".concat(player.name, " has ").concat(type, "."));
      }
    }
    handleConnectionStatus(status, meta = {}) {
      this.ui.setConnectionStatus(status, status.charAt(0).toUpperCase() + status.slice(1));
      if (this.gameState === "ended") {
        return;
      }
      if (status === "connected") {
        if (this.gameState === "playing") {
          this.ui.showOverlay({
            title: "Rejoining Session",
            message: "Restoring your game...",
            showSpinner: true
          });
          this.ui.setBoardVisible(false);
        } else {
          this.ui.showOverlay({
            title: "Joining Game Session",
            message: "Waiting for the other player to join.",
            showSpinner: true
          });
        }
      } else if (status === "disconnected" || status === "reconnecting") {
        this.joinConfirmed = false;
        if (this.gameState === "waiting") {
          if (this.readyAction) {
            this.readyAction.cancel();
            this.readyAction = null;
          }
          this.readyState = "not-ready";
          this.readyMode = null;
          this.autoReadyFailed = false;
          this.latestLobbyState = null;
        }
        this.ui.setBoardVisible(false);
        this.ui.showOverlay({
          title: "Connection Lost",
          message: "Attempting to restore connection...",
          showSpinner: true
        });
      } else if (status === "error" && (meta == null ? void 0 : meta.error) === "reconnect_failed") {
        this.ui.showOverlay({
          title: "Connection Failed",
          message: "Could not reconnect to the game server. Please try again.",
          showSpinner: false
        });
        this.broadcastEvent("CONNECTION_FAILED", {
          reason: "reconnect_failed",
          source: "rejoin"
        });
      }
    }
    async attemptRejoin() {
      this.joinConfirmed = false;
      const cached = this.restoreSession();
      if (!cached) {
        this.ui.showOverlay({
          title: "Cannot Rejoin",
          message: "No previous session data found. Please use a valid game link to join.",
          showSpinner: false
        });
        this.broadcastEvent("INVALID_SESSION", {
          sessionId: null,
          reason: "missing_session"
        });
        return;
      }
      this.ui.showOverlay({
        title: "Rejoining Session",
        message: "Attempting to reconnect to your previous game...",
        showSpinner: true
      });
      try {
        await this.socketManager.connect();
        const joinResult = await this.socketManager.emitWithAck("join", {
          sessionId: cached.sessionId,
          playerId: this.localPlayer.id,
          playerName: this.localPlayer.name,
          reconnectToken: cached.reconnectToken || this.reconnectToken || null
        });
        if (joinResult && joinResult.reconnectToken) {
          this.reconnectToken = joinResult.reconnectToken;
        }
        this.joinConfirmed = true;
        this.persistSession();
        this.maybeAutoReady();
      } catch (error) {
        const reason = (error == null ? void 0 : error.message) || "Connection failed";
        this.ui.showOverlay({
          title: "Connection Failed",
          message: "Could not reconnect to the game server (".concat(reason, "). Please check the link and try again."),
          showSpinner: false
        });
        this.broadcastEvent("CONNECTION_FAILED", { reason, source: "rejoin" });
        return;
      }
      const state = await this.fetchSessionState(cached.sessionId);
      if (state && state.status !== "ended") {
        if (state.status === "active") {
          this.handleGameFound(state);
        } else {
          this.handleLobbyState(state);
        }
        this.playerSymbol = this.resolvePlayerSymbol(state);
        this.persistSession();
        this.ui.toast("Successfully rejoined session.");
      } else {
        this.clearPersistedSession();
        this.ui.showOverlay({
          title: "Session Unavailable",
          message: "The previous session has ended or could not be found.",
          showSpinner: false
        });
        this.broadcastEvent("INVALID_SESSION", {
          sessionId: cached.sessionId || null,
          reason: "session_unavailable"
        });
      }
    }
    handleCellSelection(index) {
      var _a, _b;
      if (this.gameState !== "playing" || !this.session || this.moveLock) {
        return;
      }
      (_b = (_a = audioManager_default.ensureContextReady()) == null ? void 0 : _a.catch) == null ? void 0 : _b.call(_a, () => {
      });
      const currentTurnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
      if (this.playerSymbol !== currentTurnSymbol) {
        this.ui.toast("Not your turn.");
        return;
      }
      if (this.placedSymbols < 3) {
        if (this.session.board[index]) {
          this.ui.toast("Cell already taken.");
          return;
        }
        this.moveLock = true;
        const movePayload = {
          sessionId: this.session.sessionId,
          playerId: this.localPlayer.id,
          position: index
        };
        this.socketManager.emit("make-move", movePayload).catch((err) => {
          this.moveLock = false;
          this.ui.toast("Move submission failed.");
        });
      } else {
        if (this.selectedSymbolIndex === null) {
          if (this.session.board[index] !== this.playerSymbol) {
            this.ui.toast("Select one of your symbols to move.");
            return;
          }
          this.selectedSymbolIndex = index;
          this.ui.setSelectedSymbol(index);
          this.ui.toast("Select an empty cell to move to.");
        } else {
          if (this.session.board[index] !== null) {
            if (index === this.selectedSymbolIndex) {
              this.selectedSymbolIndex = null;
              this.ui.setSelectedSymbol(null);
              return;
            }
            this.ui.toast("Destination cell must be empty.");
            return;
          }
          this.moveLock = true;
          const relocatePayload = {
            sessionId: this.session.sessionId,
            playerId: this.localPlayer.id,
            from: this.selectedSymbolIndex,
            to: index
          };
          this.socketManager.emit("relocate-move", relocatePayload).catch((err) => {
            this.moveLock = false;
            this.ui.toast("Relocation failed.");
          });
        }
      }
    }
    handleMoveError(error = {}) {
      this.moveLock = false;
      const message = (error == null ? void 0 : error.message) || "Move was rejected.";
      this.ui.toast(message);
      if (this.selectedSymbolIndex !== null) {
        this.selectedSymbolIndex = null;
        this.ui.setSelectedSymbol(null);
      }
    }
    resolvePlayerSymbol(session) {
      var _a, _b;
      const players = Array.isArray(session.players) ? this.normalizePlayers(session.players) : session.players;
      if (((_a = players == null ? void 0 : players.X) == null ? void 0 : _a.id) === this.localPlayer.id) return "X";
      if (((_b = players == null ? void 0 : players.O) == null ? void 0 : _b.id) === this.localPlayer.id) return "O";
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
          ready: Boolean(player.ready)
        };
      });
      return normalized;
    }
    getSymbolForPlayerId(playerId) {
      var _a;
      if (!playerId || !((_a = this.session) == null ? void 0 : _a.players)) return null;
      const entry = Object.entries(this.session.players).find(([, p]) => p.id === playerId);
      return entry ? entry[0] : null;
    }
    startTurnTimer(turnExpiresAt) {
      this.stopTurnTimer();
      if (!turnExpiresAt) {
        this.ui.updateTimer("--");
        return;
      }
      const expiry = new Date(turnExpiresAt).getTime();
      const totalDurationSec = this.computeTurnDurationSec(expiry);
      const cautionThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.5));
      const warnThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.3));
      this.turnTick = setInterval(() => {
        const remaining = Math.max(0, expiry - this.socketManager.now());
        const seconds = Math.ceil(remaining / 1e3);
        const display = "".concat(Math.floor(seconds / 60), ":").concat(String(seconds % 60).padStart(2, "0"));
        let state = "normal";
        if (seconds <= warnThresholdSec) {
          state = "danger";
          this.ui.startTimerWarning();
        } else if (seconds <= cautionThresholdSec) {
          state = "warning";
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
      const guess = Math.ceil((expiryMs - this.socketManager.now()) / 1e3);
      return Math.max(guess, 1);
    }
    stopTurnTimer() {
      clearInterval(this.turnTick);
      this.turnTick = null;
    }
    persistSession() {
      var _a;
      const sessionId = ((_a = this.session) == null ? void 0 : _a.sessionId) || this.params.sessionId;
      if (!sessionId || !this.localPlayer.id) return;
      const data = JSON.stringify({
        sessionId,
        playerId: this.localPlayer.id,
        symbol: this.playerSymbol || null,
        reconnectToken: this.reconnectToken || null
      });
      try {
        sessionStorage.setItem(STORAGE_KEY, data);
      } catch (error) {
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
        const response = await fetch("".concat(this.apiBase, "/session/").concat(sessionId), {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" }
        });
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        return null;
      }
    }
    broadcastEvent(type, payload) {
      if (typeof window.broadcastEvent === "function") {
        window.broadcastEvent(type, payload);
      }
    }
  };
  var gameClient_default = GameClient;

  // public/js/viewportScaler.js
  var MARGIN = 8;
  function initViewportScaler(containerId = "game-container", stageId = "viewport-stage") {
    const container = document.getElementById(containerId);
    const stage = document.getElementById(stageId);
    if (!container) return () => {
    };
    let frame = null;
    const measure = () => {
      container.style.transform = "none";
      const designW = container.offsetWidth;
      const designH = container.offsetHeight;
      let vw = stage ? stage.clientWidth : 0;
      let vh = stage ? stage.clientHeight : 0;
      if (!vw || !vh) {
        vw = window.visualViewport && window.visualViewport.width || window.innerWidth;
        vh = window.visualViewport && window.visualViewport.height || window.innerHeight;
      }
      if (!designW || !designH) return;
      const scale = Math.min(
        (vw - MARGIN * 2) / designW,
        (vh - MARGIN * 2) / designH
      );
      const safe = Math.max(scale, 0.2);
      container.style.transform = "scale(".concat(safe, ")");
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", schedule);
      window.visualViewport.addEventListener("scroll", schedule);
    }
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(schedule);
      ro.observe(container);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(schedule).catch(() => {
      });
    }
    measure();
    return schedule;
  }

  // public/js/main.js
  window.__tttBooted = true;
  window.broadcastEvent = (type, payload = {}) => {
    if (!type) return;
    const message = { type, payload };
    try {
      const target = window.parent && window.parent !== window ? window.parent : window;
      target.postMessage(message, "*");
    } catch (error) {
      console.warn("[broadcastEvent] Failed to postMessage", error);
    }
  };
  window.addEventListener("load", () => {
    const refit = initViewportScaler("game-container");
    window.__refitGame = refit;
    setTimeout(() => {
      const client = new gameClient_default();
      client.init();
      refit();
    }, 100);
  });
})();
