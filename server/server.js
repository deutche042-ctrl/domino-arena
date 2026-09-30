// server/server.js — Express static host + Socket.IO realtime game server
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { RoomManager, TURN_MS } from './rooms.js';
import { IllegalMove } from '../engine/game.js';
import { chooseAction } from '../engine/bot.js';

// Bundle-safe directory resolution: in the mobile CJS bundle esbuild replaces
// import.meta.url with undefined, where node's own CJS __dirname is correct.
const here = typeof import.meta.url === 'string'
  ? path.dirname(fileURLToPath(import.meta.url))
  : typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1);   // behind Render/Cloudflare — correct client IPs + secure req.protocol
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// Uptime probe: Render health check + free keep-alive ping target.
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.use(express.static(process.env.DOMINO_PUBLIC_DIR || path.join(here, '..', 'public'), { etag: false, maxAge: 0 }));

// LAN debug aid: which addresses the phone/host is reachable on (hotspot IP to share).
// Also reports live room/player counts so the APK discovery list can label each host.
app.get('/host-info', (req, res) => {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  let rooms = 0, players = 0;
  for (const room of manager.rooms.values()) {
    rooms++;
    players += room.players.filter((p) => !p.isBot).length;
  }
  res.json({ port: Number(PORT), ips, rooms, players });
});

const http = createServer(app);
const io = new Server(http, {
  // long-polling fallback keeps the game working through any tunnel/proxy;
  // APK clients are on a localhost origin connecting to the LAN host — allow it
  cors: { origin: true },
  transports: ['websocket', 'polling'],
});

const manager = new RoomManager();

// socket.id -> { roomCode, playerId }
const sessions = new Map();

// S9 (audit): failed room:join attempts keyed by client IP, not socket — a
// per-socket counter reset on every reconnect and made the 4-letter code space
// scannable. Swept by the idle-lobby interval below.
const joinFailsByIp = new Map();   // ip -> failed-join timestamps[]

// K2.S7: a throw inside a socket listener propagates synchronously and would
// kill the process — and every room on it. Log and stay up (the embedded
// mobile launcher likewise never exits).
process.on('uncaughtException', (err) => console.error('[domino] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[domino] unhandledRejection:', err));

function broadcastLobby(room) {
  room.lastActivityAt = Date.now();
  io.to(room.code).emit('lobby:state', manager.lobbyState(room));
}

function broadcastGame(room) {
  armTurnTimer(room);
  scheduleBotTurn(room);
  // Spectators get one shared neutral view (no hand, no legal moves).
  for (const s of room.spectators || []) {
    if (s.socketId) io.to(s.socketId).emit('game:state', manager.gameView(room, '__spectator__'));
  }
  for (const p of room.players) {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit('game:state', manager.gameView(room, p.id));
    }
  }
}

// ---- per-turn timeout ----
// One server-side timer per room, armed for the current player on every state
// broadcast. On expiry the engine takes the forced action: skip their turn if
// they had moves, auto-draw if they must draw, auto-pass otherwise. The timer
// intentionally does NOT restart on broadcasts for the same turn, so disconnects
// or redraws can't be used to refresh the clock.

function clearTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnTimerPid = null;
  room.turnEndsAt = null;
}

function armTurnTimer(room) {
  const game = room.game;
  if (!game || game.status !== 'playing') return clearTurnTimer(room);
  // F2.1: turnMs === 0 is an explicit "no turn timer" house rule. We must NOT
  // fall back to TURN_MS here (that is what `||` would do), and we must clear any
  // timer already armed in case the host turned the clock off mid-match.
  if (room.config.turnMs === 0) {
    clearTurnTimer(room);
    room.turnEndsAt = null;
    return;
  }
  if (room.turnTimer && room.turnTimerPid === game.turn) return;
  clearTurnTimer(room);
  const turnMs = room.config.turnMs || TURN_MS;
  room.turnTimerPid = game.turn;
  room.turnEndsAt = Date.now() + turnMs;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), turnMs);
}

function handleTurnTimeout(room) {
  const armedPid = room.turnTimerPid;   // K2.S4: re-validate the pid we armed for
  clearTurnTimer(room);
  if (manager.getRoom(room.code) !== room) return;
  const game = room.game;
  if (!game || game.status !== 'playing') return;
  if (game.turn !== armedPid) return;   // turn moved on between arm and fire
  const pid = game.turn;
  const p = room.players.find(x => x.id === pid);
  const name = p ? p.name : 'لاعب';
  let msg;
  try {
    if (game.legalMoves(pid).length > 0) {
      game.forceSkip(pid);
      msg = `⏰ انتهى وقت ${name} — تم تخطي دوره`;
    } else if (game.canDraw(pid)) {
      // K2.S3: drain the boneyard in one tick — one tile per timeout left a
      // Draw hand with an AFK player stalling the table for ~7 minutes.
      let drew = 0;
      while (game.canDraw(pid)) {
        game.draw(pid);
        drew++;
        if (game.forcedDrawTileId) break;   // playable tile — their turn continues
      }
      msg = drew > 1
        ? `⏰ انتهى وقت ${name} — اتسحب ${drew} كرت تلقائياً`
        : `⏰ انتهى وقت ${name} — تم سحب كارت ليه تلقائياً`;
      if (!game.forcedDrawTileId && game.canPass(pid)) {
        game.pass(pid);
        msg = `⏰ انتهى وقت ${name} — سحب ومرر تلقائياً`;
      }
    } else if (game.canPass(pid)) {
      game.pass(pid);
      msg = `⏰ انتهى وقت ${name} — تم تمرير دوره تلقائياً`;
    } else {
      return;
    }
  } catch {
    return; // state moved on between arm and fire — the next broadcast re-arms safely
  }
  io.to(room.code).emit('chat:msg', { from: 'النظام', text: msg });
  broadcastGame(room);
}

function currentCtx(socket) {
  const s = sessions.get(socket.id);
  if (!s) return {};
  const room = manager.getRoom(s.roomCode);
  return { room, playerId: s.playerId, spectating: !!s.spectating, spectatorId: s.spectatorId };
}

// ---- bots ----
// Bots are seated server-side with no socket. Every broadcast that leaves the
// turn on a bot arms a short timer; when it fires, the bot's brain
// (engine/bot.js, public info only) picks the action and the engine executes it.
// The timer re-validates on fire (room alive, same game object, same turn) —
// same hygiene as the turn timer above.

const BOT_NAMES = ['بوت حسن', 'بوت نور', 'بوت كريم', 'بوت سلمى', 'بوت زيكو', 'بوت ميرا'];
// K1.B9: per-level think spans — stronger bots visibly "think" longer.
const BOT_DELAY_SPANS = {
  easy: [400, 700], medium: [600, 1100], hard: [900, 1600], expert: [1100, 2000],
};
// Contextual bot chatter (Egyptian Arabic) — pools picked by what just happened
const BOT_LINES = {
  play: ['خد دي بقى 😏', 'اللعب عليا', 'تمام كده', 'شايف الطاولة؟ 👀', 'دبل من القلب'],
  scored: ['+10 على مزاجك 😎', 'حسبتهمولك؟', 'دي كانت محسوبة', 'نقاط في الجيب'],
  handWin: ['جولة في الجيب 😎', 'متلعبوش كده!', 'اللي يغلب يتحسب', 'حلوة أوي دي'],
  draw: ['هسحب كارت يعني', 'الطاولة سخونة النهاردة', 'يمكن أطلع حاجة أحلى'],
  pass: ['معنديش… مرر', 'امسك الكلام باقي 😅', 'مفيش حاجة تلعب، خد انت'],
  neutral: ['🔥', '👏', '🎉'],
};

function scheduleBotTurn(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  const game = room.game;
  if (!game || game.status !== 'playing') return;
  const bot = room.players.find(p => p.id === game.turn);
  if (!bot || !bot.isBot) return;
  const captured = { game, turn: game.turn };
  const [lo, hi] = BOT_DELAY_SPANS[bot.botLevel] || BOT_DELAY_SPANS.medium;
  // K1.B9: consecutive draws in a chain compress to ~250ms — a full "think"
  // per drained tile visibly stalled the table.
  const delay = room.botDelayMs
    || (bot._chainDraw ? 250 + Math.floor(Math.random() * 150)
      : lo + Math.floor(Math.random() * (hi - lo)));
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (manager.getRoom(room.code) !== room) return;
    if (room.game !== captured.game || room.game.status !== 'playing') return;
    if (room.game.turn !== captured.turn) return;
    botAct(room, captured.turn);
  }, delay);
}

function botAct(room, pid) {
  const game = room.game;
  const bot = room.players.find(p => p.id === pid);
  if (!game || !bot) return;
  const action = chooseAction(game, pid, {
    level: bot.botLevel || 'medium',
    profile: bot.botProfile || 'balanced',
  });
  if (!action) return;
  try {
    if (action.type === 'play') game.play(pid, action.tileId, action.end);
    else if (action.type === 'draw') game.draw(pid);
    else if (action.type === 'pass') game.pass(pid);
    else return;
  } catch (e) {
    if (!(e instanceof IllegalMove)) throw e;
    return; // stale read — the next broadcast re-schedules safely
  }
  bot._chainDraw = action.type === 'draw' && !game.forcedDrawTileId;
  broadcastGame(room);   // re-broadcasts and chains to the next bot turn/draw
  botChatter(room, bot, action);   // K1.B9: after the move is visible
}

function botChatter(room, bot, action) {
  if (Math.random() >= 0.12) return;
  const game = room.game;
  // pick a pool by context: hand win > scored play > the bare action
  let pool = BOT_LINES.neutral;
  if (action.type === 'pass') pool = BOT_LINES.pass;
  else if (action.type === 'draw') pool = BOT_LINES.draw;
  else if (game.status === 'handEnd' && game.handResult?.winnerId === bot.id) pool = BOT_LINES.handWin;
  else if (game.lastAction?.scored) pool = BOT_LINES.scored;
  else if (action.type === 'play') pool = BOT_LINES.play;
  const line = pool[Math.floor(Math.random() * pool.length)];
  // Emit on a short delay so the line lands after the state it reacts to.
  setTimeout(() => {
    if (manager.getRoom(room.code) !== room) return;
    const now = Date.now();
    if (bot.lastChatAt && now - bot.lastChatAt < 8000) return;
    bot.lastChatAt = now;
    io.to(room.code).emit('chat:msg', { from: bot.name, pid: bot.id, at: now, text: line });
  }, 400 + Math.floor(Math.random() * 600));
}

function deleteRoom(room, reason = 'اتقفلت الغرفة.') {
  clearTurnTimer(room);
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  // K2.S10 note: spectators have no player entry — without this they'd never
  // learn the room died.
  io.to(room.code).emit('lobby:closed', { reason });
  manager.rooms.delete(room.code);
}

// S2+S3 (audit): a socket that joins/creates while still attached somewhere else
// used to leak its old presence — a seated player stayed connected:true with a
// stale socketId (immortalizing a playing room, double broadcasts), or a
// spectator entry kept the socketId and slowly exhausted the spectator cap.
// Detach the socket from whatever it holds BEFORE attaching it to something new.
// Same semantics as room:leave, minus the client ack.
function detachCurrentRoom(socket) {
  const s = sessions.get(socket.id);
  if (!s) return;
  sessions.delete(socket.id);
  socket.leave(s.roomCode);
  const room = manager.getRoom(s.roomCode);
  if (!room) return;
  if (s.spectating) {
    manager.removeSpectator(room, s.spectatorId);
    broadcastLobby(room);
    return;
  }
  const p = room.players.find(x => x.id === s.playerId);
  if (!p) return;
  p.chatMuted = false; // detaching is a full cleanup
  if (room.state === 'lobby') {
    const res = manager.removePlayer(room, p.id);
    if (!res.empty) broadcastLobby(room);
  } else {
    p.connected = false;
    p.socketId = null;
    if (room.hostId === p.id) {
      const next = room.players.find(x => x.connected && !x.isBot);
      if (next) room.hostId = next.id;
    }
    const humans = room.players.filter(x => x.connected && !x.isBot);
    if (humans.length === 0) {
      deleteRoom(room);
    } else {
      if (humans.length === 1 && !room.players.some(x => x.isBot) &&
          room.game && room.game.status === 'playing') {
        room.game._endMatch(humans[0].id);
        io.to(room.code).emit('chat:msg', { from: 'النظام', text: `غادر ${p.name} اللعبة. فوز بالانسحاب!` });
      } else if (room.game && room.game.status === 'playing' && room.game.turn === p.id) {
        let nextPid = p.id;
        for (let i = 0; i < room.players.length; i++) {
          room.game._advanceTurn(nextPid);
          nextPid = room.game.turn;
          const nextP = room.players.find(x => x.id === nextPid);
          if (nextP && nextP.connected) break;
        }
      }
      broadcastGame(room);
    }
  }
}

// ---- idle lobby sweeper ----
// A lobby nobody touches forever pins memory (matters on the APK host phone).
// Sweep lobbies with no lobby activity (config/ready/chat/join) for LOBBY_TTL_MS.
// Playing rooms are excluded — they have their own all-disconnected cleanup.
const LOBBY_TTL_MS = Math.max(5000, Number(process.env.LOBBY_TTL_MS) || 30 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  // S9: prune stale brute-force counters (entries with no recent failures).
  for (const [ip, ts] of joinFailsByIp) {
    const fresh = ts.filter(t => now - t < 10000);
    if (fresh.length) joinFailsByIp.set(ip, fresh);
    else joinFailsByIp.delete(ip);
  }
  for (const room of [...manager.rooms.values()]) {
    if (room.state !== 'lobby') continue;
    if (now - (room.lastActivityAt || room.createdAt) < LOBBY_TTL_MS) continue;
    deleteRoom(room, 'اتقفلت الغرفة بسبب الخمول الطويل');
  }
}, Math.min(60000, Math.max(1000, LOBBY_TTL_MS / 4))).unref();

io.on('connection', (socket) => {
  // Protocol hardening: every handler destructures its payload (`({ a, b } = {})`),
  // and JS default params do NOT cover an explicitly-sent `null` — a single
  // `socket.emit('game:play', null)` used to destructure null inside the
  // callback and take the whole process down. Normalize once, here, for all
  // handlers; type checks stay in the handlers themselves.
  socket.use((event, next) => {
    // `event` is the live [name, ...payload] array the handler receives —
    // mutate it in place; a rest-copy would not propagate.
    if (event[1] === null) event[1] = {};
    next();
  });
  // S9 (audit): see joinFailsByIp at module scope.
  // per-socket failed-join timestamps (5 / 10 s guard in room:join)
  let joinFails = [];
  // K2.S9: per-socket broadcast throttle for the noisy ready toggle
  let lastReadyBroadcast = 0;

  // ---- lobby ----

  socket.on('room:create', ({ name, vsBots, botLevel, botProfile, botDelayMs } = {}, cb) => {
    // Unbounded room creation would let any LAN peer memory-DoS the host phone.
    if (manager.rooms.size >= (Number(process.env.MAX_ROOMS) || 50)) {
      cb?.({ ok: false, error: 'الغرف كتير أوي على الخادم — جرب كمان شوية' });
      return;
    }
    // K2.S8: one socket holding sessions open could squat all MAX_ROOMS slots —
    // cap live rooms per creating socket (a scan, so nothing to clean up).
    let mine = 0;
    for (const r of manager.rooms.values()) if (r.createdBy === socket.id) mine++;
    if (mine >= 3) {
      cb?.({ ok: false, error: 'عندك ٣ غرف مفتوحة من الجهاز ده — اقفل واحدة الأول.' });
      return;
    }
    // S3: creating while seated/spectating elsewhere must not leak the old seat.
    detachCurrentRoom(socket);
    const { room, player } = manager.createRoom(name);
    room.createdBy = socket.id;
    player.socketId = socket.id;
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    if (vsBots) {
      // Instant bot match: fill the table, deal, and let the scheduler drive.
      // S10: clamp — a crafted 24h delay bricks the room's bot turns.
      const d = Number(botDelayMs);
      room.botDelayMs = Number.isFinite(d) && d >= 25 && d <= 5000 ? d : null;
      const names = [...BOT_NAMES];
      for (let i = 0; i < 3 && room.players.length < room.config.maxPlayers; i++) {
        manager.addBot(room, names.splice(Math.floor(Math.random() * names.length), 1)[0], botLevel, botProfile);
      }
      manager.startGame(room);
    }
    cb?.({
      ok: true, code: room.code, playerId: player.id, token: player.token,
      state: room.state, lobby: manager.lobbyState(room),
    });
    if (vsBots) {
      io.to(room.code).emit('game:started');
      broadcastGame(room);
    } else {
      broadcastLobby(room);
    }
  });

  socket.on('room:join', ({ code, name, token } = {}, cb) => {
    // 4-char room codes are brute-forceable — two independent caps:
    //   per-socket 5 failures / 10 s (the documented guard, e2e-asserted), plus
    //   per-IP 20 failures / 60 s so dropping and reopening sockets (fresh
    //   joinFails each time) cannot keep scanning the code space. A successful
    //   join resets both.
    const now = Date.now();
    const ip = socket.handshake?.address || '?';
    // per-IP backstop: 20 failures / 60 s defeats socket-rotation scanning
    const ipFails = (joinFailsByIp.get(ip) || []).filter(t => now - t < 60000);
    joinFailsByIp.set(ip, ipFails);
    if (ipFails.length >= 20) {
      return cb?.({ ok: false, error: 'محاولات كتير أوي — استنى شوية وجرب تاني.' });
    }
    // per-socket: 5 failures / 10 s (the documented guard, e2e-asserted)
    joinFails = joinFails.filter(t => now - t < 10000);
    if (joinFails.length >= 5) {
      return cb?.({ ok: false, error: 'محاولات كتير أوي — استنى شوية وجرب تاني.' });
    }
    const res = manager.joinRoom(code, name, token, { allowSpectate: true });
    if (res.error) {
      joinFails.push(now);
      ipFails.push(now);
      joinFailsByIp.set(ip, ipFails);
      return cb?.({ ok: false, error: res.error });
    }
    joinFailsByIp.delete(ip);
    if (res.spectating) {
      // Room full or mid-match: ride along as a spectator (no seat;
      // gameplay handlers no-op because this id is not in room.players).
      // S2: drop any previous attachment first so the old spectator entry
      // (or a seated player) can't leak behind the new one.
      detachCurrentRoom(socket);
      const { room, spectator } = res;
      spectator.socketId = socket.id;
      socket.join(room.code);
      sessions.set(socket.id, {
        roomCode: room.code, playerId: 'spectator:' + spectator.id,
        spectating: true, spectatorId: spectator.id,
      });
      cb?.({ ok: true, spectating: true, code: room.code, spectatorId: spectator.id, state: room.state });
      if (room.game) {
        socket.emit('game:state', manager.gameView(room, '__spectator__'));
      }
      broadcastLobby(room);
      return;
    }
    const { room, player } = res;
    // S2/S3: switching seats/rooms must detach the old attachment first — but a
    // token reconnect to the exact seat we already hold is a refresh, not a move.
    const s0 = sessions.get(socket.id);
    const sameSeat = !!res.reconnected && !!s0 && !s0.spectating &&
                     s0.roomCode === room.code && s0.playerId === player.id;
    if (!sameSeat) detachCurrentRoom(socket);
    // If this player was attached to another socket (refresh), detach the old one
    if (player.socketId && player.socketId !== socket.id) {
      const oldSocketId = player.socketId;
      sessions.delete(oldSocketId);
      io.sockets.sockets.get(oldSocketId)?.leave(room.code);
      // S8: the seat moved to a newer live socket — tell the old tab
      // (it used to silently no-op forever).
      io.to(oldSocketId).emit('room:superseded');
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    cb?.({
      ok: true, code: room.code, playerId: player.id, token: player.token,
      reconnected: !!res.reconnected, state: room.state,
      // F1.4: lets the client set the "you're up" banner on a resume without
      // having to wait for the first game:state — a cheap boolean, no hand data.
      youAreUp: room.state === 'playing' && room.game?.status === 'playing' && room.game.turn === player.id,
      lobby: manager.lobbyState(room),
    });
    broadcastLobby(room);
    if (room.state === 'playing') broadcastGame(room);
  });

  // Leave the room entirely (lobby: remove player; in-game: mark disconnected).
  // detachCurrentRoom is the shared S2/S3 helper — room:create/room:join call it
  // before attaching the socket elsewhere so no phantom seat/spectator leaks.
  socket.on('room:leave', (_, cb) => {
    detachCurrentRoom(socket);
    cb?.({ ok: true });
  });

  socket.on('lobby:config', (config = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    // S4: every early return answers its ack — the client's emit() promise
    // (no timeout) used to hang forever when the room vanished.
    if (!room) return cb?.({ ok: false, error: 'الغرفة قفلت أو المباراة بدأت.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه تعديل الإعدادات.' });
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'الإعدادات متاحة في غرفة الانتظار بس.' });
    const merged = { ...room.config, ...manager.sanitizeConfig(config) };
    // E7: allowPass:false with no turn timer soft-locks a stuck player forever
    // (no pass, no moves, no timeout to force-skip) — refuse the combination.
    if (merged.allowPass === false && merged.turnMs === 0) {
      return cb?.({ ok: false, error: 'مينفعش "بدون باص" مع "بدون مؤقّت" — اللاعب هيتعلق للأبد.' });
    }
    room.config = merged;
    cb?.({ ok: true });
    broadcastLobby(room);
  });

  socket.on('lobby:ready', ({ ready } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة.' });
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'الاستعداد متاح في غرفة الانتظار بس.' });
    const p = room.players.find(p => p.id === playerId);
    if (!p || p.isBot) return cb?.({ ok: false, error: 'لازم تكون قاعد في الغرفة عشان تستعد.' });
    p.ready = !!ready;
    cb?.({ ok: true, ready: p.ready });
    // K2.S9: ready toggles can be spammed — throttle the full-room
    // re-broadcast, but NEVER drop the final state (a dropped echo used to
    // leave every client showing a stale ready flag forever, with no later
    // broadcast to heal it). Throttled updates coalesce into one trailing
    // broadcast at the end of the window.
    const now = Date.now();
    if (now - lastReadyBroadcast < 400) {
      if (!room._readyPending) {
        room._readyPending = true;
        setTimeout(() => {
          room._readyPending = false;
          if (manager.getRoom(room.code) !== room) return;
          lastReadyBroadcast = Date.now();
          broadcastLobby(room);
        }, 400 - (now - lastReadyBroadcast));
      }
      return;
    }
    lastReadyBroadcast = now;
    broadcastLobby(room);
  });

  socket.on('lobby:addBot', ({ level, profile } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'الغرفة قفلت أو المباراة بدأت.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه إضافة بوت.' });
    const res = manager.addBot(room, BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], level, profile);
    if (res.error) return cb?.({ ok: false, error: res.error });
    cb?.({ ok: true, lobby: manager.lobbyState(room) });
    broadcastLobby(room);
  });

  socket.on('lobby:removeBot', ({ playerId: botId } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'الغرفة قفلت أو المباراة بدأت.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه حذف البوت.' });
    const removed = manager.removeBot(room, botId);
    cb?.({ ok: removed });
    if (removed) broadcastLobby(room);
  });

  // Host-only chat mute: a chat-muted player's chat:send is silently dropped
  // until the host lifts it (or the player leaves/disconnects — full cleanup).
  socket.on('lobby:chatMute', ({ pid, muted } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه كتم الشات.' });
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'الكتم متاح في غرفة الانتظار بس.' });
    if (typeof pid !== 'string') return cb?.({ ok: false, error: 'لازم تحدد لاعب.' });
    const target = room.players.find(p => p.id === pid);
    if (!target) return cb?.({ ok: false, error: 'اللاعب مش موجود في الغرفة.' });
    if (target.isBot) return cb?.({ ok: false, error: 'البوتات أصلاً مش بتتكلم.' });
    if (target.id === room.hostId) return cb?.({ ok: false, error: 'مينفعش تكتم نفسك.' });
    target.chatMuted = !!muted;
    cb?.({ ok: true });
    broadcastLobby(room);
  });

  socket.on('game:start', (_, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'الغرفة قفلت أو المباراة بدأت.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه بدء اللعبة.' });
    // S5: a start (re-deal) mid-match would wipe the scores — reject it.
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'المباراة بدأت بالفعل.' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'يلزم تواجد لاعبين على الأقل للبدء.' });
    const others = room.players.filter(p => p.id !== room.hostId);
    if (!others.every(p => p.ready && p.connected))
      return cb?.({ ok: false, error: 'يجب أن يكون جميع اللاعبين جاهزين.' });
    manager.startGame(room);
    io.to(room.code).emit('game:started');
    broadcastGame(room);
    cb?.({ ok: true });
  });

  // ---- gameplay ----

  const doAction = (fn) => {
    const ctx = currentCtx(socket);
    if (!ctx.room?.game) return;
    if (ctx.spectating) return; // spectators hold no seat — silent no-op
    try {
      fn(ctx.room.game, ctx.playerId);
    } catch (e) {
      if (e instanceof IllegalMove) {
        socket.emit('error', { code: 'illegal', message: e.message });
        return;
      }
      throw e;
    }
    broadcastGame(ctx.room);
  };

  socket.on('game:play', ({ tileId, end } = {}) => {
    if (typeof tileId !== 'string') return;
    doAction((game, pid) => game.play(pid, tileId, end ?? null));
  });

  socket.on('game:draw', () => doAction((game, pid) => game.draw(pid)));
  socket.on('game:pass', () => doAction((game, pid) => game.pass(pid)));

  // Host-only kick: removes the player now, refuses rejoin (id or token) for
  // the life of the room, and tells the kicked socket why.
  socket.on('lobby:kick', ({ pid } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه طرد اللاعبين.' });
    if (room.state !== 'lobby') return cb?.({ ok: false, error: 'الطرد متاح في غرفة الانتظار بس.' });
    if (typeof pid !== 'string') return cb?.({ ok: false, error: 'لازم تحدد لاعب.' });
    const res = manager.kickPlayer(room, pid);
    if (res.error) return cb?.({ ok: false, error: res.error });
    cb?.({ ok: true });
    if (res.empty) return;
    if (res.kicked?.socketId) {
      // K2.S6: fully detach the kicked socket — it used to keep receiving
      // lobby/chat events until it disconnected on its own.
      const ks = res.kicked.socketId;
      sessions.delete(ks);
      io.sockets.sockets.get(ks)?.leave(room.code);
      io.to(ks).emit('room:kicked');
    }
    broadcastLobby(room);
  });

  // ── continue-votes ──
  // nextHand/rematch stay host-executable, but any seated human can force them
  // by unanimous-minus-host vote (K2.S5 — an AFK host no longer freezes the
  // table at handEnd). Votes are idempotent and surface in the views.
  function castContinueVote(room, playerId, kind) {
    const p = room.players.find(x => x.id === playerId);
    if (!p || p.isBot) return;
    if (room.players.length < 2) return;
    room.continueVotes = room.continueVotes || {};
    const set = room.continueVotes[kind] || new Set();
    if (set.has(playerId)) return;   // K2.S9: duplicate votes don't rebroadcast
    set.add(playerId);
    room.continueVotes[kind] = set;
    const host = room.players.find(x => x.id === room.hostId);
    if (host?.socketId && host.id !== playerId) {
      io.to(host.socketId).emit('chat:msg', {
        from: 'النظام',
        text: `${p.name} عايز ${kind === 'rematch' ? 'مباراة جديدة' : 'الجولة التالية'} — أوصلك زرار التنفيذ`,
      });
    }
    broadcastGame(room);
  }

  function doNextHand(room) {
    room.continueVotes = null;
    room.nextHandVotes = null;
    manager.nextHand(room);
    broadcastGame(room);
  }

  socket.on('game:nextHandVote', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'handEnd') return;
    const me = room.players.find(p => p.id === playerId);
    if (!me || me.isBot) return;
    if (playerId === room.hostId) return doNextHand(room);   // host acts alone
    castContinueVote(room, playerId, 'nextHand');            // view counter + host nudge
    const humans = room.players.filter(p => !p.isBot);
    room.nextHandVotes = room.nextHandVotes || new Set();
    if (room.nextHandVotes.has(playerId)) return;            // binding vote is idempotent
    room.nextHandVotes.add(playerId);
    io.to(room.code).emit('chat:msg', {
      from: 'النظام',
      text: `${me.name} عايز الجولة التالية (${room.nextHandVotes.size}/${humans.length})`,
    });
    // Unanimous minus the host (who can always act alone anyway).
    if (room.nextHandVotes.size >= humans.length - 1) doNextHand(room);
    else broadcastGame(room);
  });

  socket.on('game:rematchVote', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'matchEnd') return;
    castContinueVote(room, playerId, 'rematch');
  });

  socket.on('game:nextHand', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'handEnd') return;
    if (playerId !== room.hostId) return;
    doNextHand(room);
  });

  // K2.S10: back to lobby after a match — reopens the seats so late joiners
  // and spectators can claim one (room.state used to stay 'playing' forever).
  socket.on('game:backToLobby', (_, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة.' });
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه الرجوع لغرفة الانتظار.' });
    if (!room.game || room.game.status !== 'matchEnd') {
      return cb?.({ ok: false, error: 'الرجوع لغرفة الانتظار متاح بعد نهاية المباراة بس.' });
    }
    room.game = null;
    room.state = 'lobby';
    room.continueVotes = null;
    room.nextHandVotes = null;
    room.rematchVotes = null;
    room.players.forEach(p => { p.ready = false; });
    cb?.({ ok: true });
    io.to(room.code).emit('lobby:reopened');
    broadcastLobby(room);
  });
  // ── hint (F1.5, K1.B10) ──
  // The bot brain needs cloneGame()/real engine methods, so this runs server-side
  // (decision AD-2). We reply with ONLY the chosen action — tileId + end, both of
  // which the asking player can already derive from their own view.legalMoves.
  // No opponent hand, no boneyard order, ever leaves the server.
  // Quality: run at the strongest bot level seated at the table (hard if none).
  socket.on('game:hint', (_, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'playing' || room.game.turn !== playerId) {
      return cb?.({ ok: false });
    }
    const RANK = { easy: 0, medium: 1, hard: 2, expert: 3 };
    const lvl = room.players.filter(p => p.isBot && p.botLevel)
      .map(p => p.botLevel)
      .sort((a, b) => RANK[b] - RANK[a])[0] || 'hard';
    try {
      const action = chooseAction(room.game, playerId, { level: lvl });
      // Sanity gate: never hand back an illegal suggestion.
      if (action?.type === 'play') {
        const legal = room.game.legalMoves(playerId).some(m => m.tileId === action.tileId && m.end === action.end);
        if (!legal) return cb?.({ ok: false });
        return cb?.({ ok: true, type: 'play', tileId: action.tileId, end: action.end });
      }
      return cb?.({ ok: true, type: action?.type || 'pass' });
    } catch (err) {
      console.warn('game:hint failed', err?.message);
      return cb?.({ ok: false });
    }
  });

  // Vote-driven rematch (F2.2). The old handler was host-only, so if the host
  // walked away the whole table was stuck on the results screen forever.
  // Rules now: the host may start alone; anyone else votes, and the match
  // restarts once every OTHER human has voted (unanimous-minus-one).
  function doRematch(room) {
    room.continueVotes = null;
    room.rematchVotes = null;
    manager.rematch(room);
    io.to(room.code).emit('game:started');
    broadcastGame(room);
  }

  socket.on('game:rematch', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'matchEnd') return;
    const me = room.players.find(p => p.id === playerId);
    if (!me || me.isBot) return;                       // no seat, no vote

    if (playerId === room.hostId) return doRematch(room);  // host acts alone

    const humans = room.players.filter(p => !p.isBot);
    room.rematchVotes = room.rematchVotes || new Set();
    if (room.rematchVotes.has(playerId)) return;       // idempotent
    room.rematchVotes.add(playerId);

    io.to(room.code).emit('chat:msg', {
      from: 'النظام',
      text: `${me.name} عايز مباراة جديدة (${room.rematchVotes.size}/${humans.length})`,
    });

    // Unanimous minus the host (who can always act alone anyway).
    if (room.rematchVotes.size >= humans.length - 1) doRematch(room);
    else broadcastGame(room);                          // surface the vote counter
  });

  // ---- chat ----

  // Simple per-socket rate limit: max 5 messages per 3 seconds (prevents spam floods).
  let chatWindowStart = 0;
  let chatCount = 0;
  socket.on('chat:send', ({ text, emoji } = {}) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    const now = Date.now();
    if (now - chatWindowStart > 3000) { chatWindowStart = now; chatCount = 0; }
    if (++chatCount > 5) return;
    room.lastActivityAt = now; // chat keeps an idle lobby alive
    // Spectators may chat, visibly tagged so nobody mistakes them for players.
    if (currentCtx(socket).spectating) {
      const spec = (room.spectators || []).find(s => s.id === currentCtx(socket).spectatorId);
      if (!spec) return;
      const msg = { from: '👁 ' + spec.name, pid: playerId, at: now, spectator: true };
      if (typeof text === 'string' && text.trim()) msg.text = text.trim().slice(0, 200);
      else if (typeof emoji === 'string' && emoji.length <= 8) msg.emoji = emoji;
      else return;
      return io.to(room.code).emit('chat:msg', msg);
    }
    const p = room.players.find(p => p.id === playerId);
    if (!p) return;
    if (p.chatMuted) return; // host-muted chat — silently dropped
    const msg = { from: p.name, pid: p.id, at: now };
    if (typeof text === 'string' && text.trim()) msg.text = text.trim().slice(0, 200);
    else if (typeof emoji === 'string' && emoji.length <= 8) msg.emoji = emoji;
    else return;
    io.to(room.code).emit('chat:msg', msg);
  });

  // ---- disconnect ----

  socket.on('disconnect', () => {
    const s = sessions.get(socket.id);
    sessions.delete(socket.id);
    if (!s) return;
    const room = manager.getRoom(s.roomCode);
    if (!room) return;
    if (s.spectating) return manager.removeSpectator(room, s.spectatorId);
    const p = room.players.find(p => p.id === s.playerId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    p.chatMuted = false; // disconnect is a full cleanup — rejoiners start clean

    // In lobby: remove the player after grace period (allows quick page refresh)
    if (room.state === 'lobby') {
      setTimeout(() => {
        // S6: re-validate room identity — the room may have been deleted and its
        // CODE recycled by a brand-new room; removePlayer deletes by code, and
        // firing on a stale object used to kill the unrelated new room.
        if (manager.getRoom(room.code) !== room) return;
        if (!p.connected) {
          const res = manager.removePlayer(room, p.id);
          if (res.empty) return;
          broadcastLobby(room);
        }
      }, 5000);
    } else {
      // host migration for ongoing games (a bot must never become host)
      if (room.hostId === p.id) {
        const next = room.players.find(x => x.connected && !x.isBot);
        if (next) room.hostId = next.id;
      }
      if (room.players.every(x => !x.connected || x.isBot)) {
        setTimeout(() => {
          if (manager.getRoom(room.code) === room &&
              room.players.every(x => !x.connected || x.isBot)) {
            deleteRoom(room);
          }
        }, 15000);
      }
      broadcastGame(room);
    }
  });
});

http.listen(PORT, () => {
  console.log(`\n  🁢 DOMINO ARENA running at http://localhost:${PORT}`);
  console.log(`  Share it: cloudflared tunnel --url http://localhost:${PORT}\n`);
});

// Mobile: the embedded launcher can stop the server in-process — the host-yield
// path (a superior rival host appeared on the LAN). Unused on desktop.
globalThis.__dominoStop = () => {
  try { io.close(); } catch {}
  try { http.close(); } catch {}
};
