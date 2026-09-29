// js/domboard.js — F4.5: 2D DOM fallback table.
//
// WHY: the whole game table is a WebGL canvas. On machines without a usable GL
// context (old GPUs, blocklisted drivers, GPU blacklisting after a crash, some
// kiosk/VM environments) `new THREE.WebGLRenderer()` throws inside its
// constructor — and with it the entire game, even though the rules, the hand and
// the sockets are perfectly fine. This module renders the same table as plain DOM
// so the game stays playable, just without the 3D polish.
//
// CONTRACT: DomBoard is a drop-in for the subset of Board3D's surface app.js uses:
//   sync(view), setCanDraw(b), setMyTurn(b), setTheme(n), stats(), resize(),
//   dispose(), showMarkers(ends, scoreBy), clearMarkers(), animateDraw(t),
//   endFromPoint(x, y), highlightEnd(e), invalidate(), controls {enabled}
// Anything the 3D board does with meshes is a no-op here; anything the player can
// actually DO (see the chain, tap an end, draw from the boneyard) works.

import { tileImage } from './tiles.js?v=13';

/** True when a WebGL context can actually be created. Never throws. */
export function webglAvailable() {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

// ── chain model (pure, DOM-free, unit-testable) ─────────────────────────────
// A linear 2D chain: each played tile appended left or right of the previous,
// with doubles drawn crosswise. Far simpler than the 3D snake, and deliberately
// so — a fallback must be obviously correct, not clever.
export function buildChain(moves) {
  const out = [];
  for (const mv of moves) {
    const dbl = mv.t.a === mv.t.b;
    out.push({ id: mv.t.id, a: mv.t.a, b: mv.t.b, dbl, end: mv.e, flip: !!mv.f });
  }
  return out;
}

/** Open ends of a 2D chain: the two outermost values (or none when empty). */
export function chainEnds(moves) {
  if (!moves || !moves.length) return [];
  const heads = {};
  for (const mv of moves) {
    if (mv.e === 'L' || mv.e === 'U') heads.left = mv.t;
    else heads.right = mv.t;
  }
  const ends = [];
  const L = heads.left, R = heads.right;
  const dblPips = t => t.a;
  if (L) ends.push({ end: 'L', value: dblPips(L) });
  if (R) ends.push({ end: 'R', value: dblPips(R) });
  return ends;
}

export class DomBoard {
  constructor(canvas, { onMarkerClick, onBoardMiss, onBoneyardClick } = {}) {
    this.onMarkerClick = onMarkerClick;
    this.onBoardMiss = onBoardMiss;
    this.onBoneyardClick = onBoneyardClick;
    this.isDomFallback = true;
    this.canDraw = false;
    this._myTurn = false;
    this._theme = 'classic';
    this._view = null;
    this._ends = [];
    this._scoreBy = null;
    this._highlight = null;
    this.controls = { enabled: true };   // app.js pokes this during drags

    // Replace the (unusable) canvas with a DOM board of the same footprint.
    this.root = document.createElement('div');
    this.root.id = 'table2d';
    this.root.className = 'board2d';
    this.root.setAttribute('role', 'img');
    this.root.setAttribute('aria-label', 'طاولة الدومينو (عرض مبسّط)');
    const host = (canvas && canvas.parentElement) || document.body;
    if (canvas && canvas.style) canvas.style.display = 'none';
    host.appendChild(this.root);

    this.chainEl = document.createElement('div');
    this.chainEl.className = 'b2-chain';
    this.markerEl = document.createElement('div');
    this.markerEl.className = 'b2-markers';
    this.boneEl = document.createElement('div');
    this.boneEl.className = 'b2-boneyard hidden';
    this.noteEl = document.createElement('div');
    this.noteEl.className = 'b2-note';
    this.noteEl.textContent = 'وضع العرض المبسّط (بدون 3D)';
    this.root.append(this.chainEl, this.markerEl, this.boneEl, this.noteEl);

    this.boneEl.addEventListener('click', () => {
      if (this.canDraw) this.onBoneyardClick?.(null);
    });
    this.root.addEventListener('click', (e) => {
      const m = e.target.closest?.('[data-end]');
      if (m) { this.onMarkerClick?.(m.dataset.end); e.stopPropagation(); return; }
      this.onBoardMiss?.();
    });
  }

  // ── sync: re-render the chain from an engine view ──
  sync(view) {
    if (!view) return;
    this._view = view;
    const moves = view.moves || [];
    const chain = buildChain(moves);
    const keep = this.chainEl.childElementCount === chain.length;
    if (!keep) {
      const nodes = [];
      for (const t of chain) {
        const el = document.createElement('div');
        el.className = 'b2-tile' + (t.dbl ? ' dbl' : '');
        el.style.backgroundImage = `url(${tileImage(t.a, t.b)})`;
        if (t.flip) el.classList.add('flip');
        nodes.push(el);
      }
      this.chainEl.replaceChildren(...nodes);
      // Newest tile in view.
      const last = this.chainEl.lastElementChild;
      if (last) {
        last.classList.add('new');
        setTimeout(() => last.classList.remove('new'), 500);
      }
      // Scroll the newest tile into view along the strip.
      requestAnimationFrame(() => { this.chainEl.scrollLeft = this.chainEl.scrollWidth; });
    }
    this._syncBoneyard(view.boneyardCount ?? 0);
  }

  _syncBoneyard(count) {
    this._boneCount = count;
    this.boneEl.classList.toggle('hidden', !(this.canDraw && count > 0));
    this.boneEl.textContent = count > 0 ? `🁫 السحابة (${count}) — اضغط للسحب` : '';
  }

  setCanDraw(b) { this.canDraw = !!b; this._syncBoneyard(this._boneCount || 0); }
  setMyTurn(b) {
    this._myTurn = !!b;
    this.root.classList.toggle('my-turn', this._myTurn);
  }
  setTheme(name) {
    if (typeof name !== 'string' || name === this._theme) return false;
    this._theme = name;
    // Repaint every tile image from the new theme's painters.
    const children = [...this.chainEl.children];
    if (this._view?.moves) {
      buildChain(this._view.moves).forEach((t, i) => {
        if (children[i]) children[i].style.backgroundImage = `url(${tileImage(t.a, t.b)})`;
      });
    }
    return true;
  }
  invalidate() { /* no incremental cursor to invalidate in 2D */ }
  resize() { /* DOM reflows itself */ }
  stats() {
    return {
      calls: 0, tris: 0, geos: 0, texs: 0, programs: 0,
      chainMeshes: this.chainEl.childElementCount,
      boneMeshes: this.canDraw ? 1 : 0,
      matPool: 0, texPool: 0, anims: this.chainEl.querySelectorAll('.new').length,
      myTurn: this._myTurn, reducedMotion: false, dom: true,
    };
  }

  // ── markers ──
  showMarkers(ends, scoreBy = null) {
    this._ends = [...(ends || [])];
    this._scoreBy = scoreBy;
    this._renderMarkers();
  }
  _renderMarkers() {
    const nodes = [];
    for (const e of this._ends) {
      const label = e === 'L' ? '◀ يسار' : e === 'R' ? 'يمين ▶' : e === 'U' ? '▲ فوق' : e === 'D' ? '▼ تحت' : e;
      const b = document.createElement('button');
      b.className = 'b2-marker';
      b.dataset.end = e;
      b.type = 'button';
      const sc = this._scoreBy && this._scoreBy[e];
      b.textContent = sc != null ? `${label} +${sc}` : label;
      if (this._highlight != null && e !== this._highlight) b.classList.add('dim');
      nodes.push(b);
    }
    this.markerEl.replaceChildren(...nodes);
  }
  clearMarkers() { this._ends = []; this._scoreBy = null; this.markerEl.replaceChildren(); }
  highlightEnd(end) { this._highlight = end ?? null; this._renderMarkers(); }

  /** Nearest marker to a client point (used by drag & drop). */
  endFromPoint(clientX, clientY) {
    let best = null, bestD = Infinity;
    for (const b of this.markerEl.children) {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(clientX - cx, clientY - cy);
      if (d < bestD) { bestD = d; best = b; }
    }
    return bestD < 110 && best ? best.dataset.end : null;
  }

  /** The 2D board has no fly-to-hand animation; just report it was drawn. */
  animateDraw() { /* no-op in 2D */ }

  dispose() {
    this.root?.remove();
    this.chainEl?.replaceChildren();
    this.markerEl?.replaceChildren();
  }
}
