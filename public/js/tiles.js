// js/tiles.js — procedural domino art (canvas): pip faces for 3D textures + hand images
//
// F4.3 — themes. Every theme is drawn procedurally (zero image assets); a theme is
// a palette + a set of overridable painters. `setTheme(name)` switches the active
// theme and invalidates the dataURL cache; the 3D layer records the theme in its
// texture cache key, so switching themes mid-session just repaints.

const PIP_POS = {
  0: [],
  1: [[.5, .5]],
  2: [[.28, .28], [.72, .72]],
  3: [[.28, .28], [.5, .5], [.72, .72]],
  4: [[.3, .3], [.7, .3], [.3, .7], [.7, .7]],
  5: [[.28, .28], [.72, .28], [.5, .5], [.28, .72], [.72, .72]],
  6: [[.3, .26], [.7, .26], [.3, .5], [.7, .5], [.3, .74], [.7, .74]],
};

const classicPips = { 1: '#c22f2f', 2: '#1d1d24', 3: '#1d1d24', 4: '#1d3fbf', 5: '#1d3fbf', 6: '#1d7a3a' };

/** Round pips with a soft highlight (classic + wood + piano share this). */
function paintRoundPips(ctx, value, x, y, w, h, colors, highlight = 'rgba(255,255,255,.28)') {
  const s = Math.min(w, h);
  const r = s * 0.085;
  for (const [px, py] of PIP_POS[value] || []) {
    ctx.beginPath();
    ctx.fillStyle = colors[value] || '#1d1d24';
    ctx.arc(x + px * w, y + py * h, r, 0, Math.PI * 2);
    ctx.fill();
    if (highlight) {
      ctx.beginPath();
      ctx.fillStyle = highlight;
      ctx.arc(x + px * w - r * .3, y + py * h - r * .3, r * .35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Flat neon pips with an outer glow (neon theme). */
function paintNeonPips(ctx, value, x, y, w, h, color) {
  const s = Math.min(w, h);
  const r = s * 0.09;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.18;
  ctx.fillStyle = color;
  for (const [px, py] of PIP_POS[value] || []) {
    ctx.beginPath();
    ctx.arc(x + px * w, y + py * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const THEMES = {
  // the original ivory tile — the default, byte-for-byte unchanged output
  classic: {
    label: 'كلاسيك',
    faceFill: (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, w * .1, w / 2, h / 2, h * .75);
      g.addColorStop(0, '#fbf7ea'); g.addColorStop(1, '#e6dfc9');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    },
    inner: 'rgba(60,50,30,.35)',
    divider: 'rgba(60,50,30,.6)',
    pips: (ctx, v, x, y, w, h) => paintRoundPips(ctx, v, x, y, w, h, classicPips),
    back: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#2b3350'); g.addColorStop(1, '#171d33');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(140,170,255,.25)';
      ctx.lineWidth = 4; ctx.strokeRect(16, 16, 224, 480);
      ctx.beginPath(); ctx.arc(128, 256, 62, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(140,170,255,.35)'; ctx.stroke();
      // Drawn mini-domino motif. This used to be a 🁢 fillText, which fell back to
      // a striped tofu box on systems without a domino glyph — visible on every
      // boneyard tile.
      const dw = 56, dh = 112;
      ctx.fillStyle = 'rgba(190,205,255,.5)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(128 - dw / 2, 256 - dh / 2, dw, dh, 9);
      else ctx.rect(128 - dw / 2, 256 - dh / 2, dw, dh);
      ctx.fill();
      ctx.strokeStyle = 'rgba(43,51,80,.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(128 - dw / 2 + 7, 256); ctx.lineTo(128 + dw / 2 - 7, 256);
      ctx.stroke();
      ctx.fillStyle = 'rgba(43,51,80,.85)';
      for (const [px, py] of [[-13, -30], [13, -30], [-13, 22], [13, 22]]) {
        ctx.beginPath(); ctx.arc(128 + px, 256 + py, 5, 0, Math.PI * 2); ctx.fill();
      }
    },
  },

  // dark felt with glowing cyan/magenta pips — reads well on a dim phone
  neon: {
    label: 'نيون',
    faceFill: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#12172b'); g.addColorStop(1, '#0a0d1c');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    },
    inner: 'rgba(46,230,168,.35)',
    divider: 'rgba(46,230,168,.55)',
    pips: (ctx, v, x, y, w, h) => paintNeonPips(ctx, v, x, y, w, h, v >= 4 ? '#2ee6a8' : '#ff5ad0'),
    back: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0d1b2a'); g.addColorStop(1, '#05080f');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(46,230,168,.5)'; ctx.lineWidth = 4; ctx.strokeRect(16, 16, 224, 480);
      ctx.save(); ctx.shadowColor = '#2ee6a8'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.arc(128, 256, 58, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(46,230,168,.65)'; ctx.lineWidth = 6; ctx.stroke();
      ctx.restore();
    },
  },

  // warm wood grain with dark cream-highlighted pips
  wood: {
    label: 'خشب',
    faceFill: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#c98a4b'); g.addColorStop(.5, '#e0a86a'); g.addColorStop(1, '#b8753c');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // grain streaks
      ctx.globalAlpha = .12;
      for (let i = 0; i < 26; i++) {
        const y = (i / 26) * h + Math.sin(i * 1.7) * 6;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * .35, y + 5, w * .65, y - 5, w, y + 2);
        ctx.strokeStyle = i % 2 ? '#5c3a17' : '#f3d6ac';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
    inner: 'rgba(70,40,12,.4)',
    divider: 'rgba(70,40,12,.65)',
    pips: (ctx, v, x, y, w, h) => paintRoundPips(ctx, v, x, y, w, h,
      { 1: '#3a2410', 2: '#3a2410', 3: '#3a2410', 4: '#3a2410', 5: '#3a2410', 6: '#3a2410' },
      'rgba(255,240,214,.5)'),
    back: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#5a3a1c'); g.addColorStop(1, '#3d2611');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(243,214,172,.35)'; ctx.lineWidth = 4; ctx.strokeRect(16, 16, 224, 480);
      ctx.beginPath(); ctx.arc(128, 256, 60, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(243,214,172,.4)'; ctx.stroke();
    },
  },

  // glossy black keys with white pips
  piano: {
    label: 'بيانو',
    faceFill: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#20222a'); g.addColorStop(.5, '#0e0f14'); g.addColorStop(1, '#1a1c24');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // glossy sheen on the top half
      const sheen = ctx.createLinearGradient(0, 0, w, h * .5);
      sheen.addColorStop(0, 'rgba(255,255,255,.10)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen; ctx.fillRect(0, 0, w, h * .5);
    },
    inner: 'rgba(255,255,255,.22)',
    divider: 'rgba(255,255,255,.4)',
    pips: (ctx, v, x, y, w, h) => paintRoundPips(ctx, v, x, y, w, h,
      { 1: '#f4f4ef', 2: '#f4f4ef', 3: '#f4f4ef', 4: '#f4f4ef', 5: '#f4f4ef', 6: '#f4f4ef' },
      'rgba(0,0,0,.35)'),
    back: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#2a2d36'); g.addColorStop(1, '#101218');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 4; ctx.strokeRect(16, 16, 224, 480);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(24 + i * 60, 24); ctx.lineTo(24 + i * 60, 488);
        ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 2; ctx.stroke();
      }
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES);
export function themeLabel(name) { return (THEMES[name] || THEMES.classic).label; }

let activeTheme = 'classic';
export function getTheme() { return activeTheme; }
/** Switch the active tile theme. Returns true if it actually changed. */
export function setTheme(name) {
  if (!THEMES[name] || name === activeTheme) return false;
  activeTheme = name;
  dataUrlCache.clear();   // hand images are theme-specific
  return true;
}
function theme() { return THEMES[activeTheme] || THEMES.classic; }

// ── painters ─────────────────────────────────────────────────────────────────
// The art below is authored in a fixed 256×512 logical space (every coordinate
// in the themes is in that space). `faceCanvas(px)` keeps the art identical at
// any resolution by scaling the 2D context once, so the low tier can paint
// 128×256 faces without clipping or misplacing a single pip.
const FACE_W = 256, FACE_H = 512;

function faceCanvas(px) {
  const scale = Math.max(0.25, Math.min(2, (Number(px) || FACE_W) / FACE_W));
  const c = document.createElement('canvas');
  c.width = Math.round(FACE_W * scale);
  c.height = Math.round(FACE_H * scale);
  const ctx = c.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);   // logical 256×512 from here on
  return { c, ctx };
}

/**
 * Face texture: value a on top half, b on bottom.
 * `px` is the requested pixel WIDTH (default full 256); height follows 1:2.
 */
export function tileFaceCanvas(a, b, px = FACE_W) {
  const { c, ctx } = faceCanvas(px);
  const t = theme();
  t.faceFill(ctx, FACE_W, FACE_H, a, b);
  // inner border
  ctx.strokeStyle = t.inner;
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, 228, 484);
  // divider
  ctx.beginPath();
  ctx.moveTo(20, 256); ctx.lineTo(236, 256);
  ctx.lineWidth = 6; ctx.strokeStyle = t.divider;
  ctx.stroke();
  t.pips(ctx, a, 20, 20, 216, 216);
  t.pips(ctx, b, 20, 276, 216, 216);
  return c;
}

/** Themed back face. `px` is the requested pixel width (default 256). */
export function tileBackCanvas(px = FACE_W) {
  const { c, ctx } = faceCanvas(px);
  theme().back(ctx, FACE_W, FACE_H);
  return c;
}

const dataUrlCache = new Map();
/** dataURL for hand tiles (vertical, a over b) — themed, always full size. */
export function tileImage(a, b) {
  const key = `${activeTheme}:${a}-${b}`;
  if (!dataUrlCache.has(key)) dataUrlCache.set(key, tileFaceCanvas(a, b).toDataURL());
  return dataUrlCache.get(key);
}

// ── felt ─────────────────────────────────────────────────────────────────────
// Theme-tinted felt palettes. The board rebuilds its felt texture on a theme
// switch, so the table follows the tiles instead of staying classic green.
const FELT = {
  classic: { inner: '#217a59', mid: '#124a3a', outer: '#0a2f26', stitchA: '#06231c', stitchB: '#2f8a66', emblem: '#ffffff' },
  neon:    { inner: '#123a3a', mid: '#0a2130', outer: '#040a12', stitchA: '#03141a', stitchB: '#1f8a72', emblem: '#7ef7d0' },
  wood:    { inner: '#6e4523', mid: '#452a11', outer: '#241505', stitchA: '#1b0e03', stitchB: '#8f5e2d', emblem: '#f3d6ac' },
  piano:   { inner: '#23252f', mid: '#12141b', outer: '#05060a', stitchA: '#030409', stitchB: '#3a3d4f', emblem: '#dfe4ff' },
};

// One 256×256 noise tile, generated once and repeated by the 2D context. The
// old code ran getImageData/putImageData over the whole 1024² felt (1,048,576
// pixels) on every theme switch; a pattern fill is ~16× cheaper for the same nap.
let _noiseTile = null;
function noiseTile() {
  if (_noiseTile) return _noiseTile;
  const n = document.createElement('canvas');
  n.width = n.height = 256;
  const g = n.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - .5) * 90;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  _noiseTile = n;
  return n;
}

/** Felt texture for the table. `name` selects the theme palette. */
export function feltCanvas(name = activeTheme) {
  const pal = FELT[name] || FELT.classic;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(512, 512, 80, 512, 512, 720);
  g.addColorStop(0, pal.inner);
  g.addColorStop(.7, pal.mid);
  g.addColorStop(1, pal.outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  // fine felt nap — one subtle stitch direction only (a full grid moirés
  // into diagonal bands when the texture is minified on the table cap)
  ctx.globalAlpha = 0.028;
  for (let i = 0; i < 1024; i += 5) {
    ctx.fillStyle = i % 10 ? pal.stitchA : pal.stitchB;
    ctx.fillRect(0, i, 1024, 2);
  }
  ctx.globalAlpha = 1;
  // felt noise — a repeated 256² tile overlaid onto the 1024² gradient
  const pattern = ctx.createPattern(noiseTile(), 'repeat');
  if (pattern) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.restore();
  }
  // subtle center watermark — drawn, never a font glyph. The old 🁢 fillText fell
  // back to a striped tofu box on systems without a domino emoji, which read as a
  // rendering artifact across the middle of the table.
  ctx.save();
  ctx.globalAlpha = .05;
  ctx.strokeStyle = pal.emblem;
  ctx.lineWidth = 7;
  const bw = 300, bh = 620, br = 46;
  const bx = 512 - bw / 2, by = 512 - bh / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, br); else ctx.rect(bx, by, bw, bh);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx + 30, 512); ctx.lineTo(bx + bw - 30, 512);
  ctx.stroke();
  ctx.restore();
  return c;
}
