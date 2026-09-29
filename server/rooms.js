// server/rooms.js — room lifecycle, lobby, per-player state projection
import { randomUUID } from 'node:crypto';
import { DominoGame } from '../engine/game.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing chars

// Per-turn time limit shared with clients. The enforcement timer itself lives in
// server.js (the engine must stay timer-free); this is the single source of truth.
export const TURN_MS = Math.max(1000, Number(process.env.TURN_TIME_MS) || 30000);
// Lobby-selectable per-turn limits (server.js reads config.turnMs || TURN_MS).
// 0 means "no timer at all" (F2.1) — a deliberate house-rule choice.
const TURN_MS_OPTIONS = [0, 10000, 20000, 30000, 60000];
// Lobby-selectable hand sizes (F2.1); null = let the variant/player-count decide.
const HAND_SIZE_OPTIONS = [5, 7, 9];
// F4.2 bot difficulty + personality allowlists (single source of truth).
export const BOT_LEVELS = ['easy', 'medium', 'hard', 'expert'];
export const BOT_PROFILES = ['balanced', 'aggressive', 'defensive'];

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
      // F2.1 house rules. Every field is mirrored into the engine on startGame,
      // so changing one in the lobby affects real rules, not just the UI.
      //  - handSize:   null → variant/player-count default (DEFAULT_HAND)
      //  - targetScore: null → variant/player-count engine default (K2.S2 —
      //    All Fives plays 250 heads-up / 200 for 3-4P unless the host picks)
      //  - allowPass:  false → a stuck player can only be rescued by the timer
      //  - keepLastTwo: true → the final 2 boneyard tiles are never drawable
      //  - turnMs:     null → TURN_MS; 0 → no turn timer at all
      config: {
        variant: 'draw', targetScore: null, maxPlayers: 4,
        handSize: null, allowPass: true, keepLastTwo: false, turnMs: null,
      },
      players: [player],
      game: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    return { room, player };
  }

  joinRoom(code, name, token, opts = {}) {
    const room = this.rooms.get((code || '').toUpperCase().trim());
    if (!room) return { error: 'الغرفة غير موجودة. تأكد من صحة الكود.' };
    // Reconnect by token?
    if (token) {
      if (this.isKicked(room, token)) return { error: 'تم طردك من هذه الغرفة.' };
      const existing = room.players.find(p => p.token === token);
      if (existing) {
        if (name && name !== existing.name) existing.name = name.slice(0, 16);
        return { room, player: existing, reconnected: true };
      }
    }
    if (room.state !== 'lobby') {
      if (opts.allowSpectate) {
        const res = this.addSpectator(room, name);
        if (res.error) return { error: res.error };
        return { room, spectator: res.spectator, spectating: true };
      }
      return { error: 'بدأت اللعبة بالفعل في هذه الغرفة.' };
    }
    if (room.players.length >= room.config.maxPlayers) {
      if (opts.allowSpectate) {
        const res = this.addSpectator(room, name);
        if (res.error) return { error: res.error };
        return { room, spectator: res.spectator, spectating: true };
      }
      return { error: 'الغرفة ممتلئة بالكامل.' };
    }
    const player = this._newPlayer(name);
    if (this.isKicked(room, player.id)) return { error: 'تم طردك من هذه الغرفة.' };
    room.players.push(player);
    return { room, player };
  }

  /** Host-only kick: removes the player and refuses rejoin attempts (by id or
   *  token) for the life of the room. Not for bots (use removeBot) or the host. */
  kickPlayer(room, playerId) {
    const target = room.players.find(p => p.id === playerId);
    if (!target) return { error: 'اللاعب مش موجود في الغرفة.' };
    if (target.isBot) return { error: 'استخدم زرار حذف البوت.' };
    if (target.id === room.hostId) return { error: 'مينفعش تطرد نفسك!' };
    room.kicked = room.kicked || new Set();
    room.kicked.add(target.id);
    if (target.token) room.kicked.add(target.token);
    room.players = room.players.filter(p => p.id !== playerId);
    if (room.players.length === 0 || !room.players.some(p => !p.isBot)) {
      this.rooms.delete(room.code);
      return { empty: true };
    }
    return { kicked: target };
  }

  isKicked(room, idOrToken) {
    return !!room.kicked && room.kicked.has(idOrToken);
  }

  /** Spectators ride along: they see every game state but hold no seat. */
  addSpectator(room, name) {
    room.spectators = room.spectators || [];
    if (room.spectators.length >= 8) return { error: 'الغرفة وصلت لأقصى عدد متفرجين.' };
    const spectator = {
      id: randomUUID(),
      name: (name || 'متفرج').slice(0, 16),
      socketId: null,
    };
    room.spectators.push(spectator);
    return { spectator };
  }

  removeSpectator(room, spectatorId) {
    if (!room.spectators) return;
    room.spectators = room.spectators.filter(s => s.id !== spectatorId);
  }

  getRoom(code) { return this.rooms.get((code || '').toUpperCase().trim()); }

  /** Seat a bot player (lobby only). Bots are always ready and never own a
   *  token, so the token-reconnect path can never attach a socket to them.
   *  F4.2: `level` ∈ easy|medium|hard|expert, `profile` ∈ PROFILES (balanced default). */
  addBot(room, name, level = 'medium', profile = 'balanced') {
    if (room.state !== 'lobby') return { error: 'بدأت اللعبة بالفعل في هذه الغرفة.' };
    if (room.players.length >= room.config.maxPlayers) return { error: 'الغرفة ممتلئة بالكامل.' };
    const bot = {
      id: randomUUID(),
      token: null,
      name: (name || 'بوت').slice(0, 16),
      ready: true,
      connected: true,
      socketId: null,
      isBot: true,
      botLevel: BOT_LEVELS.includes(level) ? level : 'medium',
      botProfile: BOT_PROFILES.includes(profile) ? profile : 'balanced',
    };
    room.players.push(bot);
    return { bot };
  }

  removeBot(room, botId) {
    const before = room.players.length;
    room.players = room.players.filter(p => p.id !== botId || !p.isBot);
    return room.players.length < before;
  }

  hasHumans(room) {
    return room.players.some(p => !p.isBot);
  }

  startGame(room) {
    // K2.S1: the deck has 28 tiles — a hand-size override must fit every player
    // (9 is fine up to 3 players; 4 players cap at 7). The engine also validates.
    const fit = Math.floor(28 / Math.max(2, room.players.length));
    const handSize = room.config.handSize ? Math.min(room.config.handSize, fit) : undefined;
    room.game = new DominoGame({
      variant: room.config.variant,
      playerIds: room.players.map(p => p.id),
      targetScore: room.config.targetScore,
      // F2.1 house rules (undefined falls back to the engine default).
      handSize,
      allowPass: room.config.allowPass,
      keepLastTwo: room.config.keepLastTwo,
    });
    room.state = 'playing';
    room.continueVotes = null;
    room.nextHandVotes = null;                // K2.S5: binding next-hand votes
    room.rematchVotes = null;                 // F2.2: votes are per-match
    room.players.forEach(p => { p.ready = false; });
  }

  nextHand(room) {
    if (room.game) room.game.nextHand();
  }

  rematch(room) {
    this.startGame(room);
  }

  /** Sanitized config for lobby:config — every value clamped to a known-good choice. */
  sanitizeConfig(cfg = {}) {
    const out = {};
    if (cfg.variant) out.variant = String(cfg.variant);
    // K2.S2: explicit null clears the override back to the engine default.
    if (cfg.targetScore !== undefined) {
      out.targetScore = cfg.targetScore == null
        ? null
        : Math.max(10, Math.min(500, Number(cfg.targetScore) || 100));
    }
    if (cfg.maxPlayers != null) out.maxPlayers = Math.max(2, Math.min(4, Number(cfg.maxPlayers) || 4));
    if (cfg.turnMs != null) {
      const want = Number(cfg.turnMs);
      out.turnMs = TURN_MS_OPTIONS.includes(want) ? want : TURN_MS;
    }
    // F2.1 house rules. Booleans are coerced strictly; handSize only accepts a
    // listed size, and `null`/'' clears the override back to the variant default.
    if (cfg.allowPass != null) out.allowPass = cfg.allowPass === true || cfg.allowPass === 'true';
    if (cfg.keepLastTwo != null) out.keepLastTwo = cfg.keepLastTwo === true || cfg.keepLastTwo === 'true';
    if (cfg.handSize !== undefined) {
      if (cfg.handSize == null || cfg.handSize === '') out.handSize = null;
      else {
        const want = Number(cfg.handSize);
        out.handSize = HAND_SIZE_OPTIONS.includes(want) ? want : null;
      }
    }
    return out;
  }

  removePlayer(room, playerId) {
    room.players = room.players.filter(p => p.id !== playerId);
    // Bots alone can't keep a room alive.
    if (room.players.length === 0 || !room.players.some(p => !p.isBot)) {
      this.rooms.delete(room.code);
      return { empty: true };
    }
    if (room.hostId === playerId) room.hostId = room.players.find(p => !p.isBot).id;
    return { empty: false, newHost: room.hostId };
  }

  lobbyState(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      config: room.config,
      // K2.S11: make spectators visible in the lobby (client shows a chip).
      spectators: (room.spectators || []).map(s => ({ id: s.id, name: s.name })),
      players: room.players.map(p => ({
        id: p.id, name: p.name, ready: p.ready, connected: p.connected, isBot: !!p.isBot,
        chatMuted: !!p.chatMuted,
        // F4.2: surfaced so the lobby can label a seated bot ("hard · aggressive").
        botLevel: p.isBot ? (p.botLevel || 'medium') : undefined,
        botProfile: p.isBot ? (p.botProfile || 'balanced') : undefined,
      })),
    };
  }

  /** Full per-player game view with names merged in. */
  gameView(room, playerId) {
    if (!room.game) return null;
    const view = room.game.viewFor(playerId);
    view.playerId = playerId;   // K2.S12: which seat this view belongs to
    view.names = Object.fromEntries(room.players.map(p => [p.id, p.name]));
    view.connected = Object.fromEntries(room.players.map(p => [p.id, p.connected]));
    view.isBot = Object.fromEntries(room.players.map(p => [p.id, !!p.isBot]));
    view.roomCode = room.code;
    view.hostId = room.hostId;
    // advisory continue-votes (nextHand/rematch): human vote count + humans seated
    if (room.continueVotes) {
      const humans = room.players.filter(p => !p.isBot).length;
      for (const kind of ['nextHand', 'rematch']) {
        const set = room.continueVotes[kind];
        if (set?.size) view[`${kind}Votes`] = { count: set.size, humans };
      }
    }
    // K2.S5: binding next-hand votes (unanimous minus host) reuse the same view
    // surface as the old advisory counter, so the client needs no changes.
    if (room.nextHandVotes?.size) {
      view.nextHandVotes = {
        count: room.nextHandVotes.size,
        humans: room.players.filter(p => !p.isBot).length,
      };
    }
    // F2.2: who (by name) has voted for a rematch, so the end-of-match modal can
    // show real names instead of a bare counter.
    const rematchWho = [...(room.rematchVotes || [])]
      .map(id => room.players.find(p => p.id === id)?.name)
      .filter(Boolean);
    view.rematchVotes = rematchWho;
    view.rematchVoters = [...(room.rematchVotes || [])];
    view.humanCount = room.players.filter(p => !p.isBot).length;
    // Turn countdown (server clock epoch ms). serverNow lets clients correct for clock skew.
    // turnMs 0 means "no timer" — the client hides the countdown entirely (F2.1).
    view.turnEndsAt = room.turnEndsAt || null;
    view.turnMs = room.config.turnMs ?? TURN_MS;
    view.serverNow = Date.now();
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
