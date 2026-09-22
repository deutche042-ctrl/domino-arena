// scripts/e2e-voice.js — black-box socket-protocol test for voice v2
// (WebRTC signaling relay + host-enforced mute) against a RUNNING server.
// Usage:  PORT=3100 npm start  then  node scripts/e2e-voice.js 3100
//
// NOTE on S9 (host-mute survives mic rejoin): per the contract, voice:leave /
// room leave / disconnect clear BOTH voiceMuted and hostMuted, while
// voice:join does NOT clear hostMuted. So the survival path is exercised the
// only way the contract allows: the host mutes a player who is currently OUT
// of voice (`pid` may target non-voice players), and that player's next
// voice:join keeps the host mute. Mute-while-in-voice → leave → join does NOT
// preserve it (leave is a full cleanup by contract).
// Bots have no socket, so "bots never join voice" is asserted indirectly in
// S11: a seated bot never shows up in any roster the humans receive.

import { io as ioc } from 'socket.io-client';

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
const once = (s, ev, ms = 2000) => Promise.race([
  new Promise(r => s.once(ev, r)),
  sleep(ms).then(() => null),
]);

let passed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failures.push(name); console.error('  ✗', name); }
}

// voice:state waiter for one socket. Buffers states that land before we await
// (the server emits synchronously around acks) and supports "expect nothing":
// a short timeout resolves null instead of hanging.
function voiceWaiter(s) {
  const buf = [];
  const waiters = [];
  s.on('voice:state', st => {
    const w = waiters.shift();
    if (w) { clearTimeout(w.t); w.res(st); } else buf.push(st);
  });
  return (ms = 2000) => {
    if (buf.length) return Promise.resolve(buf.shift());
    const w = {};
    return new Promise(res => {
      w.res = res;
      w.t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        res(null);
      }, ms);
      waiters.push(w);
    });
  };
}
const rosterEntry = (roster, id) =>
  (Array.isArray(roster) ? roster.find(p => p.id === id) : null) || null;

const watchdog = setTimeout(() => {
  console.error('VOICE E2E watchdog fired — hang somewhere');
  process.exit(2);
}, 45000);

// passive log of every roster Alice ever receives (used by the bot check at the end)
const everyRosterOnA = [];

// ── setup ──
const a = await client();                       // Alice — host
a.on('voice:state', r => everyRosterOnA.push(r));
const nextA = voiceWaiter(a);
const pFirstA = nextA();
const cr = await emit(a, 'room:create', { name: 'Alice' });
if (!cr?.ok) { console.error('FATAL: room:create failed:', cr); a.close(); process.exit(1); }
ok((await pFirstA)?.length === 0, 'unicast voice:state right after room:create (empty roster)');

// voice:join outside any room is refused (bots are refused server-side too,
// but they have no socket — covered indirectly by the S11 roster check)
const loner = await client();
ok((await emit(loner, 'voice:join', {})).ok === false, 'voice:join outside a room is rejected');
loner.close();

// Alice opens her mic BEFORE Bob joins, so his fresh-join unicast has content
{
  const pA = nextA();
  ok((await emit(a, 'voice:join', {})).ok, 'alice opened her mic (ack ok)');
  const e = rosterEntry(await pA, cr.playerId);
  ok(e && e.name === 'Alice' && e.muted === false && e.hostMuted === false,
    'voice:join broadcasts the roster with alice at clean flags');
}

// S1 — fresh-join roster
const b = await client();                       // Bob
const nextB = voiceWaiter(b);
const pFirstB = nextB();
const jr = await emit(b, 'room:join', { code: cr.code, name: 'Bob' });
ok(jr?.ok, 'bob joined the room');
{
  const e = rosterEntry(await pFirstB, cr.playerId);
  ok(e && e.name === 'Alice', 'S1: fresh join gets a unicast roster containing alice');
}

// S2 — voice:join broadcasts reach the whole room
{
  const p1 = nextA(), p2 = nextB();
  a.emit('voice:leave');                        // no ack by design
  const l1 = await p1, l2 = await p2;
  ok(l1?.length === 0 && l2?.length === 0, 'voice:leave broadcasts an empty roster');

  const p3 = nextA(), p4 = nextB();
  ok((await emit(a, 'voice:join', {})).ok, 'alice re-opened her mic');
  const e1 = rosterEntry(await p3, cr.playerId);
  const e2 = rosterEntry(await p4, cr.playerId);
  ok(e1 && e2 && e1.muted === false && e1.hostMuted === false && e2.muted === false,
    'S2: alice voice:join broadcasts to everyone with clean flags');

  const p5 = nextA(), p6 = nextB();
  ok((await emit(b, 'voice:join', {})).ok, 'bob opened his mic');
  const rA = await p5, rB = await p6;
  ok(rA?.length === 2 && rB?.length === 2 &&
     rosterEntry(rA, jr.playerId)?.muted === false && rosterEntry(rB, jr.playerId)?.muted === false,
    'S2: bob joins too — roster lists both players for everyone');
}

// third client for the relay / mute-all phases
const c = await client();                       // Cara
const nextC = voiceWaiter(c);
const pFirstC = nextC();
const crC = await emit(c, 'room:join', { code: cr.code, name: 'Cara' });
ok(crC?.ok, 'cara joined the room');
{
  ok((await pFirstC)?.length === 2, "S1: cara's fresh join also sees the current roster");
}
{
  const pA = nextA(), pB = nextB(), pC = nextC();
  ok((await emit(c, 'voice:join', {})).ok, 'cara opened her mic');
  const rA = await pA, rB = await pB, rC = await pC;
  ok(rA?.length === 3 && rB?.length === 3 && rC?.length === 3, 'roster lists all three');
}

// S3 — signaling relay
{
  const sigP = once(b, 'voice:signal');
  a.emit('voice:signal', { to: jr.playerId, data: { description: { type: 'offer', sdp: 'x' } } });
  const sig = await sigP;
  ok(sig && sig.from === cr.playerId &&
     sig.data?.description?.type === 'offer' && sig.data?.description?.sdp === 'x',
    'S3: signal relayed to a voice peer (from + data intact)');
}
{
  // Bob drops out of voice: A→B relay must be dropped, A→C still relayed
  const pA = nextA(), pB = nextB(), pC = nextC();
  b.emit('voice:leave');
  const lA = await pA, lB = await pB, lC = await pC;
  ok(lA?.length === 2 && lB?.length === 2 && lC?.length === 2, 'bob left voice (roster shrinks)');

  const dropP = once(b, 'voice:signal', 700);
  a.emit('voice:signal', { to: jr.playerId, data: { description: { type: 'offer', sdp: 'dropped' } } });
  ok(await dropP === null, 'S3: no relay to a player who left voice');

  const sigC = once(c, 'voice:signal');
  a.emit('voice:signal', { to: crC.playerId, data: { description: { type: 'answer', sdp: 'z' } } });
  const sig = await sigC;
  ok(sig && sig.from === cr.playerId && sig.data?.description?.type === 'answer',
    'S3: relay still works between two in-voice peers');

  const pA2 = nextA(), pB2 = nextB(), pC2 = nextC();
  ok((await emit(b, 'voice:join', {})).ok, 'bob re-opened his mic');
  const rA = await pA2, rB = await pB2, rC = await pC2;
  ok(rA?.length === 3 && rB?.length === 3 && rC?.length === 3, 'bob is back in voice');
}

// S4 — self mute
{
  const pA = nextA(), pB = nextB(), pC = nextC();
  a.emit('voice:mute', { muted: true });        // no ack by design
  const rA = await pA, rB = await pB, rC = await pC;
  const eA = rosterEntry(rA, cr.playerId), eB = rosterEntry(rB, cr.playerId);
  ok(eA && eA.muted === true && eA.hostMuted === false && eB && eB.muted === true,
    'S4: self mute shows on the roster as muted (not host-muted)');
}

// S5 — host mute one + ignored self-unmute
{
  const pA = nextA(), pB = nextB(), pC = nextC();
  const hm = await emit(a, 'voice:hostMute', { pid: jr.playerId, muted: true });
  ok(hm?.ok === true, 'S5: host muted bob by pid (ack ok)');
  const rA = await pA, rB = await pB, rC = await pC;
  const eB = rosterEntry(rB, jr.playerId);
  ok(eB && eB.muted === true && eB.hostMuted === true,
    'S5: roster shows bob muted:true hostMuted:true');

  // bob tries to unmute himself while host-muted — must be ignored silently
  b.emit('voice:mute', { muted: false });
  ok(await nextB(700) === null, "S5: bob's self-unmute was ignored (no broadcast)");
  // force a fresh roster via cara's harmless self-mute and re-check bob there
  const pA2 = nextA(), pB2 = nextB(), pC2 = nextC();
  c.emit('voice:mute', { muted: true });
  const fresh = await pB2;
  ok(fresh && rosterEntry(fresh, jr.playerId)?.muted === true &&
     rosterEntry(fresh, jr.playerId)?.hostMuted === true,
    'S5: fresh roster still shows bob host-muted');
  await pA2; await pC2;
}

// S6 — host mute all
{
  const pA = nextA(), pB = nextB(), pC = nextC();
  const hm = await emit(a, 'voice:hostMute', { all: true, muted: true });
  ok(hm?.ok === true, 'S6: host mute-all ack ok');
  const rA = await pA, rB = await pB, rC = await pC;
  ok(rosterEntry(rA, jr.playerId)?.hostMuted === true &&
     rosterEntry(rA, crC.playerId)?.hostMuted === true &&
     rosterEntry(rA, cr.playerId)?.hostMuted === false,
    'S6: mute-all host-mutes every voice participant except the host');
}

// S7 — non-host rejected
{
  const r = await emit(b, 'voice:hostMute', { pid: cr.playerId, muted: true });
  ok(r?.ok === false && typeof r.error === 'string' && /[\u0600-\u06FF]/.test(r.error),
    'S7: non-host hostMute rejected with an Arabic error');
}

// S8 — bad requests
{
  const r1 = await emit(a, 'voice:hostMute', { muted: true });
  ok(r1?.ok === false, 'S8: hostMute without pid/all is rejected');
  const r2 = await emit(a, 'voice:hostMute', { pid: 'nope', muted: true });
  ok(r2?.ok === false && typeof r2.error === 'string' && r2.error.length > 0,
    'S8: hostMute with unknown pid is rejected with an error');
}

// S9 — host-mute survives mic rejoin (see the NOTE at the top of this file)
{
  const pA = nextA(), pB = nextB(), pC = nextC();
  c.emit('voice:leave');
  const lA = await pA, lB = await pB, lC = await pC;
  ok(lA?.length === 2 && lB?.length === 2 && lC?.length === 2, 'cara left voice');

  const pA2 = nextA(), pB2 = nextB(), pC2 = nextC();
  const hm = await emit(a, 'voice:hostMute', { pid: crC.playerId, muted: true });
  ok(hm?.ok === true, 'S9: host muted cara while she is out of voice (pid may target non-voice players)');
  const rA = await pA2, rB = await pB2, rC2 = await pC2;
  ok(rA && rA.length === 2 && rosterEntry(rA, crC.playerId) === null,
    'S9: cara is not on the roster while out of voice');

  const pA3 = nextA(), pB3 = nextB(), pC3 = nextC();
  ok((await emit(c, 'voice:join', {})).ok, 'cara re-opened her mic');
  const rA3 = await pA3, rB3 = await pB3, rC3 = await pC3;
  const e = rosterEntry(rC3, crC.playerId);
  ok(e && e.hostMuted === true && e.muted === true,
    'S9: host mute survives the mic rejoin (voice:join does not clear hostMuted)');
}

// S10 — disconnect cleanup
{
  const pA = nextA(), pC = nextC();
  b.close();                                    // hard disconnect
  const rA = await pA, rC = await pC;
  ok(rA && rA.length === 2 && rosterEntry(rA, jr.playerId) === null &&
     rC && rC.length === 2 && rosterEntry(rC, jr.playerId) === null,
    'S10: disconnect removes bob from the voice roster everywhere');
}

// S11 — bots never appear in any roster
{
  const addBot = await emit(a, 'lobby:addBot', {});
  const botPlayer = addBot?.lobby?.players?.at(-1);
  ok(addBot?.ok === true && botPlayer?.isBot === true, 'S11: host seated a bot in the lobby');
  const botId = botPlayer?.id;

  const pA = nextA(), pC = nextC();
  a.emit('voice:mute', { muted: false });       // harmless change to force a fresh roster
  const rA = await pA, rC = await pC;
  ok(rA?.length === 2 && rC?.length === 2, 'S11: roster still counts only the human voice players');
  ok(botId != null && everyRosterOnA.every(r => rosterEntry(r, botId) === null),
    'S11: the bot never appears in any voice roster');

  // all:true with muted:false clears the host mute (and still skips bots)
  const pA2 = nextA(), pC2 = nextC();
  const hm = await emit(a, 'voice:hostMute', { all: true, muted: false });
  ok(hm?.ok === true, 'S11: host cleared mute-all');
  const rA2 = await pA2, rC2 = await pC2;
  ok(rosterEntry(rC2, crC.playerId)?.hostMuted === false &&
     (botId == null || everyRosterOnA.every(r => rosterEntry(r, botId) === null)),
    "S11: mute-all clear lifted cara's host mute; bot still never on a roster");
}

a.close(); c.close();
clearTimeout(watchdog);
if (failures.length) {
  console.error(`\n  VOICE E2E FAILED — ${passed} passed, ${failures.length} failed:`);
  for (const f of failures) console.error('    ✗ ' + f);
  process.exit(1);
}
console.log(`\n  VOICE E2E PASSED — ${passed} checks ✓\n`);
process.exit(0);
