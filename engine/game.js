// engine/game.js — server-authoritative domino engine
// Variants: 'block' | 'draw' | 'allfives' (All Fives = Muggins/Five-Up with spinner)
// Pure logic, no IO. All state serializable.

import { buildDeck, shuffle, mulberry32, pips, isDouble } from './deck.js';

// F2.3: All Fives targets scale with the table size — a 4-player match reaches a
// given score far faster than heads-up, so a flat 250 made long games drag.
// 2P stays 250 (the classic), 3-4P use 200 (matches plan.md §2.3).
const DEFAULT_TARGET = { block: 100, draw: 100, allfives: { 2: 250, 3: 200, 4: 200 } };
const DEFAULT_HAND = {
  block:   { 2: 7, 3: 5, 4: 5 },
  draw:    { 2: 7, 3: 5, 4: 5 },
  allfives:{ 2: 7, 3: 7, 4: 5 },
};

/** Resolve a DEFAULT_TARGET entry that may be a plain number or a per-count map. */
function targetFor(target, playerCount) {
  if (typeof target === 'number') return target;
  return target[playerCount] ?? target[2];
}
// Consecutive scoreless (blocked + pip-tie) hands before a stalled match is called.
// Deliberately generous — see the comment in _endHand.
const STALL_GUARD_HANDS = 8;

// F3.2: derived-ends cache, kept OFF the instance so the engine stays purely
// serializable (JSON.stringify(game) must not include cache churn — bot.js clones
// games via JSON and the anti-cheat test asserts chooseAction mutates nothing).
// ENDS_CACHE: game instance → { rev, ends }
// REV:        game instance → revision counter, bumped by every mutation
const ENDS_CACHE = new WeakMap();
const REV = new WeakMap();

export class IllegalMove extends Error {}

export class DominoGame {
  /**
   * @param {object} opt
   *  variant: 'block'|'draw'|'allfives'
   *  playerIds: string[2..4]
   *  targetScore?: number
   *  handSize?: number (override)
   *  allowPass?: boolean  (F2.1, default true) — false forbids passing entirely
   *  keepLastTwo?: boolean (F2.1, default false) — reserve the last 2 boneyard tiles
   *  seed?: number (shuffle seed)
   *  deal?: { hands: {pid: tileId[]}, boneyard: tileId[] } — test hook, skips shuffle
   */
  constructor(opt) {
    const { variant = 'block', playerIds } = opt;
    if (!['block', 'draw', 'allfives'].includes(variant)) throw new Error('bad variant');
    if (!Array.isArray(playerIds) || playerIds.length < 2 || playerIds.length > 4)
      throw new Error('need 2-4 players');
    this.variant = variant;
    this.playerIds = playerIds.slice();
    this.targetScore = opt.targetScore || targetFor(DEFAULT_TARGET[variant], playerIds.length);
    this.handSize = opt.handSize || DEFAULT_HAND[variant][playerIds.length];
    // K2.S1 backstop: the deck has 28 tiles — a lobby hand-size override that
    // doesn't fit every player would silently starve the last deal.
    if (playerIds.length * this.handSize > 28) throw new Error('hand size too large for this many players');
    // F2.1 house rules — persisted in room.config and re-applied on every hand
    // via _deal's `opt`, so they survive nextHand()/rematch().
    this.allowPass = opt.allowPass !== false;
    this.keepLastTwo = !!opt.keepLastTwo;
    this.scores = Object.fromEntries(playerIds.map(id => [id, 0]));
    this.status = 'playing';            // 'playing' | 'handEnd' | 'matchEnd'
    this.handNumber = 0;
    this.handResult = null;             // filled at handEnd
    this.matchWinnerId = null;
    this.lastAction = null;
    this._deal(opt);
  }

  // ---------- setup ----------

  _deal(opt) {
    this.handNumber++;
    this.moves = [];                    // [{t:{id,a,b}, e:'L'|'R'|'U'|'D'|null, f:0|1, p}]
    this.ends = { L: null, R: null, U: null, D: null }; // {match, score, tileId}
    this.spinner = null;                // { id, sidesFilled, value }
    this.passCount = 0;
    // K1.B7: public inference log — a player who passes (or is forced to draw)
    // provably holds no tile matching any open end value at that moment.
    // Recorded per hand; exposed through viewFor and used by the bot's trap term.
    this.passLog = [];
    this.handResult = null;
    this.forcedDrawTileId = null;       // Draw rules: a playable drawn tile must be played
    this.hands = {};
    let boneyard;
    if (opt.deal) {
      // Test hook. Ids are normalized ("5-1" → "1-5") so fixtures are forgiving.
      const norm = id => {
        const [a, b] = id.split('-').map(Number);
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      const all = new Map(buildDeck().map(t => [t.id, t]));
      const used = new Set();
      const take = (id, where) => {
        if (typeof id !== 'string') throw new Error(`deal hook: tile id must be a string, got ${typeof id}`);
        const t = all.get(norm(id));
        // A ghost tile ({...undefined} → {}) would poison handPips with NaN and
        // silently corrupt the blocked-hand tiebreak — fail loudly instead.
        if (!t) throw new Error(`deal hook: unknown tile id "${id}" (${where})`);
        if (used.has(t.id)) throw new Error(`deal hook: duplicate tile "${id}" (${where})`);
        used.add(t.id);
        return { ...t };
      };
      for (const pid of this.playerIds) {
        const list = opt.deal.hands[pid];
        if (!Array.isArray(list)) throw new Error(`deal hook: hands[${pid}] must be an array`);
        this.hands[pid] = list.map(id => take(id, `hand ${pid}`));
      }
      boneyard = (opt.deal.boneyard || []).map(id => take(id, 'boneyard'));
    } else {
      const rng = mulberry32(opt.seed ?? ((Math.random() * 2 ** 32) >>> 0));
      const deck = shuffle(buildDeck(), rng);
      let i = 0;
      for (const pid of this.playerIds) {
        this.hands[pid] = deck.slice(i, i + this.handSize);
        i += this.handSize;
      }
      boneyard = deck.slice(i);
    }
    this.boneyard = boneyard;

    // Who leads?
    if (this.handNumber === 1 || !this._lastHandWinner) {
      // Highest double leads; fallback: highest pip tile (first found on ties).
      let best = null, bestPid = null, bestKey = -1;
      for (const pid of this.playerIds) {
        for (const t of this.hands[pid]) {
          const key = isDouble(t) ? 100 + t.a : pips(t) / 100;
          if (key > bestKey) { bestKey = key; best = t; bestPid = pid; }
        }
      }
      this.turn = bestPid;
      this.leadForcedTile = best.id;    // first move of the hand must be this tile
    } else {
      this.turn = this._lastHandWinner;
      this.leadForcedTile = null;       // hand winner may lead any tile
    }
    // E3: a fresh hand must invalidate the derived-ends cache — the revision
    // counter only moves on mutations, and `_deal` replaces the whole state, so
    // the first attachableEnds() after nextHand() used to cache-hit the
    // PREVIOUS hand's ends.
    this._invalidateEnds();
  }

  // ---------- queries ----------

  handPips(pid) { return this.hands[pid].reduce((s, t) => s + pips(t), 0); }

  /** Attachable ends with their match values. U/D only once spinner has both side tiles.
   *
   *  F3.2: `viewFor` calls this once per player per broadcast, so the result is cached.
   *  The cache lives in a module-level WeakMap rather than on `this`, for two reasons:
   *    1. the engine must stay purely serializable — `JSON.stringify(game)` is used by
   *       bot.js (cloneGame) and by the "bot must not mutate the game" anti-cheat test,
   *       and a cache field on the instance would show up as a mutation;
   *    2. it must be invisible to anything that snapshots or clones the object.
   *  Invalidation is a revision counter: every mutation bumps `_rev(game)`, and a cached
   *  entry is only reused when its revision still matches. */
  attachableEnds() {
    const cached = ENDS_CACHE.get(this);
    const rev = REV.get(this) || 0;
    if (cached && cached.rev === rev) return cached.ends;

    const out = [];
    if (this.moves.length === 0) {
      // Empty table: a single "any tile" pseudo-end (end null = lead move).
      out.push({ end: null, match: null });
    } else {
      out.push({ end: 'L', match: this.ends.L.match }, { end: 'R', match: this.ends.R.match });
      if (this.variant === 'allfives' && this.spinner && this.spinner.sidesFilled >= 2) {
        const sv = this.spinner.value;   // stored at creation — no hand/boneyard lookup
        out.push({ end: 'U', match: this.ends.U ? this.ends.U.match : sv });
        out.push({ end: 'D', match: this.ends.D ? this.ends.D.match : sv });
      }
    }
    ENDS_CACHE.set(this, { rev, ends: out });
    return out;
  }

  /** Mark the derived-ends cache stale. Called from every state mutation. */
  _invalidateEnds() {
    REV.set(this, (REV.get(this) || 0) + 1);
  }

  legalMoves(pid) {
    const moves = [];
    const hand = this.hands[pid];
    if (this.moves.length === 0) {
      if (this.leadForcedTile) {
        return hand.some(t => t.id === this.leadForcedTile)
          ? [{ tileId: this.leadForcedTile, end: null }] : [];
      }
      return hand.map(t => ({ tileId: t.id, end: null }));
    }
    // Draw rules: once you draw a playable tile you must play THAT tile, and only it.
    if (this.forcedDrawTileId) {
      const t = hand.find(x => x.id === this.forcedDrawTileId);
      if (!t) return [];
      for (const { end, match } of this.attachableEnds()) {
        if (t.a === match || t.b === match) moves.push({ tileId: t.id, end });
      }
      return moves;
    }
    for (const { end, match } of this.attachableEnds()) {
      for (const t of hand) {
        if (t.a === match || t.b === match) moves.push({ tileId: t.id, end });
      }
    }
    return moves;
  }

  /** F2.1: how many boneyard tiles may actually be drawn right now.
   *  keepLastTwo reserves the final 2 tiles (a common house rule that keeps some
   *  tension at the end of a Draw hand instead of letting it drain to nothing). */
  drawableCount() {
    return this.keepLastTwo ? Math.max(0, this.boneyard.length - 2) : this.boneyard.length;
  }

  canDraw(pid) {
    return this.variant !== 'block' && this.drawableCount() > 0 &&
           this.legalMoves(pid).length === 0 && this.status === 'playing';
  }

  canPass(pid) {
    if (this.status !== 'playing' || this.legalMoves(pid).length > 0) return false;
    if (!this.allowPass) return false;              // F2.1 house rule
    return this.variant === 'block' || this.drawableCount() === 0;
  }

  /** Current total of open ends (All Fives). A double sitting at both ends (lead double) counts once. */
  endsTotal() {
    if (this.moves.length === 0) return 0;
    const seenDoubles = new Set();
    let total = 0;
    for (const k of ['L', 'R', 'U', 'D']) {
      const e = this.ends[k];
      if (!e) continue;
      if (e.dbl) {
        if (seenDoubles.has(e.tileId)) continue;
        seenDoubles.add(e.tileId);
      }
      total += e.score;
    }
    return total;
  }

  // ---------- actions ----------

  play(pid, tileId, end = null) {
    this._assertTurn(pid);
    const legal = this.legalMoves(pid);
    if (!legal.some(m => m.tileId === tileId && m.end === end))
      throw new IllegalMove(`illegal play ${tileId} on ${end}`);
    const tile = this._takeFromHand(pid, tileId);

    if (this.moves.length === 0) {
      // Lead tile: both ends are this tile. A lead double counts its full pips once (deduped in endsTotal).
      const dbl = isDouble(tile);
      this.ends.L = { match: tile.a, score: dbl ? pips(tile) : tile.a, tileId, dbl };
      this.ends.R = { match: tile.b, score: dbl ? pips(tile) : tile.b, tileId, dbl };
      if (dbl && this.variant === 'allfives') this.spinner = { id: tile.id, sidesFilled: 0, value: tile.a };
      this.moves.push({ t: tile, e: null, f: 0, p: pid });
    } else {
      const attach = this.attachableEnds().find(x => x.end === end);
      if (!attach) throw new IllegalMove('end not open');
      const f = tile.a === attach.match ? 0 : 1;   // 0: a attaches, 1: b attaches
      const outer = f === 0 ? tile.b : tile.a;
      // Covering the spinner's chain side?
      if ((end === 'L' || end === 'R') && this.spinner &&
          this.ends[end] && this.ends[end].tileId === this.spinner.id) {
        this.spinner.sidesFilled++;
      }
      this.ends[end] = {
        match: outer,
        score: isDouble(tile) ? pips(tile) : outer,
        tileId,
        dbl: isDouble(tile),
      };
      if (isDouble(tile) && !this.spinner && this.variant === 'allfives')
        this.spinner = { id: tile.id, sidesFilled: 1, value: tile.a };
      this.moves.push({ t: tile, e: end, f, p: pid });
    }

    this.passCount = 0;
    this.leadForcedTile = null;
    this.forcedDrawTileId = null;       // a move clears the draw restriction
    this._invalidateEnds();
    this.lastAction = { type: 'place', pid, tileId, end };

    // All Fives: immediate multiple-of-5 scoring
    let scored = 0;
    if (this.variant === 'allfives') {
      const total = this.endsTotal();
      if (total > 0 && total % 5 === 0) {
        scored = total;
        this.scores[pid] += total;
        this.lastAction.scored = total;
      }
      if (this.scores[pid] >= this.targetScore) return this._endMatch(pid);
    }

    if (this.hands[pid].length === 0) return this._endHand(pid, false);
    this._advanceTurn(pid);
    return { scored };
  }

  draw(pid) {
    this._assertTurn(pid);
    if (!this.canDraw(pid)) throw new IllegalMove('cannot draw now');    const tile = this.boneyard.pop();
    this.hands[pid].push(tile);
    this._invalidateEnds();
    this.lastAction = { type: 'draw', pid, count: 1, tileId: tile.id };

    // Draw rules: a drawn tile that fits an open end must be played right away.
    // (Otherwise a player could draw, keep the tile, and freely choose another.)
    const playable = this.moves.length === 0
      ? true
      : this.attachableEnds().some(e => e.match !== null && (tile.a === e.match || tile.b === e.match));
    this.forcedDrawTileId = playable ? tile.id : null;
    // Drawing was only legal because they had nothing playable — same public
    // inference as a pass (canDraw requires zero legal moves).
    this.passLog.push({ pid, ends: this._openEndValues(), kind: 'draw' });
    return tile;
  }

  /** Match values of every currently-open end (public info at this instant). */
  _openEndValues() {
    return this.attachableEnds().filter(e => e.match !== null).map(e => e.match);
  }

  pass(pid) {
    this._assertTurn(pid);
    if (!this.canPass(pid)) throw new IllegalMove('cannot pass now');
    this.passCount++;
    // forceSkip deliberately does NOT record: a skipped player may have had
    // legal moves (that is the timeout penalty), so nothing can be inferred.
    this.passLog.push({ pid, ends: this._openEndValues(), kind: 'pass' });
    this.forcedDrawTileId = null;
    this._invalidateEnds();
    this.lastAction = { type: 'pass', pid };
    if (this.passCount >= this.playerIds.length) return this._endHand(null, true);
    this._advanceTurn(pid);
  }

  /** Turn-timer support: the current player ran out of time, so their turn is
   *  force-skipped — legal even when they have moves, that is the penalty.
   *  Counts toward the blocked-hand pass limit so an all-AFK table still resolves. */
  forceSkip(pid) {
    this._assertTurn(pid);
    this.passCount++;
    this.forcedDrawTileId = null;
    this._invalidateEnds();
    this.lastAction = { type: 'skip', pid };
    if (this.passCount >= this.playerIds.length) return this._endHand(null, true);
    this._advanceTurn(pid);
  }

  /** Advance to the next hand after handEnd (winner leads). Keeps match scores. */
  nextHand(seed) {
    if (this.status !== 'handEnd') throw new Error('hand not over');
    this.status = 'playing';
    this._deal({ seed });
  }

  // ---------- per-player projection ----------

  viewFor(pid) {
    return {
      variant: this.variant,
      targetScore: this.targetScore,
      status: this.status,
      handNumber: this.handNumber,
      players: this.playerIds,
      turn: this.turn,
      hand: this.hands[pid],
      handCounts: Object.fromEntries(this.playerIds.map(id => [id, this.hands[id].length])),
      boneyardCount: this.boneyard.length,
      // F2.1: keepLastTwo reserves tiles — tell the client how many are actually
      // drawable, else the draw button hides while the pile still shows tiles.
      drawableCount: this.drawableCount(),
      rules: { allowPass: this.allowPass, keepLastTwo: this.keepLastTwo, handSize: this.handSize },
      moves: this.moves,
      // K1.B7: who is demonstrably out of which end values (pass/draw inference).
      passLog: (this.passLog || []).map(e => ({ pid: e.pid, ends: e.ends.slice(), kind: e.kind })),
      ends: this.moves.length ? this.attachableEnds() : [],
      endsTotal: this.endsTotal(),
      leadForcedTile: this.turn === pid && this.leadForcedTile &&
        (this.hands[pid] || []).some(t => t.id === this.leadForcedTile)
        ? this.leadForcedTile : null,
      forcedDrawTile: this.turn === pid && this.status === 'playing' ? this.forcedDrawTileId : null,
      scores: { ...this.scores },
      legalMoves: this.turn === pid && this.status === 'playing' ? this.legalMoves(pid) : [],
      canDraw: this.turn === pid && this.canDraw(pid),
      canPass: this.turn === pid && this.canPass(pid),
      // E1: which tile another player drew from the boneyard is private — the
      // boneyard order is otherwise never exposed. Keep tileId only for the
      // drawer's own view (the client uses it to flag the newly-drawn tile).
      lastAction: this.lastAction && this.lastAction.type === 'draw' && this.lastAction.pid !== pid
        ? { type: 'draw', pid: this.lastAction.pid, count: this.lastAction.count ?? 1 }
        : this.lastAction,
      handResult: this.handResult,
      matchWinnerId: this.matchWinnerId,
    };
  }

  // ---------- internals ----------

  _endHand(winnerId, blocked) {
    let points = 0;
    if (!winnerId) {
      // Blocked: lowest pip count wins; any tie for lowest → nobody scores.
      const sorted = this.playerIds
        .map(id => ({ id, p: this.handPips(id) }))
        .sort((x, y) => x.p - y.p);
      if (sorted[0].p < sorted[1].p) winnerId = sorted[0].id;
    }
    if (winnerId) {
      const others = this.playerIds.filter(id => id !== winnerId)
        .reduce((s, id) => s + this.handPips(id), 0);
      points = this.variant === 'allfives' ? Math.round(others / 5) * 5 : others;
      this.scores[winnerId] += points;
    }
    this._lastHandWinner = winnerId || null;

    // Guard against an un-winnable match: any hand that awards 0 points must
    // advance the counter — a WON hand can also score 0 (All Fives: opponents
    // hold ≤2 pips; blocked hand: the only remaining tile is the 0-0), and
    // letting those reset the streak let a pathological match dodge the guard
    // forever (E5).
    if (points === 0) this._scorelessHands = (this._scorelessHands || 0) + 1;
    else this._scorelessHands = 0;

    this.handResult = {
      blocked, winnerId, points,
      pips: Object.fromEntries(this.playerIds.map(id => [id, this.handPips(id)])),
    };
    this.lastAction = { type: 'handEnd', ...this.handResult };
    if (winnerId && this.scores[winnerId] >= this.targetScore) return this._endMatch(winnerId);

    // Stalled match: end it and award the win to the current points leader.
    // Threshold is high on purpose: with a fresh random deal every hand (production) a
    // 3-hand scoreless streak is effectively unreachable (measured 0/4000 matches), so
    // this is a safety net and NOT something that should ever decide a live game.
    // A low threshold would only bite deterministic/seed-replay setups.
    if (this._scorelessHands >= STALL_GUARD_HANDS) {
      const leader = this.playerIds.slice().sort((x, y) => this.scores[y] - this.scores[x])[0];
      this.handResult.stallEnd = true;
      return this._endMatch(leader);
    }
    this.status = 'handEnd';
  }

  _endMatch(winnerId) {
    this.matchWinnerId = winnerId;
    // handResult is kept as-is: when the match ended at hand end it carries the
    // final breakdown; a mid-hand score-out leaves it null (nothing to show).
    this.status = 'matchEnd';
    this.lastAction = { type: 'matchEnd', winnerId };
  }

  _advanceTurn(fromPid) {
    this._invalidateEnds();
    // B2: the opening "highest double must lead" tile belongs to one player.
    // If that player leaves the turn without playing (timeout skip, a
    // disconnect-driven advance, or a pass on an empty table), the forced tile
    // must not follow the turn — otherwise every other player's legalMoves()
    // short-circuits to [] and nobody can open the hand. Drop the rule and let
    // the next player lead any tile from an empty table.
    if (this.moves.length === 0 && this.leadForcedTile) {
      const hand = this.hands[fromPid] || [];
      if (hand.some(t => t.id === this.leadForcedTile)) this.leadForcedTile = null;
    }
    const i = this.playerIds.indexOf(fromPid);
    this.turn = this.playerIds[(i + 1) % this.playerIds.length];
  }

  _assertTurn(pid) {
    if (this.status !== 'playing') throw new IllegalMove('hand is over');
    if (pid !== this.turn) throw new IllegalMove('not your turn');
  }

  _takeFromHand(pid, tileId) {
    const hand = this.hands[pid];
    const i = hand.findIndex(t => t.id === tileId);
    if (i < 0) throw new IllegalMove('tile not in hand');
    return hand.splice(i, 1)[0];
  }

  _tileById(id) {
    for (const pid of this.playerIds) {
      const t = this.hands[pid].find(t => t.id === id);
      if (t) return t;
    }
    const m = this.moves.find(m => m.t.id === id);
    if (m) return m.t;
    const b = this.boneyard.find(t => t.id === id);
    if (b) return b;
    // Never fabricate a tile from a string: a bogus id would yield NaN match values
    // and silently freeze the match (nothing can ever attach to NaN).
    throw new Error(`unknown tile id: ${id}`);
  }
}
