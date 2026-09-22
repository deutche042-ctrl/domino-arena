// engine/bot.js — pure bot brain for DominoGame (no IO, no timers, no DOM).
//
// ANTI-CHEAT CONTRACT: the bot decides only from public information — its own
// legalMoves/canDraw/canPass, handCounts, moves, endsTotal, scores and
// boneyardCount — exactly the data viewFor() sends to clients. It never reads
// hands of opponents or the boneyard order. Simulation clones expose the full
// state by necessity; the policy below only touches the public surface plus the
// bot's own hand.
//
// chooseAction(game, pid, { level, rng }) is the single plug-point: a future
// trained policy can replace the heuristics behind the same signature.

import { buildDeck, pips } from './deck.js';

const ALL_TILES = buildDeck();

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
 * level: 'easy' | 'medium' | 'hard'. rng: () => number in [0,1).
 */
export function chooseAction(game, pid, { level = 'medium', rng = Math.random } = {}) {
  if (!game || game.status !== 'playing' || game.turn !== pid) return null;
  const legal = game.legalMoves(pid);
  if (legal.length > 0) {
    const move = level === 'easy' ? pickEasy(game, pid, legal, rng)
      : level === 'hard' ? pickHard(game, pid, legal, rng)
        : pickMedium(game, pid, legal, rng);
    if (!move) return legal.length ? { type: 'play', ...legal[Math.floor(rng() * legal.length)] } : null;
    return { type: 'play', tileId: move.tileId, end: move.end };
  }
  if (game.canDraw(pid)) return { type: 'draw' };
  if (game.canPass(pid)) return { type: 'pass' };
  return null;
}

// ---------- level policies ----------

function pickEasy(game, pid, legal, rng) {
  // Mostly random; occasionally notices an obvious scoring play.
  if (game.variant === 'allfives' && rng() < 0.35) {
    let best = null, bestS = 0;
    for (const m of legal) {
      const s = tryScore(game, pid, m);
      if (s > bestS) { bestS = s; best = m; }
    }
    if (best) return best;
  }
  return legal[Math.floor(rng() * legal.length)];
}

function pickMedium(game, pid, legal, rng) {
  // Greedy: take instant points, otherwise shed the heaviest tile.
  const evaluated = legal.map(m => {
    let s = 0;
    if (game.variant === 'allfives') s = tryScore(game, pid, m);
    const tile = game.hands[pid].find(t => t.id === m.tileId);
    return { m, s, p: tile ? pips(tile) : 0, r: rng() };
  });
  evaluated.sort((x, y) => y.s - x.s || y.p - x.p || x.r - y.r);
  return evaluated[0].m;
}

function pickHard(game, pid, legal, rng) {
  const evaluated = [];
  for (const m of legal) {
    const s = evaluateMove(game, pid, m);
    if (s !== -Infinity) evaluated.push({ m, s });
  }
  if (!evaluated.length) return legal[Math.floor(rng() * legal.length)];
  const max = Math.max(...evaluated.map(x => x.s));
  const ties = evaluated.filter(x => x.s >= max - 1e-9);
  return ties[Math.floor(rng() * ties.length)].m;
}

// ---------- hard-level evaluation ----------

function evaluateMove(game, pid, move) {
  const sim = cloneGame(game);
  let res;
  try {
    res = sim.play(pid, move.tileId, move.end);
  } catch {
    return -Infinity;
  }
  let score = 0;
  if (res && res.scored) score += res.scored * 8;
  if (sim.status === 'matchEnd') return 1e9;
  if (sim.status === 'handEnd' && sim.handResult && sim.handResult.winnerId === pid) {
    return 500 + sim.handResult.points * 4;   // domino: hand points + next-hand lead
  }

  // Shed heavy tiles — fewer pips left for opponents at hand end.
  const tile = game.hands[pid].find(t => t.id === move.tileId);
  if (tile) score += pips(tile) * 1.2;

  // Blocking: reward reducing the number of unseen tiles the table can still play.
  score += (countPlayableUnseen(game, pid) - countPlayableUnseen(sim, pid)) * 0.9;

  // All Fives: don't hand the next player a cheap path to a multiple of 5.
  if (game.variant === 'allfives') score -= dangerForNextPlayer(sim, pid) * 1.6;

  // Flexibility: keep a hand that can still answer the open ends.
  score += myFlexibility(sim, pid) * 0.7;

  return score;
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

/** Unseen tiles the NEXT player could use to land endsTotal on a multiple of 5.
 *  Counted from the bot's own knowledge (never the next player's actual hand). */
function dangerForNextPlayer(sim, pid) {
  const total = sim.endsTotal();
  if (total === 0) return 0;
  const deficit = (5 - (total % 5)) % 5;   // pips the next player must add
  const ends = sim.attachableEnds();
  let n = 0;
  for (const t of unseenTiles(sim, pid)) {
    if (pips(t) % 5 !== deficit) continue;
    if (ends.some(({ match }) => match !== null && (t.a === match || t.b === match))) n++;
  }
  return n;
}

/** Own (post-move) tiles that still answer at least one open end. */
function myFlexibility(sim, pid) {
  let n = 0;
  for (const t of sim.hands[pid]) {
    if (playableOnAnEnd(t, sim)) n++;
  }
  return n;
}
