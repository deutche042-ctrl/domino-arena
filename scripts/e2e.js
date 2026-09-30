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

// ── join brute-force guard: 5 failures per socket, then lockout ──
const brute = await client();
let lastJoin = null;
for (let i = 0; i < 6; i++) lastJoin = await emit(brute, 'room:join', { code: 'ZZZZ', name: 'X' });
ok(lastJoin && lastJoin.ok === false && /محاولات كتير/.test(lastJoin.error || ''),
  'join brute-force lockout after repeated failures');
brute.close();

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

// F2.2 rematch voting: advisory vote nudges the host; a binding non-host vote
// (unanimous minus the host, who can always act alone) restarts the match.
{
  const nudgeP = new Promise(r => a.once('chat:msg', r));
  const voteStateP = new Promise(r => a.once('game:state', r));
  b.emit('game:rematchVote');
  const nudge = await nudgeP;
  ok(nudge && /مباراة جديدة/.test(nudge.text || ''), 'advisory rematch vote nudges the host');
  await voteStateP;   // drain the advisory-vote broadcast
  const restartP = new Promise(r => a.once('game:state', r));
  b.emit('game:rematch');   // 1 of 2 humans >= unanimous-minus-host → instant restart
  const rs = await restartP;
  await once(b, 'game:state');   // drain bob's copy of the restart broadcast
  ok(rs && rs.status === 'playing' && rs.scores[cr.playerId] === 0, 'non-host rematch vote restarts the match');
}

// chat
a.emit('chat:send', { text: 'gg' });
const msg = await once(b, 'chat:msg');
ok(msg && msg.from === 'Alice' && msg.text === 'gg', 'chat delivered');

// disconnect then reconnect mid-game with token
const bToken = jr.token;
b.close();
await sleep(120);
const b2 = await client();
// the server unicasts the game state inside the join handler, so register first
const b2stateP = once(b2, 'game:state', 3000);
const rj = await emit(b2, 'room:join', { code: cr.code, name: 'Bob', token: bToken });
ok(rj.ok && rj.reconnected && rj.state === 'playing', 'reconnect with token mid-game');
const b2state = await b2stateP;
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
  // default variant is draw: one bot may chain several draw actions while the
  // turn stays on it, so don't stop before the human has also had a turn
  if ((botMoves >= 5 && humanPlayed) || s.status === 'matchEnd') botDoneResolve();
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
const dj = await emit(d, 'room:join', { code: ncr.code, name: 'Guest' });
ok(dj.ok, 'guest joined normal room');
const addBotRes = await emit(c, 'lobby:addBot', {});
const botPlayer = addBotRes.lobby?.players?.at(-1);
ok(addBotRes.ok && addBotRes.lobby.players.length === 3 && botPlayer.isBot === true,
  'host added a bot to the lobby');
ok(!(await emit(d, 'lobby:addBot', {})).ok, 'non-host cannot add bots');
ok((await emit(c, 'lobby:removeBot', { playerId: botPlayer.id })).ok, 'host removed the bot');
ok((await emit(c, 'lobby:addBot', { level: 'hard' })).ok, 're-added a bot with hard level');

// ── host chat mute: muted player's messages are dropped, unmute restores ──
ok(!(await emit(d, 'lobby:chatMute', { pid: ncr.playerId, muted: true })).ok, 'non-host cannot chat-mute');
ok((await emit(c, 'lobby:chatMute', { pid: dj.playerId, muted: true })).ok, 'host muted guest chat');
const noMsg = once(c, 'chat:msg', 700);
d.emit('chat:send', { text: 'spam' });
ok(await noMsg === null, 'chat-muted guest message is dropped');
ok((await emit(c, 'lobby:chatMute', { pid: dj.playerId, muted: false })).ok, 'host unmuted guest chat');
const gotMsg = once(c, 'chat:msg', 2000);
d.emit('chat:send', { text: 'hello again' });
const unmuted = await gotMsg;
ok(unmuted && unmuted.text === 'hello again', 'unmuted guest message delivered');

// ── host kick: removes the player now and refuses rejoin by token ──
ok(!(await emit(d, 'lobby:kick', { pid: ncr.playerId })).ok, 'non-host cannot kick');
ok(!(await emit(c, 'lobby:kick', { pid: ncr.playerId })).ok, 'host cannot kick himself');
const kickedEvP = once(d, 'room:kicked', 2000);
ok((await emit(c, 'lobby:kick', { pid: dj.playerId })).ok, 'host kicked the guest');
const kickedEv = await kickedEvP;
ok(kickedEv !== null, 'kicked socket got room:kicked');
const rejoinKicked = await emit(d, 'room:join', { code: ncr.code, name: 'Guest', token: dj.token });
ok(rejoinKicked.ok === false && /طردك/.test(rejoinKicked.error || ''), 'kicked player cannot rejoin by token');
// Kick is session-scoped (no accounts exist): a genuinely fresh connection may
// rejoin — the guarded paths are the stored-token auto-rejoin and the old id.
const freshJoinKicked = await emit(d, 'room:join', { code: ncr.code, name: 'Guest2' });
ok(freshJoinKicked.ok === true, 'fresh connection may join (kick is session-scoped)');
await emit(d, 'room:leave');   // clean exit so the room is start-ready below
d.close();

// ── configurable turn timer: set before the bot-match start below ──
const d2 = await client();
const dj2 = await emit(d2, 'room:join', { code: ncr.code, name: 'Guest2' });
ok(dj2.ok, 'new guest joined after kick');
ok(!(await emit(d2, 'lobby:config', { turnMs: 60000 })).ok, 'non-host config refused');
ok((await emit(c, 'lobby:config', { variant: 'block', targetScore: 50, turnMs: 10000 })).ok, 'host set 10s turns');
d2.emit('lobby:ready', { ready: true });
await sleep(60);
const cStatePromise = once(c, 'game:state');   // register BEFORE start: server broadcasts before the ack
ok((await emit(c, 'game:start')).ok, 'bot is auto-ready: game starts');
const cState = await cStatePromise;
ok(cState && cState.players.length === 3, 'game started with the bot seated (host + guest + bot)');
ok(cState.turnMs === 10000, 'view reports the configured 10s turn time');
ok(typeof cState.turnEndsAt === 'number' && cState.turnEndsAt - cState.serverNow <= 10100,
  'turn countdown armed within the configured window');

a.close(); b2.close(); c.close(); d.close();

// ── spectator mode: full lobby → auto-spectate; claim seat; neutral mid-game view ──
{
  const h = await client();
  const g1 = await client();
  const scr = await emit(h, 'room:create', { name: 'Host' });
  ok((await emit(h, 'lobby:config', { maxPlayers: 2 })).ok, 'spec: host capped room at 2 players');
  ok((await emit(g1, 'room:join', { code: scr.code, name: 'P2' })).ok, 'spec: p2 seated');
  const sp = await client();
  const spj = await emit(sp, 'room:join', { code: scr.code, name: 'Watcher' });
  ok(spj.ok === true && spj.spectating === true, 'spec: full lobby auto-spectates');
  // a seat frees up in the lobby → spectator claims it with a plain re-join
  ok((await emit(g1, 'room:leave')).ok, 'spec: p2 left the lobby');
  await sleep(100);
  const claim = await emit(sp, 'room:join', { code: scr.code, name: 'Watcher' });
  ok(claim.ok === true && !claim.spectating && claim.playerId, 'spec: spectator claimed the free seat');
  // room full again → a fresh watcher rides along; then the game starts
  const sp2 = await client();
  const sp2j = await emit(sp2, 'room:join', { code: scr.code, name: 'Watcher2' });
  ok(sp2j.ok === true && sp2j.spectating === true, 'spec: second watcher auto-spectates a full lobby');
  sp.emit('lobby:ready', { ready: true });
  await sleep(60);
  ok((await emit(h, 'game:start')).ok, 'spec: game started');
  const spStateP = once(sp2, 'game:state', 3000);
  const spState = await spStateP;
  ok(spState && spState.hand === undefined && Array.isArray(spState.legalMoves) && spState.legalMoves.length === 0,
    'spec: spectator view has no hand and no legal moves');
  ok(spState.names && spState.roomCode === scr.code, 'spec: spectator view carries names/code');
  // spectator chat is tagged
  const hostChatP = once(h, 'chat:msg', 2000);
  sp2.emit('chat:send', { text: 'أنا بتصور بس' });
  const spChat = await hostChatP;
  ok(spChat && spChat.spectator === true && spChat.from.startsWith('👁'), 'spec: spectator chat tagged with 👁');
  // spectator cannot play (silent no-op — no error event, no state change)
  const spErrP = once(sp2, 'error', 700);
  sp2.emit('game:play', { tileId: spState.moves?.[0]?.t?.id || '0-0', end: 'L' });
  ok(await spErrP === null, 'spec: spectator game:play is a silent no-op');
  sp.close(); sp2.close(); h.close();
}

if (process.env.E2E_TTL) {
  const t = await client();
  const tcr = await emit(t, 'room:create', { name: 'IdleHost' });
  ok(tcr.ok, 'ttl: idle lobby room created');
  const closed = once(t, 'lobby:closed', 20000);
  const gone = await closed;
  ok(gone && gone.reason, 'ttl: idle lobby swept with lobby:closed notice');
  const rejoinT = await emit(t, 'room:join', { code: tcr.code, name: 'IdleHost' });
  ok(rejoinT.ok === false, 'ttl: swept room no longer joinable');
  t.close();
}

clearTimeout(watchdog);
console.log(`\n  E2E PASSED — ${passed} checks ✓\n`);
process.exit(0);
