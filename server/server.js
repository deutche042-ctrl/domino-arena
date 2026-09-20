// server/server.js — Express static host + Socket.IO realtime game server
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RoomManager } from './rooms.js';
import { IllegalMove } from '../engine/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, maxAge: 0 }));

const http = createServer(app);
const io = new Server(http, {
  // long-polling fallback keeps the game working through any tunnel/proxy
  transports: ['websocket', 'polling'],
});

const manager = new RoomManager();

// socket.id -> { roomCode, playerId }
const sessions = new Map();

function broadcastLobby(room) {
  io.to(room.code).emit('lobby:state', manager.lobbyState(room));
}

function broadcastGame(room) {
  for (const p of room.players) {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit('game:state', manager.gameView(room, p.id));
    }
  }
}

function currentCtx(socket) {
  const s = sessions.get(socket.id);
  if (!s) return {};
  const room = manager.getRoom(s.roomCode);
  return { room, playerId: s.playerId };
}

io.on('connection', (socket) => {
  // ---- lobby ----

  socket.on('room:create', ({ name } = {}, cb) => {
    const { room, player } = manager.createRoom(name);
    player.socketId = socket.id;
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    cb?.({
      ok: true, code: room.code, playerId: player.id, token: player.token,
      lobby: manager.lobbyState(room),
    });
    broadcastLobby(room);
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
    broadcastLobby(room);
    if (room.state === 'playing') broadcastGame(room);
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

  socket.on('chat:send', ({ text, emoji } = {}) => {
    const { room, playerId } = currentCtx(socket);
    if (!room) return;
    const p = room.players.find(p => p.id === playerId);
    const msg = { from: p.name, pid: p.id, at: Date.now() };
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
    const p = room.players.find(p => p.id === s.playerId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;

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
      // host migration for ongoing games
      if (room.hostId === p.id) {
        const next = room.players.find(x => x.connected);
        if (next) room.hostId = next.id;
      }
      broadcastGame(room);
    }
  });
});

http.listen(PORT, () => {
  console.log(`\n  🁢 DOMINO ARENA running at http://localhost:${PORT}`);
  console.log(`  Share it: cloudflared tunnel --url http://localhost:${PORT}\n`);
});
