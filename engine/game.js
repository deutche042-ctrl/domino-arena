// engine/game.js — server-authoritative domino engine
// Variants: 'block' | 'draw' | 'allfives' (All Fives = Muggins/Five-Up with spinner)
// Pure logic, no IO. All state serializable.

import { buildDeck, shuffle, mulberry32, pips, isDouble } from './deck.js';

const DEFAULT_TARGET = { block: 100, draw: 100, allfives: 250 };
const DEFAULT_HAND = {
  block:   { 2: 7, 3: 5, 4: 5 },
  draw:    { 2: 7, 3: 5, 4: 5 },
  allfives:{ 2: 7, 3: 7, 4: 5 },
};

export class IllegalMove extends Error {}

export class DominoGame {
  /**
   * @param {object} opt
   *  variant: 'block'|'draw'|'allfives'
   *  playerIds: string[2..4]
   *  targetScore?: number
   *  handSize?: number (override)
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
    this.targetScore = opt.targetScore || DEFAULT_TARGET[variant];
    this.handSize = opt.handSize || DEFAULT_HAND[variant][playerIds.length];
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
    this.spinner = null;                // { id, sidesFilled }
    this.passCount = 0;
    this.handResult = null;
    this.hands = {};
    let boneyard;
    if (opt.deal) {
      // Test hook. Ids are normalized ("5-1" → "1-5") so fixtures are forgiving.
      const norm = id => {
        const [a, b] = id.split('-').map(Number);
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      const all = new Map(buildDeck().map(t => [t.id, t]));
      for (const pid of this.playerIds)
        this.hands[pid] = opt.deal.hands[pid].map(id => ({ ...all.get(norm(id)) }));
      boneyard = opt.deal.boneyard.map(id => ({ ...all.get(norm(id)) }));
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
  }

  // ---------- queries ----------

  handPips(pid) { return this.hands[pid].reduce((s, t) => s + pips(t), 0); }

  /** Attachable ends with their match values. U/D only once spinner has both side tiles. */
  attachableEnds() {
    const out = [];
    if (this.moves.length === 0) return [{ end: null, match: null }];
    out.push({ end: 'L', match: this.ends.L.match }, { end: 'R', match: this.ends.R.match });
    if (this.variant === 'allfives' && this.spinner && this.spinner.sidesFilled >= 2) {
      const sv = this._tileById(this.spinner.id).a;
      out.push({ end: 'U', match: this.ends.U ? this.ends.U.match : sv });
      out.push({ end: 'D', match: this.ends.D ? this.ends.D.match : sv });
    }
    return out;
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
    for (const { end, match } of this.attachableEnds()) {
      for (const t of hand) {
        if (t.a === match || t.b === match) moves.push({ tileId: t.id, end });
      }
    }
    return moves;
  }

  canDraw(pid) {
    return this.variant !== 'block' && this.boneyard.length > 0 &&
           this.legalMoves(pid).length === 0 && this.status === 'playing';
  }

  canPass(pid) {
    if (this.status !== 'playing' || this.legalMoves(pid).length > 0) return false;
    return this.variant === 'block' || this.boneyard.length === 0;
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
      if (dbl && this.variant === 'allfives') this.spinner = { id: tile.id, sidesFilled: 0 };
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
      if (isDouble(tile) && !this.spinner && this.variant === 'allfives') this.spinner = { id: tile.id, sidesFilled: 1 };
      this.moves.push({ t: tile, e: end, f, p: pid });
    }

    this.passCount = 0;
    this.leadForcedTile = null;
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
    if (!this.canDraw(pid)) throw new IllegalMove('cannot draw now');
    const tile = this.boneyard.pop();
    this.hands[pid].push(tile);
    this.lastAction = { type: 'draw', pid, count: 1 };
    return tile;
  }

  pass(pid) {
    this._assertTurn(pid);
    if (!this.canPass(pid)) throw new IllegalMove('cannot pass now');
    this.passCount++;
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
      moves: this.moves,
      ends: this.moves.length ? this.attachableEnds() : [],
      endsTotal: this.endsTotal(),
      leadForcedTile: this.turn === pid ? this.leadForcedTile : null,
      scores: { ...this.scores },
      legalMoves: this.turn === pid && this.status === 'playing' ? this.legalMoves(pid) : [],
      canDraw: this.turn === pid && this.canDraw(pid),
      canPass: this.turn === pid && this.canPass(pid),
      lastAction: this.lastAction,
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

    // Guard against an un-winnable match: in Block, repeated blocked hands that
    // tie on pips (winnerId null, 0 points) can stall the scoreboard forever.
    if (!winnerId && points === 0) this._scorelessHands = (this._scorelessHands || 0) + 1;
    else this._scorelessHands = 0;

    this.handResult = {
      blocked, winnerId, points,
      pips: Object.fromEntries(this.playerIds.map(id => [id, this.handPips(id)])),
    };
    this.lastAction = { type: 'handEnd', ...this.handResult };
    if (winnerId && this.scores[winnerId] >= this.targetScore) return this._endMatch(winnerId);

    // Stalled match: end it and award the win to the current points leader.
    if (this._scorelessHands >= 3) {
      const leader = this.playerIds.slice().sort((x, y) => this.scores[y] - this.scores[x])[0];
      return this._endMatch(leader);
    }
    this.status = 'handEnd';
  }

  _endMatch(winnerId) {
    this.matchWinnerId = winnerId;
    // keep handResult if the match ended at hand end
    if (!this.handResult || this.handResult.winnerId !== winnerId) {
      this.handResult = this.handResult || null;
    }
    this.status = 'matchEnd';
    this.lastAction = { type: 'matchEnd', winnerId };
  }

  _advanceTurn(fromPid) {
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
    const [a, bb] = id.split('-').map(Number);
    return { id, a, b: bb };
  }
}
