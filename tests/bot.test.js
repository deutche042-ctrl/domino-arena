// tests/bot.test.js — bot brain verification (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../engine/deck.js';
import { DominoGame } from '../engine/game.js';
import { chooseAction, cloneGame, PROFILES } from '../engine/bot.js';

const LEVELS = ['easy', 'medium', 'hard'];
const VARIANTS = ['block', 'draw', 'allfives'];

/** Drive a full bot-vs-bot match; every action goes through the engine, so any
 *  illegal choice throws and fails the test. Returns the action log. */
function runBotMatch({ variant, playerIds, seed, level, profile = 'balanced', targetScore }) {
  const game = new DominoGame({ variant, playerIds, seed, targetScore });
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const log = [];
  let actions = 0;
  while (game.status !== 'matchEnd') {
    if (game.status === 'handEnd') {
      game.nextHand(seed + game.handNumber * 7919);   // host role: advance hands
      continue;
    }
    const pid = game.turn;
    const action = chooseAction(game, pid, { level, profile, rng });
    assert.ok(action, `bot produced an action (hand ${game.handNumber})`);
    log.push(`${action.type}:${action.tileId || ''}:${action.end ?? ''}`);
    if (action.type === 'play') game.play(pid, action.tileId, action.end);
    else if (action.type === 'draw') game.draw(pid);
    else if (action.type === 'pass') game.pass(pid);
    else assert.fail(`unexpected action ${JSON.stringify(action)}`);
    if (++actions > 20000) assert.fail('match did not terminate');
  }
  assert.ok(game.matchWinnerId, 'match has a winner');
  for (const id of playerIds) assert.ok(game.scores[id] >= 0, 'scores stay non-negative');
  return log;
}

test('bots finish seeded matches legally in every variant × level (2P & 4P)', () => {
  for (const variant of VARIANTS) {
    for (const level of LEVELS) {
      for (const playerIds of [['a', 'b'], ['a', 'b', 'c', 'd']]) {
        for (const seed of [11, 23, 47]) {
          const log = runBotMatch({ variant, playerIds, seed, level, targetScore: 60 });
          assert.ok(log.length > 0, `${variant}/${level}/${playerIds.length}p produced actions`);
        }
      }
    }
  }
});

test('chooseAction is deterministic for a fixed seed', () => {
  for (const level of ['easy', 'hard']) {
    const run = () => runBotMatch({ variant: 'allfives', playerIds: ['a', 'b', 'c', 'd'], seed: 42, level, targetScore: 60 });
    assert.deepEqual(run(), run(), `${level} replays identically from the same seed`);
  }
});

test('chooseAction does not mutate the game it inspects', () => {
  const game = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: { hands: { a: ['6-6', '2-3', '5-0'], b: ['6-1', '3-4'] }, boneyard: ['0-0', '1-1'] },
  });
  // a holds the highest double → forced lead; play it to reach a real decision.
  game.play(game.turn, '6-6', null);
  const before = JSON.stringify(game);
  chooseAction(game, game.turn, { level: 'hard', rng: mulberry32(5) });
  assert.equal(JSON.stringify(game), before, 'evaluation left the live game untouched');
});

test('draw variant: bot draws when stuck, passes when boneyard is empty', () => {
  const stuck = new DominoGame({
    variant: 'draw', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1', '1-1'], b: ['3-3', '5-6'] }, boneyard: ['0-4', '2-5'] },
  });
  // b leads 3-3 (highest double); a holds no 3 → must draw.
  stuck.play('b', '3-3', null);
  assert.equal(stuck.turn, 'a');
  assert.deepEqual(chooseAction(stuck, 'a', { level: 'hard' }), { type: 'draw' });

  const dry = new DominoGame({
    variant: 'draw', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1', '1-1'], b: ['3-3', '5-6'] }, boneyard: [] },
  });
  dry.play('b', '3-3', null);
  assert.deepEqual(chooseAction(dry, 'a', { level: 'medium' }), { type: 'pass' });
});

test('block variant: bot passes when it cannot play', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1', '1-1'], b: ['3-3', '5-6'] }, boneyard: [] },
  });
  g.play('b', '3-3', null);
  assert.deepEqual(chooseAction(g, 'a', { level: 'hard' }), { type: 'pass' });
});

test('greedy levels take an available scoring play in All Fives', () => {
  // Scan real bot-vs-bot allfives positions: whenever an instant-scoring play
  // exists, medium and hard must take one (easy is random by design).
  const game = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c', 'd'], seed: 99, targetScore: 60 });
  const rng = mulberry32(4242);
  let checked = 0;
  let guarded = 0;
  while (game.status !== 'matchEnd') {
    if (game.status === 'handEnd') { game.nextHand(99 + game.handNumber * 104729); continue; }
    const pid = game.turn;
    const legal = game.legalMoves(pid);
    if (legal.length) {
      const scoring = legal.filter(m => {
        const sim = cloneGame(game);
        const r = sim.play(pid, m.tileId, m.end);
        return r && r.scored > 0;
      });
      for (const level of ['medium', 'hard']) {
        const action = chooseAction(game, pid, { level, rng });
        if (scoring.length) {
          assert.ok(
            action.type === 'play' && scoring.some(m => m.tileId === action.tileId && m.end === action.end),
            `${level} missed a scoring play (hand ${game.handNumber}, ${legal.length} legal, ${scoring.length} scoring)`,
          );
          guarded++;
        }
        checked++;
      }
    }
    const action = chooseAction(game, pid, { level: 'hard', rng });
    if (action.type === 'play') game.play(pid, action.tileId, action.end);
    else if (action.type === 'draw') game.draw(pid);
    else game.pass(pid);
    if (checked > 400) break;
  }
  assert.ok(checked > 20, 'sampled a meaningful number of positions');
  assert.ok(guarded > 0, 'encountered positions with scoring plays');
});

// ── F4.2: personalities share one evaluator and stay within the anti-cheat contract ──

test('F4.2: PROFILES exports balanced/aggressive/defensive', () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ['aggressive', 'balanced', 'defensive']);
  assert.deepEqual(PROFILES.balanced, { aggression: 1, defense: 1, risk: 1, patience: 1 },
    'balanced must be the identity weights (back-compat with pre-F4.2 behaviour)');
});

test('F4.2: every level×profile combination plays a legal full match', () => {
  for (const level of [...LEVELS, 'expert']) {
    for (const profile of Object.keys(PROFILES)) {
      const log = runBotMatch({ variant: 'allfives', playerIds: ['a', 'b'], seed: 31, level, profile, targetScore: 40 });
      assert.ok(log.length > 5, `${level}/${profile} should play a real match (${log.length} actions)`);
      for (const entry of log) {
        const type = String(entry).split(':')[0];
        assert.ok(['play', 'draw', 'pass'].includes(type), `illegal action type ${type}`);
      }
    }
  }
});

test('F4.2: personalities make observably different choices (aggressive vs defensive)', () => {
  // Across many positions at least one decision must differ, otherwise the
  // profile weights are not reaching the evaluator.
  const game = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c'], seed: 777, targetScore: 500 });
  const rng = mulberry32(2024);
  let differences = 0, samples = 0;
  while (game.status !== 'matchEnd' && samples < 300) {
    if (game.status === 'handEnd') { game.nextHand(777 + game.handNumber * 3571); continue; }
    const pid = game.turn;
    if (game.legalMoves(pid).length > 1) {
      const ag = chooseAction(game, pid, { level: 'hard', profile: 'aggressive', rng: mulberry32(samples) });
      const df = chooseAction(game, pid, { level: 'hard', profile: 'defensive', rng: mulberry32(samples) });
      samples++;
      if (ag.tileId !== df.tileId || ag.end !== df.end) differences++;
    }
    const act = chooseAction(game, pid, { level: 'hard', profile: 'balanced', rng });
    if (act.type === 'play') game.play(pid, act.tileId, act.end);
    else if (act.type === 'draw') game.draw(pid);
    else game.pass(pid);
  }
  assert.ok(samples > 30, `sampled enough multi-move positions (${samples})`);
  assert.ok(differences > 0, `aggressive and defensive never disagreed across ${samples} positions`);
});

test('F4.2: expert level also decides only from public info (no game mutation)', () => {
  const game = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c', 'd'], seed: 12, targetScore: 200 });
  // advance to a non-trivial mid-game position
  for (let i = 0; i < 12 && game.status === 'playing'; i++) {
    const pid = game.turn;
    const mv = game.legalMoves(pid);
    if (mv.length) game.play(pid, mv[0].tileId, mv[0].end);
    else if (game.canDraw(pid)) game.draw(pid);
    else game.pass(pid);
  }
  const before = JSON.stringify(game);
  for (const profile of Object.keys(PROFILES)) {
    chooseAction(game, game.turn, { level: 'expert', profile, rng: mulberry32(9) });
    assert.equal(JSON.stringify(game), before, `expert/${profile} mutated the game it inspected`);
  }
});

test('F4.2: an unknown level/profile falls back safely', () => {
  const game = new DominoGame({ variant: 'block', playerIds: ['a', 'b'], seed: 5 });
  const a = chooseAction(game, game.turn, { level: 'bogus', profile: 'nope', rng: mulberry32(1) });
  assert.ok(a && a.type, 'bogus level/profile must still return a legal action');
});

// ── K1.B2: the anti-cheat boundary, pinned mechanically ──

test('anti-cheat invariance: permuting hidden info never changes any decision', () => {
  // For every level × profile the chosen action may depend only on public info
  // plus the bot's own hand. Rotating the opponents' tiles among them and
  // reversing the boneyard changes ALL hidden information while preserving hand
  // sizes, the board, and the public passLog — so the same rng stream must
  // produce the identical action. (Would have caught the expert hand-reading leak.)
  for (const level of ['easy', 'medium', 'hard', 'expert']) {
    for (const profile of Object.keys(PROFILES)) {
      const game = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c', 'd'], seed: 34, targetScore: 300 });
      // Advance a few moves, then wait for a real multi-move decision for 'a'.
      for (let i = 0; i < 6 && game.status === 'playing'; i++) {
        const t = game.turn;
        const mv = game.legalMoves(t);
        if (mv.length) game.play(t, mv[0].tileId, mv[0].end);
        else if (game.canDraw(t)) game.draw(t);
        else game.pass(t);
      }
      let guard = 0;
      while (game.status === 'playing' &&
             (game.turn !== 'a' || game.legalMoves('a').length < 2) && guard++ < 100) {
        const t = game.turn;
        const mv = game.legalMoves(t);
        if (mv.length) game.play(t, mv[0].tileId, mv[0].end);
        else if (game.canDraw(t)) game.draw(t);
        else game.pass(t);
      }
      assert.equal(game.status, 'playing', `${level}/${profile}: reached a live hand`);
      assert.ok(game.legalMoves('a').length >= 1, `${level}/${profile}: 'a' has a decision`);
      const baseline = chooseAction(game, 'a', { level, profile, rng: mulberry32(77) });
      assert.ok(baseline, `${level}/${profile}: baseline action exists`);

      // Permute hidden info: rotate opponents' tiles by one seat, reverse boneyard.
      const others = game.playerIds.filter(id => id !== 'a');
      const sizes = others.map(id => game.hands[id].length);
      const pool = others.flatMap(id => game.hands[id].splice(0));
      pool.push(pool.shift());
      let i = 0;
      others.forEach((id, k) => { game.hands[id] = pool.slice(i, i + sizes[k]); i += sizes[k]; });
      game.boneyard.reverse();

      const after = chooseAction(game, 'a', { level, profile, rng: mulberry32(77) });
      assert.deepEqual(
        after, baseline,
        `${level}/${profile} changed its decision when hidden info was permuted`,
      );
    }
  }
});
