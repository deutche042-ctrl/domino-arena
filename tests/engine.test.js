// tests/engine.test.js — engine rules verification (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, shuffle, mulberry32 } from '../engine/deck.js';
import { DominoGame, IllegalMove } from '../engine/game.js';

test('deck: 28 unique tiles, pip totals = 168', () => {
  const d = buildDeck();
  assert.equal(d.length, 28);
  assert.equal(new Set(d.map(t => t.id)).size, 28);
  assert.equal(d.reduce((s, t) => s + t.a + t.b, 0), 168);
});

test('shuffle: deterministic with seed, preserves tiles', () => {
  const a = shuffle(buildDeck(), mulberry32(42));
  const b = shuffle(buildDeck(), mulberry32(42));
  assert.deepEqual(a.map(t => t.id), b.map(t => t.id));
  assert.deepEqual(a.map(t => t.id).sort(), buildDeck().map(t => t.id).sort());
});

test('deal: correct hand sizes, no duplicates (2P block)', () => {
  const g = new DominoGame({ variant: 'block', playerIds: ['a', 'b'], seed: 7 });
  assert.equal(g.hands.a.length, 7);
  assert.equal(g.hands.b.length, 7);
  assert.equal(g.boneyard.length, 14);
  const all = [...g.hands.a, ...g.hands.b, ...g.boneyard].map(t => t.id);
  assert.equal(new Set(all).size, 28);
});

test('block: highest double leads and must play it', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['2-2', '0-1'], b: ['4-4', '3-3'] }, boneyard: ['6-6'] },
  });
  assert.equal(g.turn, 'b');                 // b holds [4-4], highest double
  assert.deepEqual(g.legalMoves('b'), [{ tileId: '4-4', end: null }]);
  assert.throws(() => g.play('b', '3-3', null), IllegalMove);
  g.play('b', '4-4', null);
  assert.equal(g.endsTotal(), 8);            // block variant: ends still tracked
});

test('block: domino scores opponents remaining pips', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['2-3'], b: ['2-2', '5-6'] }, boneyard: [] },
  });
  assert.equal(g.turn, 'b');                 // b has the only double
  g.play('b', '2-2', null);
  g.play('a', '2-3', 'L');                   // a dominoes
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.winnerId, 'a');
  assert.equal(g.handResult.points, 11);     // b still holds [5-6] = 11 pips
  assert.equal(g.scores.a, 11);
});

test('block: pass only with no legal move; blocked hand → lowest pips wins', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1', '3-3'], b: ['0-2', '4-4'] }, boneyard: [] },
  });
  assert.equal(g.turn, 'b');                 // b leads [4-4]
  g.play('b', '4-4', null);
  assert.equal(g.canPass('a'), true);        // a has no 4
  assert.throws(() => g.draw('a'), IllegalMove);  // draw not allowed in block variant
  g.pass('a');
  assert.equal(g.canPass('b'), true);        // b has no 4 either
  g.pass('b');                               // consecutive passes = players → blocked
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.blocked, true);
  assert.equal(g.handResult.winnerId, 'b');  // b: 2 pips vs a: 7 pips
  assert.equal(g.scores.b, 7);
});

test('block: match ends at target score', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'], targetScore: 10,
    deal: { hands: { a: ['2-3'], b: ['2-2', '5-6'] }, boneyard: [] },
  });
  g.play('b', '2-2', null);
  g.play('a', '2-3', 'L');
  assert.equal(g.status, 'matchEnd');
  assert.equal(g.matchWinnerId, 'a');
});

test('draw: must draw when stuck; drawn tile may then be played', () => {
  const g = new DominoGame({
    variant: 'draw', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1'], b: ['6-6', '2-2'] }, boneyard: ['4-5', '4-4'] },
  });
  g.play('b', '6-6', null);                  // b leads the highest double
  assert.equal(g.canDraw('a'), true);        // a has no 6
  assert.equal(g.canPass('a'), false);       // boneyard not empty → no passing
  const t1 = g.draw('a');
  assert.equal(t1.id, '4-4');                // still no 6 → draw again
  assert.equal(g.canDraw('a'), true);
  const t2 = g.draw('a');
  assert.equal(t2.id, '4-5');                // still no 6... boneyard empty now
  assert.equal(g.canDraw('a'), false);
  assert.equal(g.canPass('a'), true);        // now a may pass
});

test('allfives: lead [4-6] scores 10 immediately', () => {
  // No doubles dealt → highest pip tile leads → a leads [4-6]
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: { hands: { a: ['4-6', '0-3'], b: ['1-2', '2-3'] }, boneyard: [] },
  });
  assert.equal(g.turn, 'a');
  assert.deepEqual(g.legalMoves('a'), [{ tileId: '4-6', end: null }]);
  const r = g.play('a', '4-6', null);
  assert.equal(r.scored, 10);                // 6 + 4 = 10 → multiple of 5
  assert.equal(g.scores.a, 10);
});

test('allfives: lead double counted once; blocked spinner hand', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['5-5', '2-5', '3-5'], b: ['1-5', '4-5', '6-6'] },
      boneyard: [],
    },
  });
  assert.equal(g.turn, 'b');                 // b holds [6-6], the highest double
  g.play('b', '6-6', null);                  // endsTotal = 12 (counted once, not 24)
  assert.equal(g.endsTotal(), 12);
  assert.equal(g.scores.b, 0);               // 12 is not a multiple of 5 → no score
  assert.equal(g.spinner.id, '6-6');
  assert.equal(g.spinner.sidesFilled, 0);
  // Nobody holds a 6 → both pass → blocked hand
  assert.equal(g.canPass('a'), true);
  g.pass('a');
  assert.equal(g.canPass('b'), true);
  g.pass('b');
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.blocked, true);
});

test('allfives: full spinner sequence — sides then arms, scoring verified', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['5-5', '2-5', '3-5', '1-2'], b: ['1-5', '4-5', '3-4', '0-0'] },
      boneyard: [],
    },
  });
  assert.equal(g.turn, 'a');                 // highest double is [5-5] (b's 0-0 is lower)
  let r = g.play('a', '5-5', null);
  assert.equal(r.scored, 10);                // [5-5] lead = 10
  assert.equal(g.scores.a, 10);
  assert.equal(g.spinner.sidesFilled, 0);
  // U/D must not be open yet
  assert.deepEqual(g.attachableEnds().map(e => e.end).sort(), ['L', 'R']);
  g.play('b', '1-5', 'L');                   // covers spinner side → sidesFilled=1
  assert.equal(g.spinner.sidesFilled, 1);
  assert.equal(g.endsTotal(), 11);           // L=1, R=10 ([5-5] still at end)
  assert.deepEqual(g.attachableEnds().map(e => e.end).sort(), ['L', 'R']);
  g.play('a', '2-5', 'R');                   // covers other side → sidesFilled=2
  assert.equal(g.spinner.sidesFilled, 2);
  assert.equal(g.endsTotal(), 3);            // L=1, R=2; spinner stops counting
  assert.deepEqual(g.attachableEnds().map(e => e.end).sort(), ['D', 'L', 'R', 'U']);
  g.play('b', '4-5', 'U');                   // third arm opens (match = spinner value 5)
  assert.equal(g.endsTotal(), 7);            // 1 + 2 + 4
  r = g.play('a', '3-5', 'D');               // fourth arm: 1+2+4+3 = 10 → +10
  assert.equal(r.scored, 10);
  assert.equal(g.scores.a, 20);
  assert.equal(g.endsTotal(), 10);
});

test('allfives: non-lead spinner sequence opens arms after both sides filled', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: { hands: { a: ['4-6', '1-6', '3-6'], b: ['2-3', '0-3'] }, boneyard: ['2-6', '6-6'] }
  });
  // Neither holds double; a's 4-6 leads
  assert.equal(g.turn, 'a');
  g.play('a', '4-6', null);
  // b has no 4 or 6, draws 6-6 and plays it on R
  assert.equal(g.canDraw('b'), true);
  g.draw('b'); // draws 6-6
  g.play('b', '6-6', 'R');
  assert.equal(g.spinner.id, '6-6');
  assert.equal(g.spinner.sidesFilled, 1);
  assert.deepEqual(g.attachableEnds().map(e => e.end).sort(), ['L', 'R']);
  // a plays 1-6 on R -> both chain sides filled
  g.play('a', '1-6', 'R');
  assert.equal(g.spinner.sidesFilled, 2);
  assert.deepEqual(g.attachableEnds().map(e => e.end).sort(), ['D', 'L', 'R', 'U']);
  // b draws 2-6 and plays on U
  g.draw('b'); // draws 2-6
  g.play('b', '2-6', 'U');
  assert.equal(g.endsTotal(), 4 + 1 + 2); // L=4, R=1, U=2
});

test('allfives: double on an arm end counts full pips', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['3-5', '2-2'], b: ['5-5', '3-3', '0-0'] },
      boneyard: [],
    },
  });
  // b holds highest double [5-5] → b leads it: +10
  g.play('b', '5-5', null);
  assert.equal(g.scores.b, 10);
  // a plays [3-5] on L: ends L=3, R=10 → 13, no score
  let r = g.play('a', '3-5', 'L');
  assert.equal(r.scored ?? 0, 0);
  assert.equal(g.endsTotal(), 13);
  // b plays [3-3] on L: double at end counts 6 → 6+10 = 16, no score
  g.play('b', '3-3', 'L');
  assert.equal(g.endsTotal(), 16);
  // a plays [2-2]? doesn't match (3 or 5). a passes? boneyard empty → pass
  assert.equal(g.canPass('a'), true);
});

test('allfives: hand-end points rounded to nearest 5', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'],
    deal: { hands: { a: ['2-3', '0-1'], b: ['2-2', '1-2', '3-5'] }, boneyard: [] },
  });
  g.play('b', '2-2', null);                  // b leads the only double: total 4 → no score
  g.play('a', '2-3', 'L');                   // ends L=3, R=4 → total 7, no score
  g.play('b', '1-2', 'R');                   // match 2 → outer 1: total 3+1 = 4, no score
  g.play('a', '0-1', 'R');                   // match 1 → a dominoes
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.winnerId, 'a');
  assert.equal(g.handResult.points, 10);     // b left with [3-5] = 8 pips → rounds to 10
  assert.equal(g.scores.a, 10);
});

test('allfives: match ends immediately when target hit mid-hand', () => {
  const g = new DominoGame({
    variant: 'allfives', playerIds: ['a', 'b'], targetScore: 15,
    deal: { hands: { a: ['5-5', '2-5', '3-5'], b: ['1-5', '4-5', '0-1'] }, boneyard: [] },
  });
  g.play('a', '5-5', null);                  // +10
  g.play('b', '1-5', 'L');
  g.play('a', '2-5', 'R');                   // spinner both sides
  g.play('b', '4-5', 'U');
  g.play('a', '3-5', 'D');                   // 1+2+4+3=10 → a: 20 ≥ 15
  assert.equal(g.status, 'matchEnd');
  assert.equal(g.matchWinnerId, 'a');
});

test('fuzz: 300 random games per variant complete without errors', () => {
  for (const variant of ['block', 'draw', 'allfives']) {
    for (let s = 1; s <= 300; s++) {
      const g = new DominoGame({ variant, playerIds: ['a', 'b'], seed: s * 1337 });
      let guard = 0;
      while (g.status === 'playing' && guard++ < 500) {
        const pid = g.turn;
        const moves = g.legalMoves(pid);
        if (moves.length) {
          const m = moves[Math.floor(Math.random() * moves.length)];
          g.play(pid, m.tileId, m.end);
        } else if (g.canDraw(pid)) {
          g.draw(pid);
        } else if (g.canPass(pid)) {
          g.pass(pid);
        } else {
          assert.fail(`stuck state in ${variant} seed ${s}`);
        }
        if (g.status === 'handEnd') {
          g.nextHand(s);
        }
      }
      // match may legitimately run long; assert no corruption occurred
      const total = [...Object.values(g.hands), g.boneyard, g.moves.map(m => m.t)]
        .flat().map(t => t.id);
      assert.equal(new Set(total).size, total.length, `duplicate tile in ${variant} seed ${s}`);
    }
  }
});
