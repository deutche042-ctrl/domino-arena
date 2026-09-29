// engine/bot.js — pure bot brain for DominoGame (no IO, no timers, no DOM).
//
// ANTI-CHEAT CONTRACT: the bot decides only from public information — its own
// legalMoves/canDraw/canPass, handCounts, moves, endsTotal, scores,
// boneyardCount and passLog — exactly the data viewFor() sends to clients. It
// never reads hands of opponents or the boneyard order. Simulation clones
// expose the full state by necessity; the policy below only touches the public
// surface plus the bot's own hand.
//
// Observer mode (expert): when scoring a HYPOTHETICAL opponent reply, terms
// that read the mover's hand are skipped and every unseen-tile helper runs from
// the observing bot's perspective (observer pid). Reply candidates are drawn
// from the observer's unseen tiles, never from the opponent's real legalMoves.
//
// chooseAction(game, pid, { level, rng }) is the single plug-point: a future
// trained policy can replace the heuristics behind the same signature.

import { buildDeck, pips, isDouble } from './deck.js';

const ALL_TILES = buildDeck();

/**
 * F4.2 — bot personalities. Every profile scores the SAME evaluator
 * (evaluateMove) and simply reweights its terms, so all personalities share one
 * code path and one correctness contract. `aggression` biases toward immediate
 * points and heavy-tile shedding; `defense` toward blocking/flexibility;
 * `risk` toward denying the next player (All Fives danger); `patience` toward
 * keeping a flexible hand over instant tempo.
 *
 * Weights multiply the base evaluator's terms; a profile of all 1s == `balanced`.
 * K1.B8: the evaluator further adapts to match position — a leader tilts
 * defensive (seal the board), a trailer tilts aggressive.
 */
export const PROFILES = {
  balanced:  { aggression: 1.0, defense: 1.0, risk: 1.0, patience: 1.0 },
  aggressive:{ aggression: 1.7, defense: 0.5, risk: 0.7, patience: 0.6 },
  defensive: { aggression: 0.6, defense: 1.8, risk: 1.4, patience: 1.5 },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

/** Lossless copy of a DominoGame: all state lives on own enumerable fields. */
export function cloneGame(game) {
  const clone = Object.create(Object.getPrototypeOf(game));
  Object.assign(clone, JSON.parse(JSON.stringify(game)));
  return clone;
}

/**
 * Decide the next action for pid. Returns
 *   { type:'play', tileId, end } | { type:'draw' } | { type:'pass' }
 * or null when it isn't pid's turn / the game isn't playable.
 * level: 'easy' | 'medium' | 'hard' | 'expert'. profile: key of PROFILES.
 * rng: () => number in [0,1).
 */
export function chooseAction(game, pid, { level = 'medium', profile = 'balanced', rng = Math.random } = {}) {
  if (!game || game.status !== 'playing' || game.turn !== pid) return null;
  const weights = PROFILES[profile] || PROFILES.balanced;
  const legal = game.legalMoves(pid);
  if (legal.length > 0) {
    const move = level === 'easy' ? pickEasy(game, pid, legal, rng)
      : level === 'expert' ? pickExpert(game, pid, legal, rng, weights)
        : level === 'hard' ? pickHard(game, pid, legal, rng, weights)
          : pickMedium(game, pid, legal, rng, weights);
    if (!move) return legal.length ? { type: 'play', ...legal[Math.floor(rng() * legal.length)] } : null;
    return { type: 'play', tileId: move.tileId, end: move.end };
  }
  if (game.canDraw(pid)) return { type: 'draw' };
  if (game.canPass(pid)) return { type: 'pass' };
  return null;
}

// ---------- level policies ----------

/** A move that immediately wins the hand (or the match) — even novices spot it. */
function findHandWinningMove(game, pid, legal) {
  for (const m of legal) {
    const sim = cloneGame(game);
    try { sim.play(pid, m.tileId, m.end); } catch { continue; }
    if (sim.status === 'matchEnd' && sim.matchWinnerId === pid) return m;
    if (sim.status === 'handEnd' && sim.handResult && sim.handResult.winnerId === pid) return m;
  }
  return null;
}

function pickEasy(game, pid, legal, rng) {
  // K1.B3: never blind to an immediate win; otherwise mostly random, with a
  // coin-flip chance of noticing an obvious scoring play in All Fives.
  const win = findHandWinningMove(game, pid, legal);
  if (win) return win;
  if (game.variant === 'allfives' && rng() < 0.5) {
    let best = null, bestS = 0;
    for (const m of legal) {
      const s = tryScore(game, pid, m);
      if (s > bestS) { bestS = s; best = m; }
    }
    if (best) return best;
  }
  return legal[Math.floor(rng() * legal.length)];
}

function pickMedium(game, pid, legal, rng, w = PROFILES.balanced) {
  // K1.B4: take the hand win before the greedy heuristic can pass it up.
  const win = findHandWinningMove(game, pid, legal);
  if (win) return win;
  // Greedy: take instant points, otherwise shed the heaviest tile. The
  // aggression weight biases how strongly points beat pip-shedding.
  const evaluated = legal.map(m => {
    let s = 0;
    if (game.variant === 'allfives') s = tryScore(game, pid, m) * w.aggression;
    const tile = game.hands[pid].find(t => t.id === m.tileId);
    return { m, s, p: tile ? pips(tile) : 0, r: rng() };
  });
  evaluated.sort((x, y) => y.s - x.s || y.p - x.p || x.r - y.r);
  return evaluated[0].m;
}

function pickHard(game, pid, legal, rng, w = PROFILES.balanced) {
  const evaluated = [];
  for (const m of legal) {
    const s = evaluateMove(game, pid, m, w);
    if (s !== -Infinity) evaluated.push({ m, s });
  }
  if (!evaluated.length) return legal[Math.floor(rng() * legal.length)];
  const max = Math.max(...evaluated.map(x => x.s));
  const ties = evaluated.filter(x => x.s >= max - 1e-9);
  return ties[Math.floor(rng() * ties.length)].m;
}

/**
 * F4.2 'expert' (K1.B1): one-ply lookahead with a PUBLIC-INFO reply estimate.
 * Each own move is scored as usual; the penalty is the best retaliation we
 * cannot rule out — every unseen tile that could attach to an open end is
 * injected into a scratch clone and evaluated in observer mode. The opponent's
 * real hand and real legalMoves are never consulted.
 */
function pickExpert(game, pid, legal, rng, w) {
  const evaluated = [];
  for (const m of legal) {
    let s = evaluateMove(game, pid, m, w);
    if (s === -Infinity) continue;
    const sim = cloneGame(game);
    try { sim.play(pid, m.tileId, m.end); } catch { continue; }
    if (sim.status !== 'playing') { evaluated.push({ m, s }); continue; }
    s -= bestPublicReply(sim, pid, w) * 0.45;
    evaluated.push({ m, s });
  }
  if (!evaluated.length) return legal[Math.floor(rng() * legal.length)];
  const max = Math.max(...evaluated.map(x => x.s));
  const ties = evaluated.filter(x => x.s >= max - 1e-9);
  return ties[Math.floor(rng() * ties.length)].m;
}

// ---------- hard-level evaluation ----------

/**
 * Score `move` for pid on a clone of `game`.
 * `observer` (expert reply evaluation): pid is a HYPOTHETICAL mover, so only
 * public info plus the observer's own knowledge may be used — hand-reading
 * terms are skipped and unseen-tile helpers use the observer's perspective.
 */
function evaluateMove(game, pid, move, w = PROFILES.balanced, observer = null) {
  const sim = cloneGame(game);
  let res;
  try {
    res = sim.play(pid, move.tileId, move.end);
  } catch {
    return -Infinity;
  }
  const obs = observer || pid;
  let score = 0;
  if (res && res.scored) score += res.scored * 8 * w.aggression;
  if (sim.status === 'matchEnd') return 1e9;
  if (sim.status === 'handEnd' && sim.handResult && sim.handResult.winnerId === pid) {
    return 500 + sim.handResult.points * 4;   // domino: hand points + next-hand lead
  }

  // K1.B8: score-adaptive style — ahead → seal (defense/denial), behind → gamble.
  let aggr = w.aggression, def = w.defense, risk = w.risk;
  const rivals = game.playerIds.filter(id => id !== pid);
  if (rivals.length) {
    const bestOther = Math.max(...rivals.map(id => game.scores[id] || 0));
    const mine = game.scores[pid] || 0;
    if (mine > bestOther) { def *= 1.25; risk *= 1.25; aggr *= 0.9; }
    else if (mine < bestOther) { aggr *= 1.15; }
  }

  // Shed heavy tiles — fewer pips left for opponents at hand end. (Own-hand
  // knowledge; skipped for a hypothetical opponent mover.)
  if (!observer) {
    const tile = game.hands[pid].find(t => t.id === move.tileId);
    if (tile) score += pips(tile) * 1.2 * aggr;
  }

  // Blocking: reward reducing the playable-unseen threat, probability-weighted
  // by the share of unseen tiles that can actually be in an opponent's hand.
  score += (weightedPlayableUnseen(game, obs) - weightedPlayableUnseen(sim, obs)) * 0.9 * def;

  // All Fives: don't hand the next player a cheap path to a multiple of 5.
  if (game.variant === 'allfives') score -= dangerForNextPlayer(sim, obs) * 1.6 * risk;

  // Flexibility: keep a hand that can still answer the open ends.
  if (!observer) score += myFlexibility(sim, pid) * 0.7 * w.patience;

  // K1.B7: trap — leave ends whose values opponents are demonstrably out of
  // (their passes/draws are public), squeezing them toward a blocked hand.
  score += trapCoverage(sim, obs) * 0.5 * def;

  return score;
}

/**
 * Best plausible reply after `sim` (our move just landed), estimated from the
 * observer's unseen tiles only. Deterministic: no rng, so hidden info can never
 * change rng consumption (anti-cheat invariance).
 */
function bestPublicReply(sim, observerPid, w) {
  const nextPid = sim.turn;
  if (!nextPid || nextPid === observerPid) return 0;
  let unseen = unseenTiles(sim, observerPid);
  const ends = sim.attachableEnds().filter(e => e.match !== null);
  if (!unseen.length || !ends.length) return 0;
  // Cap the candidate fan-out deterministically (stride subsample).
  if (unseen.length > 14) {
    const step = unseen.length / 14;
    const picked = [];
    for (let i = 0; i < 14; i++) picked.push(unseen[Math.floor(i * step)]);
    unseen = picked;
  }
  let best = 0;
  for (const t of unseen) {
    for (const { end, match } of ends) {
      if (t.a !== match && t.b !== match) continue;
      const probe = cloneGame(sim);
      probe.hands[nextPid].push({ ...t });           // hypothetical: give them the tile
      const rs = evaluateMove(probe, nextPid, { tileId: t.id, end }, w, observerPid);
      if (rs > best && rs < 1e8) best = rs;
    }
  }
  return best;
}

function tryScore(game, pid, move) {
  const sim = cloneGame(game);
  try {
    const r = sim.play(pid, move.tileId, move.end);
    return (r && r.scored) || 0;
  } catch {
    return 0;
  }
}

/** Tiles whose location the bot cannot know: full deck − own hand − board. */
function unseenTiles(game, pid) {
  const known = new Set();
  for (const t of game.hands[pid]) known.add(t.id);
  for (const m of game.moves) known.add(m.t.id);
  return ALL_TILES.filter(t => !known.has(t.id));
}

function playableOnAnEnd(tile, game) {
  if (game.moves.length === 0) return true;
  return game.attachableEnds().some(({ match }) => match !== null && (tile.a === match || tile.b === match));
}

/** How many unseen tiles could legally attach somewhere right now. */
function countPlayableUnseen(game, pid) {
  const ends = game.attachableEnds();
  if (game.moves.length === 0) return unseenTiles(game, pid).length;
  let n = 0;
  for (const t of unseenTiles(game, pid)) {
    if (ends.some(({ match }) => match !== null && (t.a === match || t.b === match))) n++;
  }
  return n;
}

/**
 * K1.B6: the blocking threat is only the unseen tiles actually held by
 * opponents — boneyard tiles can't be played this turn. Both shares are public
 * (handCounts + boneyardCount), so the estimate stays inside the contract.
 */
function weightedPlayableUnseen(game, pid) {
  const unseen = unseenTiles(game, pid);
  const playable = countPlayableUnseen(game, pid);
  if (!unseen.length || !playable) return 0;
  const inHands = Math.max(0, unseen.length - game.boneyard.length);
  return playable * (inHands / unseen.length);
}

/**
 * K1.B5: unseen tiles the NEXT player could use to land endsTotal on a multiple
 * of 5 — counted by really attaching each candidate to each open end (with the
 * engine's double-dedup rules), never by a pips heuristic. Public info only.
 */
function dangerForNextPlayer(sim, observerPid) {
  if (sim.moves.length === 0) return 0;
  if (sim.endsTotal() === 0) return 0;
  const ends = sim.attachableEnds().filter(e => e.match !== null);
  if (!ends.length) return 0;
  let n = 0;
  for (const t of unseenTiles(sim, observerPid)) {
    for (const { end, match } of ends) {
      if (t.a !== match && t.b !== match) continue;
      const dbl = isDouble(t);
      const outer = t.a === match ? t.b : t.a;
      const entry = { tileId: t.id, dbl, score: dbl ? pips(t) : outer };
      const total = endsTotalWith(sim.ends, end, entry);
      if (total > 0 && total % 5 === 0) { n++; break; }
    }
  }
  return n;
}

/** endsTotal() as it would be if `entry` replaced the tile at `replacedEnd`. */
function endsTotalWith(ends, replacedEnd, entry) {
  const seenDoubles = new Set();
  let total = 0;
  for (const k of ['L', 'R', 'U', 'D']) {
    const e = k === replacedEnd ? entry : ends[k];
    if (!e) continue;
    if (e.dbl) {
      if (seenDoubles.has(e.tileId)) continue;
      seenDoubles.add(e.tileId);
    }
    total += e.score;
  }
  return total;
}

/**
 * K1.B7: how many (opponent, open-end-value) pairs are proven dead — that
 * opponent passed or drew while this end value was open, so they hold no tile
 * matching it. passLog is public (recorded by the engine from announced moves).
 */
function trapCoverage(sim, observerPid) {
  if (!sim.passLog || !sim.passLog.length || sim.moves.length === 0) return 0;
  const ends = sim.attachableEnds().filter(e => e.match !== null);
  if (!ends.length) return 0;
  let cov = 0;
  for (const { match } of ends) {
    for (const p of sim.playerIds) {
      if (p === observerPid) continue;
      if (sim.passLog.some(e => e.pid === p && e.ends.includes(match))) cov++;
    }
  }
  return cov;
}

/** Own (post-move) tiles that still answer at least one open end. */
function myFlexibility(sim, pid) {
  let n = 0;
  for (const t of sim.hands[pid]) {
    if (playableOnAnEnd(t, sim)) n++;
  }
  return n;
}
