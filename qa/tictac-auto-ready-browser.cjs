const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('../SimLab/node_modules/ws');
const { io } = require('../SimLab/node_modules/socket.io-client');

const PORT = 43210;
const WEBHOOK_PORT = 44210;
const CDP_PORT = 45210;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ttt-auto-ready-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const webhooks = [];

const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    webhooks.push({ type: req.headers['x-event-type'], body });
    res.statusCode = 204;
    res.end();
  });
});

async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

async function startSession(turnDurationSec = 30) {
  const response = await fetch(`${BASE}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnDurationSec }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`start failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function getState(sessionId) {
  const response = await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  if (!response.ok) return null;
  return response.json();
}

function connectSocket() {
  return io(BASE, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: false,
  });
}

async function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

async function joinRaw(socket, sessionId, playerId, playerName) {
  if (!socket.connected) await once(socket, 'connect');
  return new Promise((resolve) => socket.emit('join', { sessionId, playerId, playerName }, resolve));
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const pair = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) pair.reject(new Error(msg.error.message));
      else pair.resolve(msg.result || {});
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}

(async () => {
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(WEBHOOK_PORT, '127.0.0.1', resolve);
  });

  const env = {
    ...process.env,
    PORT: String(PORT),
    HMAC_SECRET: 'ttt-auto-ready-test-secret',
    WEBHOOK_ENDPOINTS: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
    MATCHMAKING_SERVICE_URL: '',
    DLQ_PASSWORD: TOKEN,
    MAX_WEBHOOK_ATTEMPTS: '2',
    RETRY_SCHEDULE_MS: '50',
    SESSION_LOG_TTL_MS: '60000',
    SESSION_MAX_LIFETIME_MS: '0',
    MAX_TURNS: '12',
  };

  const server = spawn(process.execPath, ['index.js'], {
    cwd: 'Server',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let opponent = null;
  let chrome = null;
  let pageWs = null;
  const profile = path.resolve('qa/.chrome-ttt-auto-ready');

  try {
    await waitFor(async () => {
      try { return (await fetch(BASE)).ok; } catch { return false; }
    }, 'game server');

    const created = await startSession();
    const sessionId = created.sessionId;
    opponent = connectSocket();
    const oppAck = await joinRaw(opponent, sessionId, 'opponent', 'Opponent');
    if (!oppAck?.success) throw new Error(`opponent join failed: ${JSON.stringify(oppAck)}`);

    fs.rmSync(profile, { recursive: true, force: true });
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=390,844',
      'about:blank',
    ], { stdio: 'ignore' });

    const target = await waitFor(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        return list.find((item) => item.type === 'page');
      } catch { return null; }
    }, 'Chrome target');

    pageWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      pageWs.once('open', resolve);
      pageWs.once('error', reject);
    });
    const send = cdp(pageWs);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    await send('Network.setBlockedURLs', { urls: ['*x_symbol.png*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const NativeWebSocket = window.WebSocket;
        window.__tttWsList = [];
        window.__tttReadySends = 0;
        window.__tttDroppedReady = 0;
        window.__tttDropFirstReady = true;
        function WrappedWebSocket(url, protocols) {
          const ws = protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
          window.__tttWsList.push(ws);
          const nativeSend = ws.send.bind(ws);
          ws.send = function(data) {
            if (typeof data === 'string' && data.indexOf('player-ready') !== -1) {
              window.__tttReadySends += 1;
              if (window.__tttDropFirstReady && window.__tttDroppedReady === 0) {
                window.__tttDroppedReady = 1;
                return;
              }
            }
            return nativeSend(data);
          };
          return ws;
        }
        WrappedWebSocket.prototype = NativeWebSocket.prototype;
        ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach((key) => {
          Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] });
        });
        window.WebSocket = WrappedWebSocket;
      })();`,
    });

    const joinUrl = new URL(created.joinUrl);
    joinUrl.searchParams.set('playerId', 'browser');
    joinUrl.searchParams.set('playerName', 'Browser Player');
    await send('Page.navigate', { url: joinUrl.toString() });

    await waitFor(async () => {
      const state = await getState(sessionId);
      const browserPlayer = state?.players?.find((p) => p.playerId === 'browser');
      return state?.status === 'pending' && browserPlayer?.connected ? state : null;
    }, 'browser authoritative join');

    await sleep(1400);
    let state = await getState(sessionId);
    let browserPlayer = state.players.find((p) => p.playerId === 'browser');
    const opponentPlayer = state.players.find((p) => p.playerId === 'opponent');
    if (browserPlayer.ready) throw new Error('browser became Ready while required image was blocked');
    if (!opponentPlayer.connected) throw new Error('opponent unexpectedly disconnected');

    let ui = await send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.getElementById('overlay-title')?.textContent || '',
        message: document.getElementById('overlay-message')?.textContent || '',
        actionHidden: document.getElementById('overlay-action')?.classList.contains('hidden')
      }))()`,
      returnByValue: true,
    });
    const preparing = ui.result?.value;
    if (preparing?.title !== 'Preparing Game') {
      throw new Error(`expected Preparing Game while asset blocked: ${JSON.stringify(preparing)}`);
    }
    const prepCap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const prepPath = path.resolve('qa/tictac-preparing-game.png');
    fs.writeFileSync(prepPath, Buffer.from(prepCap.data, 'base64'));
    console.log(`PASS_TTT_SLOW_ASSET_BLOCKS_READY ${JSON.stringify(preparing)}`);

    // Reconnect before Ready. The client must rejoin first; it must not send
    // Ready from stale local state while the mandatory image is still blocked.
    await send('Runtime.evaluate', {
      expression: `(() => {
        const open = (window.__tttWsList || []).filter((ws) => ws.readyState === 1);
        if (!open.length) return false;
        open[open.length - 1].close();
        return true;
      })()`,
      returnByValue: true,
    });

    await waitFor(async () => {
      const current = await getState(sessionId);
      const me = current?.players?.find((p) => p.playerId === 'browser');
      return current?.status === 'pending' && me?.connected && !me.ready ? current : null;
    }, 'reconnect before Ready', 12000);
    console.log('PASS_TTT_RECONNECT_BEFORE_READY connected=true ready=false');

    await send('Network.setBlockedURLs', { urls: [] });

    const readyUi = await waitFor(async () => {
      const result = await send('Runtime.evaluate', {
        expression: `(() => ({
          title: document.getElementById('overlay-title')?.textContent || '',
          message: document.getElementById('overlay-message')?.textContent || '',
          readySends: window.__tttReadySends || 0,
          dropped: window.__tttDroppedReady || 0
        }))()`,
        returnByValue: true,
      });
      const value = result.result?.value;
      return value?.title === 'Ready, Waiting for Other Players' ? value : null;
    }, 'automatic Ready after asset recovery', 18000);

    state = await getState(sessionId);
    browserPlayer = state.players.find((p) => p.playerId === 'browser');
    if (!browserPlayer.ready || state.status !== 'pending') {
      throw new Error(`authoritative auto Ready state wrong: ${JSON.stringify(state)}`);
    }
    if (readyUi.dropped !== 1 || readyUi.readySends < 2) {
      throw new Error(`lost Ready retry was not proven: ${JSON.stringify(readyUi)}`);
    }
    if (webhooks.filter((event) => event.type === 'session.started').length !== 0) {
      throw new Error('session.started emitted before opponent Ready');
    }
    console.log(`PASS_TTT_LOST_READY_RETRIED ${JSON.stringify(readyUi)}`);

    const readyCap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const readyPath = path.resolve('qa/tictac-auto-ready.png');
    fs.writeFileSync(readyPath, Buffer.from(readyCap.data, 'base64'));
    console.log(`PASS_TTT_BROWSER_AUTO_READY screenshot=${readyPath}`);

    const sendsBeforeReconnect = readyUi.readySends;
    await send('Runtime.evaluate', {
      expression: `(() => {
        const open = (window.__tttWsList || []).filter((ws) => ws.readyState === 1);
        if (!open.length) return false;
        open[open.length - 1].close();
        return true;
      })()`,
      returnByValue: true,
    });

    // Pending disconnect intentionally invalidates that player's Ready vote on
    // the server. The restored state is therefore not-Ready and the client must
    // automatically Ready again only after its reconnect join is acknowledged.
    const restored = await waitFor(async () => {
      const current = await getState(sessionId);
      const me = current?.players?.find((p) => p.playerId === 'browser');
      return current?.status === 'pending' && me?.connected && me.ready ? current : null;
    }, 'reconnect after Ready and authoritative re-Ready', 16000);

    const sendsAfterReconnect = await waitFor(async () => {
      const result = await send('Runtime.evaluate', {
        expression: 'window.__tttReadySends || 0',
        returnByValue: true,
      });
      const count = result.result?.value || 0;
      return count > sendsBeforeReconnect ? count : null;
    }, 'Ready resend after server reset');

    await sleep(3400);
    const stable = (await send('Runtime.evaluate', {
      expression: 'window.__tttReadySends || 0',
      returnByValue: true,
    })).result?.value;
    if (stable !== sendsAfterReconnect) {
      throw new Error(`Ready retries continued after server confirmation: ${sendsAfterReconnect} -> ${stable}`);
    }
    console.log(`PASS_TTT_RECONNECT_AFTER_READY serverReset=true readyRestored=true readySends=${stable}`);

    const finalMe = restored.players.find((p) => p.playerId === 'browser');
    const finalOpponent = restored.players.find((p) => p.playerId === 'opponent');
    console.log(`SERVER=status:${restored.status} browserReady=${finalMe.ready} opponentReady=${finalOpponent.ready}`);
    console.log(`SESSION_STARTED_BEFORE_OPPONENT=${webhooks.filter((event) => event.type === 'session.started').length}`);
    console.log(`SCREENSHOTS=${prepPath};${readyPath}`);

    opponent.disconnect();
    await fetch(`${BASE}/admin/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).catch(() => {});
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    try { opponent?.disconnect(); } catch {}
    try { pageWs?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    try { server.kill(); } catch {}
    receiver.close();
    await sleep(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();