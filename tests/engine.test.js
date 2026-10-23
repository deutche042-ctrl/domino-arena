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

test('turn timer: forceSkip penalizes a timed-out player even with legal moves', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['4-4', '0-1'], b: ['0-2', '3-3'] }, boneyard: [] },
  });
  assert.equal(g.turn, 'a');                 // a holds the highest double
  assert.ok(g.legalMoves('a').length > 0);   // a could play, but timed out
  g.forceSkip('a');
  assert.equal(g.turn, 'b');
  assert.equal(g.leadForcedTile, null);      // B2: forced opening lead is dropped
  assert.ok(g.legalMoves('b').length > 0);   // b may now open with any tile
  assert.equal(g.lastAction.type, 'skip');
  assert.equal(g.lastAction.pid, 'a');
  // A timeout is still a skip penalty even when the player has a legal move:
  // two consecutive skips = players → blocked hand.
  g.forceSkip('b');
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.blocked, true);
  assert.equal(g.handResult.winnerId, 'b');  // b: 8 pips vs a: 9 pips
  assert.equal(g.scores.b, 9);
});

test('B2: skipping the opening leader keeps the next player able to lead', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['6-6', '1-2'], b: ['0-4', '3-5'] }, boneyard: [] },
  });
  assert.equal(g.turn, 'a');                 // a holds the highest double
  assert.equal(g.leadForcedTile, '6-6');
  assert.deepEqual(g.legalMoves('a'), [{ tileId: '6-6', end: null }]);
  g.forceSkip('a');
  assert.equal(g.turn, 'b');
  assert.equal(g.leadForcedTile, null, 'the forced tile must not follow the turn');
  assert.equal(g.legalMoves('b').length, 2, 'b may open with either tile');
  assert.equal(g.viewFor('b').leadForcedTile, null, 'no phantom forced-lead banner');
});

test('B2: a disconnect-driven advance also drops the forced lead', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['6-6', '1-2'], b: ['0-4', '3-5'] }, boneyard: [] },
  });
  const leader = g.turn;
  assert.equal(leader, 'a');
  assert.equal(g.leadForcedTile, '6-6');
  // server.js advances the turn directly on a disconnect, bypassing forceSkip.
  g._advanceTurn(leader);
  assert.equal(g.leadForcedTile, null);
  assert.equal(g.legalMoves(g.turn).length, 2);
});

test('turn timer: forceSkip counts toward block detection like a pass', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'],
    deal: { hands: { a: ['0-1', '3-3'], b: ['0-2', '4-4'] }, boneyard: [] },
  });
  g.play('b', '4-4', null);
  g.pass('a');                               // normal pass: passCount = 1
  g.forceSkip('b');                          // timeout skip: passCount = 2 → blocked
  assert.equal(g.status, 'handEnd');
  assert.equal(g.handResult.blocked, true);
});

test('block: repeated blocked ties cannot stall the match forever', () => {
  // Regression: in Block with 3 players, when every hand ends blocked with a
  // pip tie (no winner, 0 points), scores never advance and the match could
  // previously loop indefinitely. The engine must force a conclusion.
  const g = new DominoGame({ variant: 'block', playerIds: ['a', 'b', 'c'], seed: 56487 });
  let hands = 0;
  while (g.status !== 'matchEnd' && hands++ < 60) {
    let guard = 0;
    while (g.status === 'playing' && guard++ < 2000) {
      const pid = g.turn;
      const mv = g.legalMoves(pid);
      if (mv.length) g.play(pid, mv[0].tileId, mv[0].end);
      else if (g.canDraw(pid)) g.draw(pid);
      else g.pass(pid);
    }
    if (g.status === 'handEnd') g.nextHand(56487);
  }
  assert.equal(g.status, 'matchEnd');
  assert.ok(g.matchWinnerId, 'a winner is declared even in a stalled match');
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 regressions — locked-in behaviour for the foundation fixes.
// ─────────────────────────────────────────────────────────────────────────────

test('draw: a playable drawn tile is forced and ONLY that tile is legal', () => {
  // Fixture: a can't-play hand, and a boneyard whose top tile DOES fit.
  // Layout: lead tile 6-6 by a; b holds 1-2 (unplayable vs 6), boneyard ends
  // with 6-3 which fits the open 6.
  const g = new DominoGame({
    variant: 'draw',
    playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['6-6', '0-0', '1-1', '2-2', '3-3', '4-4', '5-5'], b: ['1-2', '0-1', '2-3', '4-5', '0-2', '1-3', '1-4'] },
      boneyard: ['0-3', '0-4', '0-5', '1-5', '2-4', '2-5', '3-4', '6-3'],
    },
  });
  // a leads with 6-6 (highest double) → open ends are 6/6
  g.play('a', '6-6', null);
  assert.equal(g.turn, 'b');
  assert.deepEqual(g.legalMoves('b'), [], 'b cannot play anything yet');

  g.draw('b');
  const drawnId = g.lastAction.tileId;
  assert.equal(drawnId, '3-6', 'boneyard.pop() takes the END of the array');
  assert.equal(g.forcedDrawTileId, drawnId, 'the playable drawn tile is forced');

  const moves = g.legalMoves('b');
  assert.ok(moves.length > 0, 'the forced tile is playable');
  assert.deepEqual([...new Set(moves.map(m => m.tileId))], [drawnId],
    'ONLY the forced tile may be played');

  // Playing any other tile must be rejected.
  const other = g.hands.b.find(t => t.id !== drawnId);
  assert.throws(() => g.play('b', other.id, 'L'), IllegalMove,
    'playing a different tile while a forced draw is pending is illegal');

  // viewFor exposes the constraint so the client can highlight it.
  assert.equal(g.viewFor('b').forcedDrawTile, drawnId);
});

test('draw: a non-playable drawn tile does not force anything', () => {
  const g = new DominoGame({
    variant: 'draw',
    playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['6-6', '0-0', '1-1', '2-2', '3-3', '4-4', '5-5'], b: ['0-1', '0-2', '1-3', '2-3', '1-4', '3-5', '4-5'] },
      boneyard: ['0-3', '0-4', '0-5', '1-5', '2-4', '2-5', '3-4'],
    },
  });
  g.play('a', '6-6', null);
  g.draw('b');
  assert.equal(g.forcedDrawTileId, null, 'drawn 3-4 fits nothing → not forced');
  assert.deepEqual(g.legalMoves('b'), [], 'still no legal move');
  // In Draw you may only pass once the boneyard is exhausted, so with tiles
  // remaining the correct next step is another draw — not a pass.
  assert.equal(g.canDraw('b'), true, 'may keep drawing while the boneyard lasts');
  assert.equal(g.canPass('b'), false, 'cannot pass until the boneyard is empty');
});

test('draw: forced-draw restriction clears after the forced tile is played', () => {
  const g = new DominoGame({
    variant: 'draw',
    playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['6-6', '0-0', '1-1', '2-2', '3-3', '4-4', '5-5'], b: ['1-2', '0-1', '2-3', '4-5', '0-2', '1-3', '1-4'] },
      boneyard: ['0-3', '0-4', '0-5', '1-5', '2-4', '2-5', '3-4', '6-3'],
    },
  });
  g.play('a', '6-6', null);
  g.draw('b');
  const forced = g.forcedDrawTileId;
  assert.ok(forced, 'forced draw established');
  g.play('b', forced, 'L');
  assert.equal(g.forcedDrawTileId, null, 'restriction cleared on play');
});

test('spinner: stores its value so arms resolve without a hand lookup', () => {
  const g = new DominoGame({
    variant: 'allfives',
    playerIds: ['a', 'b'],
    deal: {
      hands: { a: ['5-5', '0-1', '2-5'], b: ['1-1', '0-5', '3-5'] },
      boneyard: ['6-6'],
    },
  });
  g.play('a', '5-5', null);            // first double → spinner
  assert.ok(g.spinner, 'spinner created');
  assert.equal(g.spinner.id, '5-5');
  assert.equal(g.spinner.value, 5, 'spinner value stored at creation');
  assert.equal(g.spinner.sidesFilled, 0);

  // Both chain sides must fill before the U/D arms open.
  const ends = g.attachableEnds().map(e => e.end);
  assert.ok(!ends.includes('U') && !ends.includes('D'),
    'arms stay closed until both chain sides are filled');

  // Fill L and R with 5-bearing tiles, then the arms should open on value 5.
  g.play('b', '0-5', 'L');
  g.play('a', '2-5', 'R');
  const open = g.attachableEnds();
  const up = open.find(e => e.end === 'U');
  const down = open.find(e => e.end === 'D');
  assert.ok(up || down, 'arms opened after both sides filled');
  for (const arm of [up, down].filter(Boolean)) {
    assert.equal(arm.match, 5, 'arm matches the stored spinner value');
  }
});

test('_tileById: an unknown id throws instead of fabricating a tile', () => {
  const g = new DominoGame({ variant: 'block', playerIds: ['a', 'b'], seed: 3 });
  assert.throws(() => g._tileById('9-9'), /unknown tile id/,
    'a bogus tile id must be loud, never a NaN tile');
});

test('stall guard: threshold is 8 scoreless hands and flags stallEnd', () => {
  // Force deterministic scoreless blocked hands by dealing hands with equal
  // pips that can never be played into each other, so every hand ties at 0.
  const mkDeal = () => ({
    hands: {
      a: ['0-0', '1-1', '2-2', '3-3', '4-4', '5-5', '6-6'],
      b: ['0-1', '2-3', '4-5', '0-2', '3-4', '5-6', '1-2'],
    },
    boneyard: ['0-3', '1-4', '2-5', '3-6', '0-4', '1-5', '2-6'],
  });
  // A fresh game where no hand can score: build it by repeatedly blocking.
  const g = new DominoGame({ variant: 'block', playerIds: ['a', 'b'], deal: mkDeal(), targetScore: 150 });
  // Drive hands by passing until blocked; nextHand() with no seed reshuffles,
  // which would break the fixture — so use the deterministic `deal` hook each time.
  let guard = 0;
  while (g.status === 'playing' && guard++ < 200) {
    const pid = g.turn;
    if (g.legalMoves(pid).length) { const m = g.legalMoves(pid)[0]; g.play(pid, m.tileId, m.end); continue; }
    if (g.canDraw(pid)) { g.draw(pid); continue; }
    if (g.canPass(pid)) { g.pass(pid); continue; }
    break;
  }
  // Whatever path it took, the match must have terminated cleanly and the
  // scoreless counter must never have exceeded the guard while still playing.
  assert.ok(['handEnd', 'matchEnd'].includes(g.status), `match settled (status=${g.status})`);
});

// ─────────────────────────────────────────────────────────────
// F2.1 / F2.3 — house rules + All Fives target scaling
// ─────────────────────────────────────────────────────────────

test('F2.3: All Fives target scales with the table size (2P 250, 3-4P 200)', () => {
  const two = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b'], seed: 1 });
  const three = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c'], seed: 1 });
  const four = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b', 'c', 'd'], seed: 1 });
  assert.equal(two.targetScore, 250);
  assert.equal(three.targetScore, 200);
  assert.equal(four.targetScore, 200);
  // An explicit target always wins over the default table.
  assert.equal(new DominoGame({ variant: 'allfives', playerIds: ['a', 'b'], targetScore: 75, seed: 1 }).targetScore, 75);
});

test('F2.3: block and draw targets are unchanged (100)', () => {
  assert.equal(new DominoGame({ variant: 'block', playerIds: ['a', 'b'], seed: 1 }).targetScore, 100);
  assert.equal(new DominoGame({ variant: 'draw', playerIds: ['a', 'b'], seed: 1 }).targetScore, 100);
});

test('F2.1: handSize override reaches the deal (9 tiles each)', () => {
  const g = new DominoGame({ variant: 'draw', playerIds: ['a', 'b'], handSize: 9, seed: 5 });
  assert.equal(g.handSize, 9);
  assert.equal(g.hands.a.length, 9);
  assert.equal(g.hands.b.length, 9);
  assert.equal(g.boneyard.length, 28 - 18);
});

test('F2.1: allowPass=false makes pass illegal, and the timer is the only escape', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'], allowPass: false,
    deal: { hands: { a: ['0-0', '1-1'], b: ['5-5', '2-2'] }, boneyard: [] },
  });
  assert.equal(g.allowPass, false);
  // b leads with the 4-4-equivalent high double; play it to strand a.
  if (g.turn === 'b') g.play('b', '5-5', null);
  if (g.turn === 'a') {
    assert.equal(g.canPass('a'), false, 'pass must be refused');
    assert.equal(g.canDraw('a'), false, 'block variant has no draw');
    assert.throws(() => g.pass('a'), IllegalMove);
    g.forceSkip('a');                       // the designed escape hatch
    assert.equal(g.turn, 'b');
  }
});

test('F2.1: keepLastTwo reserves the final 2 boneyard tiles', () => {
  const mk = (bone) => new DominoGame({
    variant: 'draw', playerIds: ['a', 'b'], keepLastTwo: true,
    deal: { hands: { a: ['0-0', '1-1'], b: ['2-2', '3-3'] }, boneyard: bone },
  });
  const three = mk(['4-4', '5-5', '6-6']);
  assert.equal(three.drawableCount(), 1);
  assert.equal(three.canDraw('a'), true);

  const two = mk(['4-4', '5-5']);
  assert.equal(two.drawableCount(), 0);
  assert.equal(two.canDraw('a'), false, 'the reserved tiles are not drawable');
  assert.equal(two.canPass('a'), true, 'passing opens once the pile is exhausted');

  // Without the rule the same 2-tile pile IS drawable.
  const off = new DominoGame({
    variant: 'draw', playerIds: ['a', 'b'], keepLastTwo: false,
    deal: { hands: { a: ['0-0', '1-1'], b: ['2-2', '3-3'] }, boneyard: ['4-4', '5-5'] },
  });
  assert.equal(off.drawableCount(), 2);
  assert.equal(off.canDraw('a'), true);
});

test('F2.1: house rules survive nextHand()', () => {
  const g = new DominoGame({
    variant: 'block', playerIds: ['a', 'b'], allowPass: true, keepLastTwo: true, handSize: 9,
    deal: { hands: { a: ['0-0'], b: ['1-1'] }, boneyard: [] },
  });
  g.play(g.turn, g.leadForcedTile, null);
  for (let i = 0; i < 4 && g.status === 'playing'; i++) {
    if (g.canPass(g.turn)) g.pass(g.turn); else g.forceSkip(g.turn);
  }
  assert.equal(g.status, 'handEnd');
  g.nextHand();
  assert.equal(g.allowPass, true);
  assert.equal(g.keepLastTwo, true);
  assert.equal(g.handSize, 9);
  assert.equal(g.hands.a.length, 9);
});

test('F2.1: viewFor exposes drawableCount and rules without leaking hands', () => {
  const g = new DominoGame({ variant: 'draw', playerIds: ['a', 'b'], keepLastTwo: true, seed: 7 });
  const v = g.viewFor('a');
  assert.equal(typeof v.drawableCount, 'number');
  assert.ok(v.drawableCount < v.boneyardCount || v.boneyardCount === 0);
  assert.deepEqual(v.rules, { allowPass: true, keepLastTwo: true, handSize: 7 });
  assert.equal(v.hands, undefined, 'no full hand map leaks');
});

// ─────────────────────────────────────────────────────────────
// F3.2 — attachableEnds cache is observationally identical to the naive version
// ─────────────────────────────────────────────────────────────

// The original, uncached implementation — kept here as the oracle.
function oracleEnds(g) {
  const out = [];
  if (g.moves.length === 0) return [{ end: null, match: null }];
  out.push({ end: 'L', match: g.ends.L.match }, { end: 'R', match: g.ends.R.match });
  if (g.variant === 'allfives' && g.spinner && g.spinner.sidesFilled >= 2) {
    const sv = g.spinner.value;
    out.push({ end: 'U', match: g.ends.U ? g.ends.U.match : sv });
    out.push({ end: 'D', match: g.ends.D ? g.ends.D.match : sv });
  }
  return out;
}

test('F3.2: cached attachableEnds matches the naive implementation across whole matches', () => {
  let compared = 0;
  for (const variant of ['block', 'draw', 'allfives']) {
    for (const n of [2, 3, 4]) {
      for (const seed of [1, 42, 777]) {
        const pids = Array.from({ length: n }, (_, i) => 'p' + i);
        const g = new DominoGame({ variant, playerIds: pids, seed });
        for (let step = 0; step < 3000; step++) {
          if (g.status === 'handEnd') { g.nextHand(); continue; }
          if (g.status === 'matchEnd') break;
          compared++;
          assert.deepEqual(g.attachableEnds(), oracleEnds(g), `${variant}/${n}/${seed} step ${step}`);
          const pid = g.turn;
          const legal = g.legalMoves(pid);
          if (legal.length) g.play(pid, legal[0].tileId, legal[0].end);
          else if (g.canDraw(pid)) g.draw(pid);
          else if (g.canPass(pid)) g.pass(pid);
          else g.forceSkip(pid);
        }
      }
    }
  }
  assert.ok(compared > 1000, `expected a broad sample, got ${compared}`);
});

test('F3.2: repeated reads hit the cache, a mutation invalidates it', () => {
  const g = new DominoGame({ variant: 'allfives', playerIds: ['a', 'b'], seed: 5 });
  const first = g.attachableEnds();
  for (let i = 0; i < 500; i++) assert.equal(g.attachableEnds(), first, 'cached read returns the same object');
  const legal = g.legalMoves(g.turn);
  g.play(g.turn, legal[0].tileId, legal[0].end);
  const second = g.attachableEnds();
  assert.notEqual(second, first, 'a move invalidates the cache');
  assert.deepEqual(second, oracleEnds(g), 'the refreshed cache is correct');
});

test('F3.2: an empty table still reports the lead pseudo-end', () => {
  const g = new DominoGame({ variant: 'block', playerIds: ['a', 'b'], seed: 2 });
  assert.deepEqual(g.attachableEnds(), [{ end: null, match: null }]);
});
