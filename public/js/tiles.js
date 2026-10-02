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
      ctx.font = '90px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(190,205,255,.5)'; ctx.fillText('🁢', 128, 260);
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

/** Face texture: value a on top half, b on bottom. Canvas 256×512. */
export function tileFaceCanvas(a, b) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  const t = theme();
  t.faceFill(ctx, 256, 512, a, b);
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

/** Themed back face. */
export function tileBackCanvas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  theme().back(ctx, 256, 512);
  return c;
}

const dataUrlCache = new Map();
/** dataURL for hand tiles (vertical, a over b) — themed. */
export function tileImage(a, b) {
  const key = `${activeTheme}:${a}-${b}`;
  if (!dataUrlCache.has(key)) dataUrlCache.set(key, tileFaceCanvas(a, b).toDataURL());
  return dataUrlCache.get(key);
}

/** Felt texture for the table. B3: punchier contrast + a fine woven pattern. */
export function feltCanvas() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(512, 512, 80, 512, 512, 720);
  g.addColorStop(0, '#217a59');
  g.addColorStop(.7, '#124a3a');
  g.addColorStop(1, '#0a2f26');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  // fine felt nap — one subtle stitch direction only (a full grid moirés
  // into diagonal bands when the texture is minified on the table cap)
  ctx.globalAlpha = 0.028;
  for (let i = 0; i < 1024; i += 5) {
    ctx.fillStyle = i % 10 ? '#06231c' : '#2f8a66';
    ctx.fillRect(0, i, 1024, 2);
  }
  ctx.globalAlpha = 1;
  // felt noise
  const img = ctx.getImageData(0, 0, 1024, 1024);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - .5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // subtle center emblem
  ctx.globalAlpha = .06;
  ctx.font = '400px serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('🁢', 512, 540);
  ctx.globalAlpha = 1;
  return c;
}
