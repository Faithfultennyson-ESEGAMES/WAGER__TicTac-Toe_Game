const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../SimLab/node_modules/ws');

const PORT = 43213;
const CDP_PORT = 45213;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ttt-missing-opponent-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
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

(async () => {
  const server = spawn(process.execPath, ['index.js'], {
    cwd: 'Server',
    env: {
      ...process.env,
      PORT: String(PORT),
      HMAC_SECRET: 'ttt-missing-opponent-secret',
      WEBHOOK_ENDPOINTS: 'http://127.0.0.1:9/unused',
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

  let chrome = null;
  let pageWs = null;
  const profile = path.resolve('qa/.chrome-ttt-missing-opponent');

  try {
    await waitFor(async () => {
      try { return (await fetch(BASE)).ok; } catch { return false; }
    }, 'server');

    const response = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnDurationSec: 30 }),
    });
    const created = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(created));

    fs.rmSync(profile, { recursive: true, force: true });
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--window-size=390,844', 'about:blank',
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
        function WrappedWebSocket(url, protocols) {
          const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
          const nativeSend = ws.send.bind(ws);
          ws.send = function(data) {
            if (typeof data === 'string' && data.indexOf('player-ready') !== -1) {
              window.__tttReadySends += 1;
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
    joinUrl.searchParams.set('playerId', 'solo');
    joinUrl.searchParams.set('playerName', 'Solo Player');
    await send('Page.navigate', { url: joinUrl.toString() });

    await waitFor(async () => {
      const result = await send('Runtime.evaluate', {
        expression: `document.getElementById('overlay-title')?.textContent || ''`,
        returnByValue: true,
      });
      return result.result?.value === 'Waiting for Opponent';
    }, 'Waiting for Opponent UI');

    await sleep(4200);
    const stateResponse = await fetch(`${BASE}/session/${created.sessionId}`, { cache: 'no-store' });
    const state = await stateResponse.json();
    const me = state.players.find((p) => p.playerId === 'solo');
    const readySends = (await send('Runtime.evaluate', {
      expression: 'window.__tttReadySends || 0',
      returnByValue: true,
    })).result?.value;

    if (state.status !== 'pending' || !me?.connected || me.ready || readySends !== 0) {
      throw new Error(`absent-opponent behavior wrong: ${JSON.stringify({ state, readySends })}`);
    }
    console.log(`PASS_TTT_MISSING_OPPONENT_NO_AUTO_READY status=${state.status} connected=${me.connected} ready=${me.ready} readySends=${readySends}`);

    await fetch(`${BASE}/admin/sessions/${encodeURIComponent(created.sessionId)}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    try { pageWs?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    try { server.kill(); } catch {}
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();