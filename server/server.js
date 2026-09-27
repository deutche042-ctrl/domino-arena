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
  res.json({ port: PORT, ips, rooms, players });
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

function broadcastLobby(room) {
  io.to(room.code).emit('lobby:state', manager.lobbyState(room));
}

function broadcastGame(room) {
  armTurnTimer(room);
  scheduleBotTurn(room);
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
  if (room.turnTimer && room.turnTimerPid === game.turn) return;
  clearTurnTimer(room);
  room.turnTimerPid = game.turn;
  room.turnEndsAt = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), TURN_MS);
}

function handleTurnTimeout(room) {
  clearTurnTimer(room);
  if (manager.getRoom(room.code) !== room) return;
  const game = room.game;
  if (!game || game.status !== 'playing') return;
  const pid = game.turn;
  const p = room.players.find(x => x.id === pid);
  const name = p ? p.name : 'لاعب';
  let msg;
  try {
    if (game.legalMoves(pid).length > 0) {
      game.forceSkip(pid);
      msg = `⏰ انتهى وقت ${name} — تم تخطي دوره`;
    } else if (game.canDraw(pid)) {
      game.draw(pid);
      msg = `⏰ انتهى وقت ${name} — تم سحب كارت ليه تلقائياً`;
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

// ---- voice chat (WebRTC signaling) ----
// The server only relays SDP/ICE between players and tracks who is in voice —
// the audio itself flows peer-to-peer. Voice state lives on the player object
// (p.voice / p.voiceMuted / p.hostMuted), is room-scoped so it survives
// lobby→game, and is dropped on leave/disconnect. p.hostMuted is the
// host-enforced mute: set/cleared only by the host via voice:hostMute, it can't
// be lifted by the target's own voice:mute, and it resets on leave/disconnect
// so a rejoining player starts clean. Bots never join voice.

function voiceRoster(room) {
  return room.players
    .filter(p => p.voice && !p.isBot)
    .map(p => ({
      id: p.id,
      name: p.name,
      muted: !!(p.voiceMuted || p.hostMuted), // effective mute
      hostMuted: !!p.hostMuted,
    }));
}

function broadcastVoice(room) {
  io.to(room.code).emit('voice:state', voiceRoster(room));
}

function currentCtx(socket) {
  const s = sessions.get(socket.id);
  if (!s) return {};
  const room = manager.getRoom(s.roomCode);
  return { room, playerId: s.playerId };
}

// ---- bots ----
// Bots are seated server-side with no socket. Every broadcast that leaves the
// turn on a bot arms a short timer; when it fires, the bot's brain
// (engine/bot.js, public info only) picks the action and the engine executes it.
// The timer re-validates on fire (room alive, same game object, same turn) —
// same hygiene as the turn timer above.

const BOT_NAMES = ['بوت حسن', 'بوت نور', 'بوت كريم', 'بوت سلمى', 'بوت زيكو', 'بوت ميرا'];
const BOT_EMOJIS = ['🔥', '😂', '👏', '😎', '🤔', '😅', '🎉'];

function scheduleBotTurn(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  const game = room.game;
  if (!game || game.status !== 'playing') return;
  const bot = room.players.find(p => p.id === game.turn);
  if (!bot || !bot.isBot) return;
  const captured = { game, turn: game.turn };
  const delay = room.botDelayMs || 600 + Math.floor(Math.random() * 800);
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
  const action = chooseAction(game, pid, { level: bot.botLevel || 'medium' });
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
  botChatter(room, bot, action);
  broadcastGame(room);   // re-broadcasts and chains to the next bot turn/draw
}

function botChatter(room, bot, action) {
  if (action.type !== 'play' || Math.random() >= 0.08) return;
  const now = Date.now();
  if (bot.lastChatAt && now - bot.lastChatAt < 8000) return;
  bot.lastChatAt = now;
  io.to(room.code).emit('chat:msg', {
    from: bot.name, pid: bot.id, at: now,
    emoji: BOT_EMOJIS[Math.floor(Math.random() * BOT_EMOJIS.length)],
  });
}

function deleteRoom(room) {
  clearTurnTimer(room);
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  manager.rooms.delete(room.code);
}

io.on('connection', (socket) => {
  // ---- lobby ----

  socket.on('room:create', ({ name, vsBots, botLevel, botDelayMs } = {}, cb) => {
    // Unbounded room creation would let any LAN peer memory-DoS the host phone.
    if (manager.rooms.size >= (Number(process.env.MAX_ROOMS) || 50)) {
      cb?.({ ok: false, error: 'الغرف كتير أوي على الخادم — جرب كمان شوية' });
      return;
    }
    const { room, player } = manager.createRoom(name);
    player.socketId = socket.id;
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    if (vsBots) {
      // Instant bot match: fill the table, deal, and let the scheduler drive.
      const d = Number(botDelayMs);
      room.botDelayMs = Number.isFinite(d) && d >= 25 ? d : null;
      const names = [...BOT_NAMES];
      for (let i = 0; i < 3 && room.players.length < room.config.maxPlayers; i++) {
        manager.addBot(room, names.splice(Math.floor(Math.random() * names.length), 1)[0], botLevel);
      }
      manager.startGame(room);
    }
    cb?.({
      ok: true, code: room.code, playerId: player.id, token: player.token,
      state: room.state, lobby: manager.lobbyState(room),
    });
    // Freshly loaded page: unicast the current voice roster (empty for a new room).
    socket.emit('voice:state', voiceRoster(room));
    if (vsBots) {
      io.to(room.code).emit('game:started');
      broadcastGame(room);
    } else {
      broadcastLobby(room);
    }
  });

  socket.on('room:join', ({ code, name, token } = {}, cb) => {
    const res = manager.joinRoom(code, name, token);
    if (res.error) return cb?.({ ok: false, error: res.error });
    const { room, player } = res;
    // If this player was attached to another socket (refresh), detach the old one
    if (player.socketId && player.socketId !== socket.id) {
      sessions.delete(player.socketId);
      io.sockets.sockets.get(player.socketId)?.leave(room.code);
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    cb?.({
      ok: true, code: room.code, playerId: player.id, token: player.token,
      reconnected: !!res.reconnected, state: room.state,
      lobby: manager.lobbyState(room),
    });
    // Freshly loaded / reconnected page: unicast who is already in voice.
    socket.emit('voice:state', voiceRoster(room));
    broadcastLobby(room);
    if (room.state === 'playing') broadcastGame(room);
  });

  // Leave the room entirely (lobby: remove player; in-game: mark disconnected)
  socket.on('room:leave', (_, cb) => {
    const s = sessions.get(socket.id);
    if (!s) return cb?.({ ok: true });
    sessions.delete(socket.id);
    const room = manager.getRoom(s.roomCode);
    socket.leave(s.roomCode);
    if (!room) return cb?.({ ok: true });
    const p = room.players.find(p => p.id === s.playerId);
    if (p) {
      const hadVoice = !!p.voice;
      p.voice = false;
      p.voiceMuted = false;
      p.hostMuted = false;
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
          // No humans left — bots can't keep a room (or a match) alive.
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
      if (hadVoice && manager.getRoom(room.code) === room) broadcastVoice(room);
    }
    cb?.({ ok: true });
  });

  socket.on('lobby:config', (config = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه تعديل الإعدادات.' });
    if (room.state !== 'lobby') return;
    const { variant, targetScore, maxPlayers } = config;
    if (['block', 'draw', 'allfives'].includes(variant)) room.config.variant = variant;
    if ([50, 100, 150, 200, 250].includes(targetScore)) room.config.targetScore = targetScore;
    if ([2, 3, 4].includes(maxPlayers) && maxPlayers >= room.players.length)
      room.config.maxPlayers = maxPlayers;
    cb?.({ ok: true });
    broadcastLobby(room);
  });

  socket.on('lobby:ready', ({ ready } = {}) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    const p = room.players.find(p => p.id === playerId);
    if (p) p.ready = !!ready;
    broadcastLobby(room);
  });

  socket.on('lobby:addBot', ({ level } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه إضافة بوت.' });
    const res = manager.addBot(room, BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], level);
    if (res.error) return cb?.({ ok: false, error: res.error });
    cb?.({ ok: true, lobby: manager.lobbyState(room) });
    broadcastLobby(room);
  });

  socket.on('lobby:removeBot', ({ playerId: botId } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه حذف البوت.' });
    const removed = manager.removeBot(room, botId);
    cb?.({ ok: removed });
    if (removed) broadcastLobby(room);
  });

  socket.on('game:start', (_, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    if (playerId !== room.hostId) return cb?.({ ok: false, error: 'فقط المضيف يمكنه بدء اللعبة.' });
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
    const { room, playerId } = currentCtx(socket);
    if (!room?.game) return;
    try {
      fn(room.game, playerId);
    } catch (e) {
      if (e instanceof IllegalMove) {
        socket.emit('error', { code: 'illegal', message: e.message });
        return;
      }
      throw e;
    }
    broadcastGame(room);
  };

  socket.on('game:play', ({ tileId, end } = {}) => {
    if (typeof tileId !== 'string') return;
    doAction((game, pid) => game.play(pid, tileId, end ?? null));
  });

  socket.on('game:draw', () => doAction((game, pid) => game.draw(pid)));
  socket.on('game:pass', () => doAction((game, pid) => game.pass(pid)));

  socket.on('game:nextHand', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'handEnd') return;
    if (playerId !== room.hostId) return;
    manager.nextHand(room);
    broadcastGame(room);
  });

  socket.on('game:rematch', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room?.game || room.game.status !== 'matchEnd') return;
    if (playerId !== room.hostId) return;
    manager.rematch(room);
    io.to(room.code).emit('game:started');
    broadcastGame(room);
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
    const p = room.players.find(p => p.id === playerId);
    if (!p) return;
    const msg = { from: p.name, pid: p.id, at: now };
    if (typeof text === 'string' && text.trim()) msg.text = text.trim().slice(0, 200);
    else if (typeof emoji === 'string' && emoji.length <= 8) msg.emoji = emoji;
    else return;
    io.to(room.code).emit('chat:msg', msg);
  });

  // ---- voice ----

  socket.on('voice:join', (_, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة عشان تفتح المايك.' });
    const p = room.players.find(p => p.id === playerId);
    if (!p || p.isBot) return cb?.({ ok: false });
    p.voice = true;
    p.voiceMuted = false;
    // p.hostMuted is intentionally NOT cleared here: a host-muted player who
    // re-opens their mic stays muted until the host lifts it.
    cb?.({ ok: true });
    broadcastVoice(room);
  });

  socket.on('voice:leave', () => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    const p = room.players.find(p => p.id === playerId);
    if (!p) return;
    // Leaving voice is a full cleanup: it also lifts any host-enforced mute.
    const wasInVoice = !!p.voice;
    p.voice = false;
    p.voiceMuted = false;
    p.hostMuted = false;
    if (wasInVoice) broadcastVoice(room);
  });

  socket.on('voice:mute', ({ muted } = {}) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    const p = room.players.find(p => p.id === playerId);
    if (!p || !p.voice) return;
    const want = !!muted;
    // A host-enforced mute can't be lifted by the target — ignore silently.
    if (p.hostMuted && !want) return;
    if (p.voiceMuted === want) return; // nothing changed — skip the rebroadcast
    p.voiceMuted = want;
    broadcastVoice(room);
  });

  // Host-enforced mute ("mute for everyone"): only the room host (never a bot)
  // can set or clear p.hostMuted. `all` hits every voice participant except the
  // host himself; `pid` can target anyone in the room — including players not
  // currently in voice, so they join muted later.
  socket.on('voice:hostMute', ({ pid, all, muted } = {}, cb) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return cb?.({ ok: false, error: 'لازم تكون جوه غرفة عشان تكتم اللاعبين.' });
    const host = room.players.find(p => p.id === playerId);
    if (playerId !== room.hostId || !host || host.isBot) {
      return cb?.({ ok: false, error: 'المضيف بس اللي يقدر يكتم اللاعبين.' });
    }
    const want = !!muted;
    if (all) {
      for (const p of room.players) {
        if (p.isBot || !p.voice || p.id === room.hostId) continue;
        p.hostMuted = want;
      }
    } else if (typeof pid === 'string') {
      const target = room.players.find(p => p.id === pid);
      if (!target) return cb?.({ ok: false, error: 'اللاعب مش موجود في الغرفة.' });
      target.hostMuted = want;
    } else {
      return cb?.({ ok: false, error: 'لازم تحدد لاعب أو تختار كتم الكل.' });
    }
    cb?.({ ok: true });
    broadcastVoice(room);
  });

  // Relay a WebRTC offer/answer/ICE candidate to one specific player.
  socket.on('voice:signal', ({ to, data } = {}) => {
    const { room, playerId } = currentCtx(socket);
    if (!room || typeof to !== 'string' || !data) return;
    const from = room.players.find(p => p.id === playerId);
    const target = room.players.find(p => p.id === to);
    // Both ends must be voice participants — no signaling to outsiders.
    if (!from?.voice || !target?.voice || !target.socketId) return;
    io.to(target.socketId).emit('voice:signal', { from: playerId, data });
  });

  // ---- disconnect ----

  socket.on('disconnect', () => {
    const s = sessions.get(socket.id);
    sessions.delete(socket.id);
    if (!s) return;
    const room = manager.getRoom(s.roomCode);
    if (!room) return;
    const p = room.players.find(p => p.id === s.playerId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    // Voice is tied to the live socket — drop it now; a reconnected client
    // re-announces itself with voice:join and the mesh rebuilds. Disconnect is
    // a full cleanup: voiceMuted and hostMuted both reset (clean slate).
    const hadVoice = !!p.voice;
    p.voice = false;
    p.voiceMuted = false;
    p.hostMuted = false;
    if (hadVoice) broadcastVoice(room);

    // In lobby: remove the player after grace period (allows quick page refresh)
    if (room.state === 'lobby') {
      setTimeout(() => {
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
