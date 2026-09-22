// tests/bot.test.js — bot brain verification (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../engine/deck.js';
import { DominoGame } from '../engine/game.js';
import { chooseAction, cloneGame } from '../engine/bot.js';

const LEVELS = ['easy', 'medium', 'hard'];
const VARIANTS = ['block', 'draw', 'allfives'];

/** Drive a full bot-vs-bot match; every action goes through the engine, so any
 *  illegal choice throws and fails the test. Returns the action log. */
function runBotMatch({ variant, playerIds, seed, level, targetScore }) {
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
    const action = chooseAction(game, pid, { level, rng });
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
