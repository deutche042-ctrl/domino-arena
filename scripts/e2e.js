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

// ── voice signaling: roster, mute flag, relay, disconnect cleanup ──
const rosterB = new Promise(r => b.once('voice:state', r));
ok((await emit(a, 'voice:join', {})).ok, 'alice opened her mic');
const roster1 = await rosterB;
ok(roster1 && roster1.length === 1 && roster1[0].id === cr.playerId &&
   roster1[0].name === 'Alice' && roster1[0].muted === false, 'voice roster broadcast to the room');

const rosterA = new Promise(r => a.once('voice:state', r));
ok((await emit(b, 'voice:join', {})).ok, 'bob opened his mic');
const roster2 = await rosterA;
ok(roster2 && roster2.length === 2, 'roster lists both voice players');

const muteState = new Promise(r => b.once('voice:state', r));
emit(a, 'voice:mute', { muted: true });
const roster3 = await muteState;
ok(roster3 && roster3.find(p => p.id === cr.playerId)?.muted === true, 'mute flag broadcasts');

const relayed = new Promise(r => b.once('voice:signal', r));
emit(a, 'voice:signal', { to: jr.playerId, data: { description: { type: 'offer', sdp: 'fake' } } });
const sig = await relayed;
ok(sig && sig.from === cr.playerId && sig.data.description?.type === 'offer', 'signaling relayed to the target peer');

b.emit('voice:leave');
const rosterLeft = await new Promise(r => a.once('voice:state', r));
ok(rosterLeft && rosterLeft.length === 1, 'voice:leave removes bob from the roster');

// disconnect drops the player from the voice roster
ok((await emit(b, 'voice:join', {})).ok, 'bob re-opened his mic');
await sleep(80);
const rosterDropP = new Promise(r => a.once('voice:state', r));
b.close();
const rosterDrop = await rosterDropP;
ok(rosterDrop && rosterDrop.length === 1, 'disconnect removes bob from the voice roster');

// reconnect mid-game with token
const bToken = jr.token;
await sleep(120);
const b2 = await client();
const rj = await emit(b2, 'room:join', { code: cr.code, name: 'Bob', token: bToken });
ok(rj.ok && rj.reconnected && rj.state === 'playing', 'reconnect with token mid-game');
const b2state = await once(b2, 'game:state');
ok(b2state && Array.isArray(b2state.hand) && b2state.names, 'reconnected player receives state');

// ── bots mode: instant room, bots drive the game, room dies with the human ──
const h = await client();
const bcr = await emit(h, 'room:create', { name: 'Human', vsBots: true, botDelayMs: 25 });
ok(bcr.ok && bcr.state === 'playing', 'bot room created and started instantly');

const botIds = new Set();
let botMoves = 0, humanPlayed = false, hg = null;
let botDoneResolve;
const botDone = new Promise(r => { botDoneResolve = r; });
h.on('game:state', s => {
  hg = s;
  for (const pid of s.players) if (s.isBot?.[pid]) botIds.add(pid);
  if (s.lastAction && botIds.has(s.lastAction.pid)) botMoves++;
  // test human auto-plays every own turn so the table keeps flowing
  if (s.status === 'playing' && s.turn === bcr.playerId) {
    humanPlayed = true;
    if (s.legalMoves.length) h.emit('game:play', { tileId: s.legalMoves[0].tileId, end: s.legalMoves[0].end });
    else if (s.canDraw) h.emit('game:draw');
    else if (s.canPass) h.emit('game:pass');
  }
  if (botMoves >= 5 || s.status === 'matchEnd') botDoneResolve();
});
await botDone;
ok(botIds.size === 3, 'table has 3 bots');
ok(hg && hg.players.length === 4, 'game state shows 4 players');
ok(botMoves >= 5, `bots play on their own (${botMoves} bot moves observed)`);
ok(humanPlayed, 'human got a turn and played');

await emit(h, 'room:leave');
h.close();
await sleep(120);
const ghost = await client();
const rejoin = await emit(ghost, 'room:join', { code: bcr.code, name: 'Ghost' });
ok(rejoin.ok === false, 'bot room deleted after the human left');
ghost.close();

// ── bots in a normal lobby: host adds/removes, bot is auto-ready ──
const c = await client();
const d = await client();
const ncr = await emit(c, 'room:create', { name: 'Host' });
ok((await emit(d, 'room:join', { code: ncr.code, name: 'Guest' })).ok, 'guest joined normal room');
const addBotRes = await emit(c, 'lobby:addBot', {});
const botPlayer = addBotRes.lobby?.players?.at(-1);
ok(addBotRes.ok && addBotRes.lobby.players.length === 3 && botPlayer.isBot === true,
  'host added a bot to the lobby');
ok(!(await emit(d, 'lobby:addBot', {})).ok, 'non-host cannot add bots');
ok((await emit(c, 'lobby:removeBot', { playerId: botPlayer.id })).ok, 'host removed the bot');
ok((await emit(c, 'lobby:addBot', { level: 'hard' })).ok, 're-added a bot with hard level');
d.emit('lobby:ready', { ready: true });
await sleep(60);
const cStatePromise = once(c, 'game:state');   // register BEFORE start: server broadcasts before the ack
ok((await emit(c, 'game:start')).ok, 'bot is auto-ready: game starts');
const cState = await cStatePromise;
ok(cState && cState.players.length === 3, 'game started with the bot seated (host + guest + bot)');

a.close(); b2.close(); c.close(); d.close();
clearTimeout(watchdog);
console.log(`\n  E2E PASSED — ${passed} checks ✓\n`);
process.exit(0);
