const http = require('http');
const { spawn } = require('child_process');
const { io } = require('../SimLab/node_modules/socket.io-client');

const PORT = 43212;
const WEBHOOK_PORT = 44212;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ttt-lifecycle-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const webhooks = [];

const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    const raw = Buffer.concat(chunks).toString('utf8');
    try { body = JSON.parse(raw); } catch {}
    webhooks.push({
      type: req.headers['x-event-type'],
      id: req.headers['x-event-id'],
      signature: req.headers['x-hub-signature-256'],
      body,
    });
    res.statusCode = 204;
    res.end();
  });
});

async function waitFor(fn, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(75);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

function once(socket, event, timeoutMs = 5000) {
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

function connect() {
  return io(BASE, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: false,
  });
}

async function join(socket, sessionId, playerId, playerName, reconnectToken = null) {
  if (!socket.connected) await once(socket, 'connect');
  return new Promise((resolve) => socket.emit('join', {
    sessionId,
    playerId,
    playerName,
    reconnectToken,
  }, resolve));
}

async function createSession(turnDurationSec = 30) {
  const response = await fetch(`${BASE}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnDurationSec }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`start failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function state(sessionId) {
  const response = await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  return response.ok ? response.json() : null;
}

async function move(socket, sessionId, playerId, position, observer) {
  const applied = once(observer, 'move-applied');
  socket.emit('make-move', { sessionId, playerId, position });
  return applied;
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
      HMAC_SECRET: 'ttt-lifecycle-test-secret',
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

  let a = null;
  let b = null;
  let intruder = null;
  let completedReconnect = null;

  try {
    await waitFor(async () => {
      try { return (await fetch(BASE)).ok; } catch { return false; }
    }, 'server');

    const created = await createSession();
    const sessionId = created.sessionId;
    const playerA = 'life-a';
    const playerB = 'life-b';

    a = connect();
    b = connect();
    const ackA = await join(a, sessionId, playerA, 'Lifecycle A');
    const ackB = await join(b, sessionId, playerB, 'Lifecycle B');
    if (!ackA?.success || !ackB?.success) {
      throw new Error(`join failed: A=${JSON.stringify(ackA)} B=${JSON.stringify(ackB)}`);
    }

    // A third identity cannot join a full pending lobby.
    intruder = connect();
    const badAck = await join(intruder, sessionId, 'intruder', 'Intruder');
    if (badAck?.success !== false || !/full|started/i.test(badAck?.message || '')) {
      throw new Error(`rejected join did not fail correctly: ${JSON.stringify(badAck)}`);
    }
    console.log(`PASS_TTT_REJECTED_JOIN message=${badAck.message}`);
    intruder.disconnect();
    intruder = null;

    let gameFoundA = 0;
    let gameFoundB = 0;
    a.on('game-found', () => { gameFoundA += 1; });
    b.on('game-found', () => { gameFoundB += 1; });

    const readyA = once(a, 'ready-confirmed');
    a.emit('player-ready', { sessionId, playerId: playerA });
    await readyA;
    await sleep(100);
    let live = await state(sessionId);
    if (live.status !== 'pending' || live.players.filter((p) => p.ready).length !== 1) {
      throw new Error(`1/2 Ready incorrectly started session: ${JSON.stringify(live)}`);
    }
    if (webhooks.filter((event) => event.type === 'session.started').length !== 0) {
      throw new Error('session.started emitted at 1/2 Ready');
    }
    console.log('PASS_TTT_ONE_READY_STAYS_PENDING');

    const readyB = once(b, 'ready-confirmed');
    const foundA = once(a, 'game-found');
    const foundB = once(b, 'game-found');
    b.emit('player-ready', { sessionId, playerId: playerB });
    await Promise.all([readyB, foundA, foundB]);

    await waitFor(() => webhooks.filter((event) => event.type === 'session.started').length === 1, 'one session.started');
    live = await state(sessionId);
    if (live.status !== 'active' || live.players.filter((p) => p.ready).length !== 2) {
      throw new Error(`2/2 Ready did not activate: ${JSON.stringify(live)}`);
    }

    const startedEvents = webhooks.filter((event) => event.type === 'session.started');
    const startedBody = startedEvents[0].body;
    const expectedStartedKeys = ['currentTurnPlayerId', 'players', 'sessionId', 'startedAt', 'status'];
    const actualStartedKeys = Object.keys(startedBody || {}).sort();
    if (JSON.stringify(actualStartedKeys) !== JSON.stringify(expectedStartedKeys.sort())) {
      throw new Error(`session.started payload keys changed: ${JSON.stringify(actualStartedKeys)}`);
    }
    console.log('PASS_TTT_TWO_READY_STARTS_SESSION session.started=1');

    // Delayed duplicate Ready is safe and must not start the game a second time.
    const duplicateAck = once(a, 'ready-confirmed');
    a.emit('player-ready', { sessionId, playerId: playerA });
    await duplicateAck;
    await sleep(300);
    if (gameFoundA !== 1 || gameFoundB !== 1) {
      throw new Error(`duplicate Ready emitted extra game-found: A=${gameFoundA} B=${gameFoundB}`);
    }
    if (webhooks.filter((event) => event.type === 'session.started').length !== 1) {
      throw new Error('duplicate Ready emitted another session.started');
    }
    console.log('PASS_TTT_DUPLICATE_READY_IDEMPOTENT session.started=1 game-found=1');

    // X is the first player. Produce a deterministic X win: 0,1,2.
    await move(a, sessionId, playerA, 0, b);
    await move(b, sessionId, playerB, 3, a);
    await move(a, sessionId, playerA, 1, b);
    await move(b, sessionId, playerB, 4, a);

    const endedA = once(a, 'game-ended');
    const endedB = once(b, 'game-ended');
    a.emit('make-move', { sessionId, playerId: playerA, position: 2 });
    const [endA, endB] = await Promise.all([endedA, endedB]);

    if (endA.reason !== 'win' || endB.reason !== 'win' || endA.winnerPlayerId !== playerA) {
      throw new Error(`winner result changed: ${JSON.stringify(endA)}`);
    }
    if (JSON.stringify(endA.board) !== JSON.stringify(['X','X','X','O','O',null,null,null,null])) {
      throw new Error(`final board changed: ${JSON.stringify(endA.board)}`);
    }

    await waitFor(() => webhooks.filter((event) => event.type === 'session.ended').length === 1, 'session.ended');
    const endedWebhook = webhooks.find((event) => event.type === 'session.ended');
    if (endedWebhook.body?.winState !== 'win'
      || endedWebhook.body?.winnerPlayerId !== playerA
      || endedWebhook.body?.status !== 'ended') {
      throw new Error(`settlement/final webhook changed: ${JSON.stringify(endedWebhook.body)}`);
    }
    console.log(`PASS_TTT_FULL_LIFECYCLE winner=${playerA} winState=${endedWebhook.body.winState}`);
    console.log('PASS_TTT_FINAL_RESULT_UNCHANGED board=X,X,X/O,O winner=life-a');

    await sleep(200);
    if (await state(sessionId)) throw new Error('completed session still available via /session');

    const activeResponse = await fetch(`${BASE}/admin/sessions/active`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const active = await activeResponse.json();
    if (!activeResponse.ok || active.some((item) => item.sessionId === sessionId)) {
      throw new Error(`completed session still active: ${JSON.stringify(active)}`);
    }
    console.log('PASS_TTT_COMPLETED_SESSION_CLEANUP');

    completedReconnect = connect();
    const reconnectAck = await join(completedReconnect, sessionId, playerA, 'Lifecycle A', ackA.reconnectToken);
    if (reconnectAck?.success !== false || !/not found/i.test(reconnectAck?.message || '')) {
      throw new Error(`completed session reconnect was not rejected: ${JSON.stringify(reconnectAck)}`);
    }
    console.log(`PASS_TTT_COMPLETED_RECONNECT_REJECTED message=${reconnectAck.message}`);

    const counts = {};
    for (const event of webhooks) counts[event.type] = (counts[event.type] || 0) + 1;
    console.log(`WEBHOOK_COUNTS=${JSON.stringify(counts)}`);
    console.log(`SESSION_STARTED_EXACTLY_ONCE=${counts['session.started'] === 1}`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    try { a?.disconnect(); } catch {}
    try { b?.disconnect(); } catch {}
    try { intruder?.disconnect(); } catch {}
    try { completedReconnect?.disconnect(); } catch {}
    try { server.kill(); } catch {}
    receiver.close();
  }
})();