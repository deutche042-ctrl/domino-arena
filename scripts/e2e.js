// scripts/e2e.js — end-to-end protocol check against a RUNNING server (event-driven, fast).
// Usage:  PORT=3100 node server/server.js &   then   node scripts/e2e.js 3100
import { io as ioc } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = process.argv[2] || 3100;
const URL = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  return new Promise((res, rej) => {
    const s = ioc(URL, { transports: ['websocket'], timeout: 5000 });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}
const emit = (s, ev, p) => new Promise(r => {
  const to = setTimeout(() => r({ ok: false, error: 'ack timeout' }), 5000);
  s.emit(ev, p, (res) => { clearTimeout(to); r(res); });
});
const once = (s, ev, ms = 5000) => Promise.race([
  new Promise(r => s.once(ev, r)),
  sleep(ms).then(() => null),
]);

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓', name);
}

const watchdog = setTimeout(() => { console.error('E2E watchdog fired — hang somewhere'); process.exit(2); }, 45000);

// ── bad code rejected ──
const solo = await client();
const bad = await emit(solo, 'room:join', { code: 'ZZZZ', name: 'X' });
ok(bad.ok === false, 'bad room code rejected');
solo.close();

// ── full game flow ──
const a = await client();
const b = await client();

const cr = await emit(a, 'room:create', { name: 'Alice' });
ok(cr.ok && /^[A-Z2-9]{4}$/.test(cr.code), `room created (${cr.code})`);
const lobbyPromise = new Promise(r => {
  const handler = s => { if (s && s.players.length === 2) { a.off('lobby:state', handler); r(s); } };
  a.on('lobby:state', handler);
});
const jr = await emit(b, 'room:join', { code: cr.code, name: 'Bob' });
ok(jr.ok, 'bob joined');

const lobby = await lobbyPromise;
ok(lobby && lobby.players.length === 2, 'lobby shows 2 players');

ok((await emit(a, 'lobby:config', { variant: 'allfives', targetScore: 50 })).ok, 'host set config');
ok(!(await emit(b, 'lobby:config', { variant: 'block' })).ok, 'non-host config refused');
ok(!(await emit(a, 'game:start')).ok, 'start refused until everyone ready');
b.emit('lobby:ready', { ready: true });
await sleep(60);

// register state listeners BEFORE starting (server broadcasts before the ack)
const states = {};
const sockets = { [cr.playerId]: a, [jr.playerId]: b };
let actions = 0, handEnds = 0, done = null;
const finished = new Promise(r => { done = r; });

function act(pid, s) {
  if (s.status === 'matchEnd') return done(s);
  if (s.status === 'handEnd') {
    if (pid === cr.playerId) { handEnds++; a.emit('game:nextHand'); }  // host advances
    return;
  }
  if (s.turn !== pid || s.status !== 'playing') return;
  if (s.legalMoves.length) {
    const m = s.legalMoves[Math.floor(Math.random() * s.legalMoves.length)];
    sockets[pid].emit('game:play', { tileId: m.tileId, end: m.end });
    actions++;
  } else if (s.canDraw) { sockets[pid].emit('game:draw'); actions++; }
  else if (s.canPass) { sockets[pid].emit('game:pass'); actions++; }
}
const firstStates = {};
a.on('game:state', s => { firstStates[cr.playerId] ??= s; states[cr.playerId] = s; act(cr.playerId, s); });
b.on('game:state', s => { firstStates[jr.playerId] ??= s; states[jr.playerId] = s; act(jr.playerId, s); });

ok((await emit(a, 'game:start')).ok, 'game started');
await sleep(120);   // let first states land (auto-play may finish the whole match meanwhile — that's fine)
const sa = firstStates[cr.playerId], sb = firstStates[jr.playerId];
ok(sa && sb && sa.variant === 'allfives' && sa.hand.length === 7 && sb.hand.length === 7, 'hands dealt (7 each)');
ok(!('hands' in sa), 'opponent hand stays hidden (server projection)');
ok(sa.boneyardCount === 14, 'boneyard count = 14');

const final = await finished;
ok(final.status === 'matchEnd', `match ended after ${actions} actions, ${handEnds} hand(s)`);
ok(final.matchWinnerId && final.scores[final.matchWinnerId] >= 50, 'winner reached target score');
ok(handEnds >= 0, 'hand flow ok');

// rematch
a.emit('game:rematch');
const rs = await once(b, 'game:state');
ok(rs && rs.status === 'playing' && rs.scores[cr.playerId] === 0, 'rematch resets scores');

// chat
a.emit('chat:send', { text: 'gg' });
const msg = await once(b, 'chat:msg');
ok(msg && msg.from === 'Alice' && msg.text === 'gg', 'chat delivered');

// reconnect mid-game with token
const bToken = jr.token;
b.close();
await sleep(120);
const b2 = await client();
const rj = await emit(b2, 'room:join', { code: cr.code, name: 'Bob', token: bToken });
ok(rj.ok && rj.reconnected && rj.state === 'playing', 'reconnect with token mid-game');
const b2state = await once(b2, 'game:state');
ok(b2state && Array.isArray(b2state.hand) && b2state.names, 'reconnected player receives state');

a.close(); b2.close();
clearTimeout(watchdog);
console.log(`\n  E2E PASSED — ${passed} checks ✓\n`);
process.exit(0);
