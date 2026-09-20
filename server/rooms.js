// server/rooms.js — room lifecycle, lobby, per-player state projection
import { randomUUID } from 'node:crypto';
import { DominoGame } from '../engine/game.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing chars

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> room
  }

  createRoom(hostName) {
    let code;
    do { code = makeCode(); } while (this.rooms.has(code));
    const player = this._newPlayer(hostName);
    const room = {
      code,
      hostId: player.id,
      state: 'lobby', // 'lobby' | 'playing'
      config: { variant: 'draw', targetScore: 100, maxPlayers: 4 },
      players: [player],
      game: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    return { room, player };
  }

  joinRoom(code, name, token) {
    const room = this.rooms.get((code || '').toUpperCase().trim());
    if (!room) return { error: 'الغرفة غير موجودة. تأكد من صحة الكود.' };
    // Reconnect by token?
    if (token) {
      const existing = room.players.find(p => p.token === token);
      if (existing) {
        if (name && name !== existing.name) existing.name = name.slice(0, 16);
        return { room, player: existing, reconnected: true };
      }
    }
    if (room.state !== 'lobby') return { error: 'بدأت اللعبة بالفعل في هذه الغرفة.' };
    if (room.players.length >= room.config.maxPlayers) return { error: 'الغرفة ممتلئة بالكامل.' };
    const player = this._newPlayer(name);
    room.players.push(player);
    return { room, player };
  }

  getRoom(code) { return this.rooms.get((code || '').toUpperCase().trim()); }

  startGame(room) {
    room.game = new DominoGame({
      variant: room.config.variant,
      playerIds: room.players.map(p => p.id),
      targetScore: room.config.targetScore,
    });
    room.state = 'playing';
    room.players.forEach(p => { p.ready = false; });
  }

  nextHand(room) {
    if (room.game) room.game.nextHand();
  }

  rematch(room) {
    this.startGame(room);
  }

  removePlayer(room, playerId) {
    room.players = room.players.filter(p => p.id !== playerId);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return { empty: true };
    }
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    return { empty: false, newHost: room.hostId };
  }

  lobbyState(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      config: room.config,
      players: room.players.map(p => ({
        id: p.id, name: p.name, ready: p.ready, connected: p.connected,
      })),
    };
  }

  /** Full per-player game view with names merged in. */
  gameView(room, playerId) {
    if (!room.game) return null;
    const view = room.game.viewFor(playerId);
    view.names = Object.fromEntries(room.players.map(p => [p.id, p.name]));
    view.connected = Object.fromEntries(room.players.map(p => [p.id, p.connected]));
    view.roomCode = room.code;
    view.hostId = room.hostId;
    return view;
  }

  _newPlayer(name) {
    const id = randomUUID();
    return {
      id,
      token: randomUUID(),
      name: (name || 'Player').slice(0, 16),
      ready: false,
      connected: true,
      socketId: null,
    };
  }
}
