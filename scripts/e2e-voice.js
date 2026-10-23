// scripts/e2e-voice.js — black-box e2e for the voice signaling protocol and
// the chat history/typing/rate-limit upgrades.
//
// Usage:  PORT=3100 npm start          (one shell)
//         npm run e2e:voice 3100       (another shell; defaults to 3100)
//
// The script never imports server code: it speaks the socket protocol exactly
// like a browser client would. A watchdog exits non-zero on a hang.
import { io as ioc } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = process.argv[2] || 3100;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  return new Promise((resolve, reject) => {
    const s = ioc(URL, { transports: ['websocket'], timeout: 5000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const emit = (s, ev, payload) => new Promise((resolve) => {
  const to = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 5000);
  s.emit(ev, payload, (res) => { clearTimeout(to); resolve(res); });
});

/** Resolve with the first event matching predicate, or null on timeout. */
function waitFor(s, ev, predicate = () => true, ms = 5000) {
  return new Promise((resolve) => {
    let timer = null;
    const onEvent = (data) => {
      let hit = false;
      try { hit = predicate(data); } catch { hit = false; }
      if (!hit) return;
      clearTimeout(timer);
      s.off(ev, onEvent);
      resolve(data);
    };
    timer = setTimeout(() => {
      s.off(ev, onEvent);
      resolve(null);
    }, ms);
    s.on(ev, onEvent);
  });
}

const expectNone = (s, ev, ms = 700) => waitFor(s, ev, () => true, ms);

function collect(s, ev, ms) {
  const out = [];
  const onEvent = (data) => out.push(data);
  s.on(ev, onEvent);
  return sleep(ms).then(() => {
    s.off(ev, onEvent);
    return out;
  });
}

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓', name);
}

const watchdog = setTimeout(() => {
  console.error('VOICE E2E watchdog fired — hang somewhere');
  process.exit(2);
}, 60000);

try {
  const host = await client();
  const guest = await client();

  // ── room + initial chat history ──
  const cr = await emit(host, 'room:create', { name: 'Host' });
  ok(cr.ok && cr.playerId, `room created (${cr.code})`);
  const code = cr.code;
  const hostId = cr.playerId;

  // chat:history and voice:roster are unicast right after the join ack —
  // register the listeners before emitting.
  const guestHistP = waitFor(guest, 'chat:history', (h) => h?.code === code, 3000);
  const guestRosterP = waitFor(guest, 'voice:roster', Array.isArray, 3000);
  const jr = await emit(guest, 'room:join', { code, name: 'Guest' });
  ok(jr.ok && jr.playerId, 'guest joined');
  const guestId = jr.playerId;
  const guestHist = await guestHistP;
  const guestRoster = await guestRosterP;
  ok(guestHist && Array.isArray(guestHist.messages) && guestHist.messages.length === 0,
    'fresh join receives an empty chat:history');
  ok(guestRoster && guestRoster.length === 0,
    'join unicasts the current (empty) voice roster');

  // ── chat: mid/at + history content ──
  const hostMsgP = waitFor(guest, 'chat:msg', (m) => m?.text === 'history-one', 3000);
  host.emit('chat:send', { text: 'history-one' });
  const first = await hostMsgP;
  ok(first && typeof first.mid === 'string' && first.mid.startsWith(code + ':c'),
    'chat message carries a room-scoped mid');
  ok(first && typeof first.at === 'number', 'chat message carries at');

  const guestMsgP = waitFor(host, 'chat:msg', (m) => m?.text === 'history-two', 3000);
  guest.emit('chat:send', { text: 'history-two' });
  const second = await guestMsgP;
  ok(second && second.mid && second.mid !== first.mid, 'mids are unique per message');

  // ── fill the table so a spectator can join ──
  ok((await emit(host, 'lobby:config', { maxPlayers: 3 })).ok, 'host capped the room at 3 players');
  const addBot = await emit(host, 'lobby:addBot', {});
  ok(addBot.ok && addBot.lobby?.players?.length === 3, 'bot seated (table is full)');
  const botId = addBot.lobby.players.find((p) => p.isBot)?.id;

  const sp = await client();
  const spHistP = waitFor(sp, 'chat:history', (h) => h?.code === code, 3000);
  const spRosterP = waitFor(sp, 'voice:roster', Array.isArray, 3000);
  const spj = await emit(sp, 'room:join', { code, name: 'Watcher' });
  ok(spj.ok === true && spj.spectating === true, 'third human joins as a spectator');
  const spHist = await spHistP;
  const spRoster = await spRosterP;
  ok(spHist && spHist.messages.length === 2 &&
     spHist.messages[0].text === 'history-one' &&
     spHist.messages[1].text === 'history-two',
    'spectator receives the chat history in server order');
  ok(spRoster && Array.isArray(spRoster) && spRoster.length === 0,
    'spectator receives the voice roster (bootstrap only)');
  const spectatorPid = 'spectator:' + spj.spectatorId;

  const spVoice = await emit(sp, 'voice:join');
  ok(spVoice.ok === false && /متفرج/.test(spVoice.error || ''),
    'spectator voice:join is rejected in Arabic');

  // ── voice join + roster ──
  const guestSeesHostP = waitFor(guest, 'voice:roster',
    (r) => Array.isArray(r) && r.some((x) => x.id === hostId), 3000);
  const hostJoin = await emit(host, 'voice:join');
  ok(hostJoin.ok === true && hostJoin.selfId === hostId &&
     Array.isArray(hostJoin.roster) && hostJoin.roster.length === 1,
    'host joined voice; ack carries selfId + roster');
  const guestSeesHost = await guestSeesHostP;
  ok(guestSeesHost && guestSeesHost.length === 1,
    'peers see the roster broadcast before the join ack resolves');

  const hostSeesBothP = waitFor(host, 'voice:roster',
    (r) => Array.isArray(r) && r.length === 2 && r.every((x) => !x.hostMuted), 3000);
  const guestJoin = await emit(guest, 'voice:join');
  ok(guestJoin.ok && guestJoin.selfId === guestId &&
     Array.isArray(guestJoin.roster) && guestJoin.roster.length === 2,
    'guest joined voice; roster lists both humans');
  const hostSeesBoth = await hostSeesBothP;
  ok(hostSeesBoth &&
     hostSeesBoth.map((x) => x.id).join(',') === [hostId, guestId].join(','),
    'roster keeps the stable seat order');

  // ── self mute / unmute broadcast ──
  const mutedP = waitFor(host, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.muted === true, 3000);
  guest.emit('voice:mute', { muted: true });
  ok(await mutedP !== null, 'self mute broadcasts a muted roster');
  const unmutedP = waitFor(host, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.muted === false, 3000);
  guest.emit('voice:mute', { muted: false });
  ok(await unmutedP !== null, 'self unmute broadcasts the cleared flag');

  // A duplicate join must not silently unmute (the ack preserves self state).
  const dupMuteP = waitFor(host, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.muted === true, 3000);
  guest.emit('voice:mute', { muted: true });
  await dupMuteP;
  const dupJoin = await emit(guest, 'voice:join');
  ok(dupJoin.ok === true &&
     dupJoin.roster.find((x) => x.id === guestId)?.muted === true,
    'duplicate voice:join does not unmute a self-muted player');
  const dupUnmuteP = waitFor(host, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.muted === false, 3000);
  guest.emit('voice:mute', { muted: false });
  await dupUnmuteP;

  // ── host moderation ──
  const hostMuteP = waitFor(guest, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.hostMuted === true, 3000);
  const hostMuteAck = await emit(host, 'voice:moderate', { pid: guestId, muted: true });
  ok(hostMuteAck.ok === true &&
     hostMuteAck.roster.find((x) => x.id === guestId)?.muted === true,
    'host mute ack returns the updated roster');
  ok(await hostMuteP !== null, 'host mute reaches the room');

  // A host-muted player cannot lift it on themselves.
  const noUnmuteP = expectNone(guest, 'voice:roster', 600);
  guest.emit('voice:mute', { muted: false });
  ok(await noUnmuteP === null, 'self-unmute is refused while host-muted');

  const hostUnmuteP = waitFor(guest, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.hostMuted === false, 3000);
  const hostUnmuteAck = await emit(host, 'voice:moderate', { pid: guestId, muted: false });
  ok(hostUnmuteAck.ok === true && await hostUnmuteP !== null,
    'host unmute clears the flag');

  const notHost = await emit(guest, 'voice:moderate', { pid: hostId, muted: true });
  ok(notHost.ok === false && /المضيف/.test(notHost.error || ''),
    'non-host voice:moderate is refused in Arabic');
  const selfMod = await emit(host, 'voice:moderate', { pid: hostId, muted: true });
  ok(selfMod.ok === false && /نفسك/.test(selfMod.error || ''),
    'host cannot voice-moderate himself');
  const botMod = await emit(host, 'voice:moderate', { pid: botId, muted: true });
  ok(botMod.ok === false && /بوت/.test(botMod.error || ''),
    'bot cannot be voice-moderated');
  const badBool = await emit(host, 'voice:moderate', { pid: guestId, muted: 'false' });
  ok(badBool.ok === false && /قيمة/.test(badBool.error || ''),
    'non-boolean muted is refused');
  const missing = await emit(host, 'voice:moderate', { all: false, muted: true });
  ok(missing.ok === false && /تحدد/.test(missing.error || ''),
    'missing moderation target is refused');

  // "all" mutes joined humans except the host, in one broadcast.
  const allOnP = waitFor(guest, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.hostMuted === true, 3000);
  const allOnAck = await emit(host, 'voice:moderate', { all: true, muted: true });
  ok(allOnAck.ok === true &&
     allOnAck.roster.find((x) => x.id === guestId)?.hostMuted === true,
    'moderate all mutes every joined non-host human');
  await allOnP;
  const allOffP = waitFor(guest, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.hostMuted === false, 3000);
  const allOffAck = await emit(host, 'voice:moderate', { all: true, muted: false });
  ok(allOffAck.ok === true && await allOffP !== null, 'moderate all unmutes again');

  // ── signal relay ──
  const offer = { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };
  const offerP = waitFor(guest, 'voice:signal', (m) => m?.payload?.sdp === offer.sdp, 3000);
  host.emit('voice:signal', { to: guestId, payload: offer });
  const relayed = await offerP;
  ok(relayed && relayed.from === hostId &&
     relayed.payload.kind === 'offer' && relayed.payload.sdp === offer.sdp,
    'offer is relayed with a server-derived from');

  const candidate = {
    kind: 'candidate',
    candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  };
  const candidateP = waitFor(host, 'voice:signal', (m) => m?.payload?.kind === 'candidate', 3000);
  guest.emit('voice:signal', { to: hostId, payload: candidate });
  ok(await candidateP !== null, 'ICE candidate is relayed');

  const oversizedP = expectNone(guest, 'voice:signal', 700);
  host.emit('voice:signal', { to: guestId, payload: { kind: 'offer', sdp: 'x'.repeat(17000) } });
  ok(await oversizedP === null, 'oversized signal (>16 KB) is dropped');

  const badKindP = expectNone(guest, 'voice:signal', 700);
  host.emit('voice:signal', { to: guestId, payload: { kind: 'bogus', sdp: 'x' } });
  ok(await badKindP === null, 'unknown signal kind is dropped');

  const spSignalP = expectNone(sp, 'voice:signal', 700);
  host.emit('voice:signal', { to: spj.spectatorId, payload: offer });
  ok(await spSignalP === null, 'signaling to a spectator is dropped');

  // ── host mute survives voice leave/rejoin ──
  await emit(host, 'voice:moderate', { pid: guestId, muted: true });
  const leftP = waitFor(host, 'voice:roster',
    (r) => !r.some((x) => x.id === guestId), 3000);
  guest.emit('voice:leave');
  ok(await leftP !== null, 'voice:leave removes the peer from the roster');

  const rejoinedP = waitFor(host, 'voice:roster',
    (r) => r.find((x) => x.id === guestId)?.hostMuted === true, 3000);
  const rejoin = await emit(guest, 'voice:join');
  const rejoinedRoster = await rejoinedP;
  ok(rejoin.ok === true &&
     rejoin.roster.find((x) => x.id === guestId)?.muted === true,
    'rejoin preserves host mute (leave/rejoin cannot bypass it)');
  ok(rejoinedRoster !== null, 'peers see the rejoined player as host-muted');

  // A seated but not-joined target can still be moderated (joins muted later).
  const leftAgainP = waitFor(host, 'voice:roster',
    (r) => !r.some((x) => x.id === guestId), 3000);
  guest.emit('voice:leave');
  await leftAgainP;
  const notJoinedMod = await emit(host, 'voice:moderate', { pid: guestId, muted: false });
  ok(notJoinedMod.ok === true && !notJoinedMod.roster.some((x) => x.id === guestId),
    'host can moderate a seated player who is not voice-joined');

  const notJoinedSignalP = expectNone(guest, 'voice:signal', 500);
  host.emit('voice:signal', { to: guestId, payload: offer });
  ok(await notJoinedSignalP === null, 'signal to a non-joined player is dropped');

  const cleanJoin = await emit(guest, 'voice:join');
  ok(cleanJoin.ok === true &&
     cleanJoin.roster.find((x) => x.id === guestId)?.muted === false,
    'rejoin after the host lifted the mute is unmuted');

  // ── typing relay ──
  const typingP = waitFor(host, 'chat:typing', (t) => t?.pid === guestId, 3000);
  guest.emit('chat:typing');
  const typing = await typingP;
  ok(typing && typing.name === 'Guest' && !typing.spectator,
    'typing is relayed with the server-derived identity');

  const typingBurstP = collect(host, 'chat:typing', 600);
  guest.emit('chat:typing');
  guest.emit('chat:typing');
  const typingBurst = await typingBurstP;
  ok(typingBurst.length <= 1, 'typing relay is throttled to one per 1200 ms');

  const spTypingP = waitFor(host, 'chat:typing', (t) => t?.spectator === true, 3000);
  sp.emit('chat:typing');
  const spTyping = await spTypingP;
  ok(spTyping && spTyping.pid === spectatorPid && spTyping.name === 'Watcher',
    'spectator typing carries the spectator tag and pid');

  // ── chat mute also silences typing and never fakes a rate-limit notice ──
  await sleep(1300);
  ok((await emit(host, 'lobby:chatMute', { pid: guestId, muted: true })).ok,
    'host chat-muted the guest');
  const mutedTypingP = expectNone(host, 'chat:typing', 700);
  guest.emit('chat:typing');
  ok(await mutedTypingP === null, 'chat-muted typing is not relayed');

  const mutedMsgP = expectNone(host, 'chat:msg', 800);
  const mutedLimitedP = expectNone(guest, 'chat:limited', 800);
  for (let i = 0; i < 6; i++) guest.emit('chat:send', { text: 'muted-' + i });
  ok(await mutedMsgP === null, 'chat-muted messages are dropped');
  ok(await mutedLimitedP === null, 'muted drops do not trigger chat:limited');

  ok((await emit(host, 'lobby:chatMute', { pid: guestId, muted: false })).ok,
    'host unmuted the guest');

  // ── rate limit: five pass, the sixth is announced exactly once ──
  await sleep(3200);   // fresh window
  const limitedP = collect(guest, 'chat:limited', 900);
  const deliveredP = collect(host, 'chat:msg', 900);
  for (let i = 0; i < 6; i++) guest.emit('chat:send', { text: 'burst-' + i });
  const limited = await limitedP;
  const delivered = await deliveredP;
  ok(limited.length === 1 && /رسايل|استنى/.test(limited[0]?.message || ''),
    'rate limit sends exactly one Arabic chat:limited per window');
  ok(typeof limited[0]?.retryAfterMs === 'number', 'chat:limited reports retryAfterMs');
  ok(delivered.filter((m) => (m.text || '').startsWith('burst-')).length === 5,
    'five burst messages pass and the sixth is dropped');

  // ── history is complete, ordered, dedupable and excludes muted drops ──
  const sp2 = await client();
  const sp2HistP = waitFor(sp2, 'chat:history', (h) => h?.code === code, 3000);
  const sp2j = await emit(sp2, 'room:join', { code, name: 'Watcher2' });
  ok(sp2j.ok === true && sp2j.spectating === true, 'second spectator joined');
  const h2 = await sp2HistP;
  const texts = (h2?.messages || []).map((m) => m.text);
  ok(h2 && texts.includes('history-one') && texts.includes('history-two') &&
     texts.includes('burst-0'),
    'history contains persisted room messages');
  ok(h2.messages.every((m) => typeof m.mid === 'string' && typeof m.at === 'number'),
    'every history row carries mid + at');
  ok(texts.indexOf('history-one') < texts.indexOf('history-two') &&
     texts.indexOf('history-two') < texts.indexOf('burst-0'),
    'history preserves server order');
  ok(!texts.some((t) => (t || '').startsWith('muted-')),
    'chat-muted messages never enter history');
  ok(h2.messages.length <= 80, 'history is bounded to 80 messages');

  // ── seat-scoped moderation survives a transient disconnect ──
  ok((await emit(host, 'lobby:chatMute', { pid: guestId, muted: true })).ok,
    'host re-muted chat before the reconnect');
  ok((await emit(host, 'voice:moderate', { pid: guestId, muted: true })).ok,
    'host voice-muted the guest before the reconnect');

  guest.close();
  await sleep(200);
  const g2 = await client();
  const g2JoinP = waitFor(g2, 'chat:history', (h) => h?.code === code, 3000);
  const g2j = await emit(g2, 'room:join', { code, name: 'Guest', token: jr.token });
  ok(g2j.ok === true && g2j.reconnected === true, 'guest reconnected with the token');
  await g2JoinP;
  const muteCheckP = expectNone(host, 'chat:msg', 700);
  g2.emit('chat:send', { text: 'still-muted?' });
  ok(await muteCheckP === null, 'chat mute survives a transient disconnect');

  const g2Voice = await emit(g2, 'voice:join');
  ok(g2Voice.ok === true &&
     g2Voice.roster.find((x) => x.id === guestId)?.hostMuted === true,
    'voice host mute survives a transient disconnect');
  await emit(host, 'voice:moderate', { pid: guestId, muted: false });
  await emit(host, 'lobby:chatMute', { pid: guestId, muted: false });

  // ── socket audio relay (voice without TURN) ──
  // Peers that WebRTC cannot connect (different NATs) send 60 ms PCM frames
  // through the game socket; the server must fan them out and enforce mute.
  await emit(host, 'voice:join');
  await emit(g2, 'voice:join');
  host.emit('voice:mute', { muted: false });
  g2.emit('voice:mute', { muted: false });
  await sleep(200);
  const relayFrames = [];
  g2.on('voice:audio', (p) => relayFrames.push(p));
  const relayFrame = { seq: 11, data: Buffer.alloc(160, 3).toString('base64') };
  host.emit('voice:audio', relayFrame);
  await sleep(500);
  ok(relayFrames.length > 0 &&
     relayFrames[0].from === hostId &&
     relayFrames[0].seq === 11 &&
     relayFrames[0].data === relayFrame.data,
    'voice:audio is relayed to the other voice-joined player');

  host.emit('voice:mute', { muted: true });
  await sleep(250);
  const beforeMuted = relayFrames.length;
  host.emit('voice:audio', { seq: 12, data: relayFrame.data });
  await sleep(450);
  ok(relayFrames.length === beforeMuted, 'a self-muted player cannot relay audio');
  host.emit('voice:mute', { muted: false });
  await sleep(150);

  const beforeSpectator = relayFrames.length;
  sp.emit('voice:audio', { seq: 13, data: relayFrame.data });
  await sleep(400);
  ok(relayFrames.length === beforeSpectator, 'spectators cannot inject relayed audio');

  g2.close();
  await sleep(200);

  // ── disconnect cleanup ──
  const g3 = await client();
  const g3j = await emit(g3, 'room:join', { code, name: 'Guest', token: jr.token });
  ok(g3j.ok === true && g3j.reconnected === true,
    'guest reclaimed the seat after the disconnect grace');
  const g3Join = await emit(g3, 'voice:join');
  ok(g3Join.ok === true && g3Join.roster.some((x) => x.id === guestId),
    'guest rejoined voice for the cleanup check');
  const guestGoneP = waitFor(host, 'voice:roster',
    (r) => r.length === 1 && r[0].id === hostId, 4000);
  g3.close();
  ok(await guestGoneP !== null, 'disconnect clears the player from the voice roster');

  sp.close();
  sp2.close();
  host.close();
  await sleep(100);

  clearTimeout(watchdog);
  console.log(`\n  VOICE E2E PASSED — ${passed} checks ✓\n`);
  process.exit(0);
} catch (err) {
  clearTimeout(watchdog);
  console.error('\n  VOICE E2E FAILED:', err?.message || err);
  console.error(err?.stack || '');
  process.exit(1);
}
