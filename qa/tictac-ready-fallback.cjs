const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('../SimLab/node_modules/ws');
const { io } = require('../SimLab/node_modules/socket.io-client');

const PORT = 43211;
const WEBHOOK_PORT = 44211;
const CDP_PORT = 45211;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ttt-auto-ready-fallback-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const webhooks = [];

const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    webhooks.push({ type: req.headers['x-event-type'], raw: Buffer.concat(chunks).toString('utf8') });
    res.statusCode = 204;
    res.end();
  });
});

async function waitFor(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
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
      msg.error ? pair.reject(new Error(msg.error.message)) : pair.resolve(msg.result || {});
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}

async function getState(sessionId) {
  const response = await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  return response.ok ? response.json() : null;
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

(async () => {
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(WEBHOOK_PORT, '127.0.0.1', resolve);
  });

  const server = spawn(process.execPath, ['index.js'], {
    cwd: 'Server',
    env: {
      ...process.env,
      PORT: String(PORT),
      HMAC_SECRET: 'ttt-auto-ready-fallback-secret',
      WEBHOOK_ENDPOINTS: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
      MATCHMAKING_SERVICE_URL: '',
      DLQ_PASSWORD: TOKEN,
      MAX_WEBHOOK_ATTEMPTS: '2',
      RETRY_SCHEDULE_MS: '50',
      SESSION_LOG_TTL_MS: '60000',
      SESSION_MAX_LIFETIME_MS: '0',
      MAX_TURNS: '12',
    },
    stdio: 'ignore',
  });

  let opponent = null;
  let chrome = null;
  let pageWs = null;
  const profile = path.resolve('qa/.chrome-ttt-ready-fallback');

  try {
    await waitFor(async () => {
      try { return (await fetch(BASE)).ok; } catch { return false; }
    }, 'server');

    const startResponse = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnDurationSec: 30 }),
    });
    const created = await startResponse.json();
    if (!startResponse.ok) throw new Error(JSON.stringify(created));

    opponent = io(BASE, { path: '/socket.io', transports: ['websocket'], reconnection: false });
    if (!opponent.connected) await once(opponent, 'connect');
    const oppAck = await new Promise((resolve) => opponent.emit('join', {
      sessionId: created.sessionId,
      playerId: 'opponent',
      playerName: 'Opponent',
    }, resolve));
    if (!oppAck?.success) throw new Error(`opponent join failed: ${JSON.stringify(oppAck)}`);

    fs.rmSync(profile, { recursive: true, force: true });
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank',
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
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const NativeWebSocket = window.WebSocket;
        window.__tttReadySends = 0;
        window.__tttDropReady = true;
        function WrappedWebSocket(url, protocols) {
          const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
          const nativeSend = ws.send.bind(ws);
          ws.send = function(data) {
            if (typeof data === 'string' && data.indexOf('player-ready') !== -1) {
              window.__tttReadySends += 1;
              if (window.__tttDropReady) return;
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

    const fallback = await waitFor(async () => {
      const result = await send('Runtime.evaluate', {
        expression: `(() => ({
          title: document.getElementById('overlay-title')?.textContent || '',
          message: document.getElementById('overlay-message')?.textContent || '',
          action: document.getElementById('overlay-action')?.textContent || '',
          actionHidden: document.getElementById('overlay-action')?.classList.contains('hidden'),
          sends: window.__tttReadySends || 0
        }))()`,
        returnByValue: true,
      });
      const value = result.result?.value;
      return value?.title === 'Ready Not Confirmed' && value?.actionHidden === false ? value : null;
    }, 'bounded automatic Ready fallback', 32000);

    const state = await getState(created.sessionId);
    const browserPlayer = state.players.find((p) => p.playerId === 'browser');
    if (browserPlayer.ready) throw new Error('browser became Ready even though every Ready packet was dropped');
    if (fallback.sends !== 8) throw new Error(`expected exactly 8 bounded attempts, got ${fallback.sends}`);
    if (webhooks.filter((event) => event.type === 'session.started').length !== 0) {
      throw new Error('session.started emitted during failed auto Ready');
    }

    const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shot = path.resolve('qa/tictac-ready-fallback.png');
    fs.writeFileSync(shot, Buffer.from(cap.data, 'base64'));
    console.log(`PASS_TTT_MANUAL_FALLBACK ${JSON.stringify(fallback)} screenshot=${shot}`);

    await send('Runtime.evaluate', {
      expression: `window.__tttDropReady = false; document.getElementById('overlay-action').click(); true`,
      returnByValue: true,
    });

    await waitFor(async () => {
      const current = await getState(created.sessionId);
      const me = current?.players?.find((p) => p.playerId === 'browser');
      return me?.ready ? current : null;
    }, 'manual fallback Ready confirmation', 8000);

    const recovered = await waitFor(async () => {
      const result = await send('Runtime.evaluate', {
        expression: `document.getElementById('overlay-title')?.textContent || ''`,
        returnByValue: true,
      });
      return result.result?.value === 'Ready, Waiting for Other Players' ? result.result.value : null;
    }, 'Ready UI after manual fallback');

    console.log(`PASS_TTT_MANUAL_FALLBACK_RECOVERS title=${recovered}`);
    console.log(`SESSION_STARTED_BEFORE_OPPONENT=${webhooks.filter((event) => event.type === 'session.started').length}`);

    await fetch(`${BASE}/admin/sessions/${encodeURIComponent(created.sessionId)}/end`, {
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