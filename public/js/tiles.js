// js/tiles.js — procedural domino art (canvas): pip faces for 3D textures + hand images

const PIP_POS = {
  0: [],
  1: [[.5, .5]],
  2: [[.28, .28], [.72, .72]],
  3: [[.28, .28], [.5, .5], [.72, .72]],
  4: [[.3, .3], [.7, .3], [.3, .7], [.7, .7]],
  5: [[.28, .28], [.72, .28], [.5, .5], [.28, .72], [.72, .72]],
  6: [[.3, .26], [.7, .26], [.3, .5], [.7, .5], [.3, .74], [.7, .74]],
};
const PIP_COLORS = { 1: '#c22f2f', 2: '#1d1d24', 3: '#1d1d24', 4: '#1d3fbf', 5: '#1d3fbf', 6: '#1d7a3a' };

function drawHalf(ctx, value, x, y, w, h) {
  const s = Math.min(w, h);
  const r = s * 0.085;
  for (const [px, py] of PIP_POS[value]) {
    ctx.beginPath();
    ctx.fillStyle = PIP_COLORS[value] || '#1d1d24';
    ctx.arc(x + px * w, y + py * h, r, 0, Math.PI * 2);
    ctx.fill();
    // subtle highlight
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.arc(x + px * w - r * .3, y + py * h - r * .3, r * .35, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ivoryGradient(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, w * .1, w / 2, h / 2, h * .75);
  g.addColorStop(0, '#fbf7ea');
  g.addColorStop(1, '#e6dfc9');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Face texture: value a on top half, b on bottom. Canvas 256×512. */
export function tileFaceCanvas(a, b) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  ivoryGradient(ctx, 256, 512);
  // inner border
  ctx.strokeStyle = 'rgba(60,50,30,.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, 228, 484);
  // divider
  ctx.beginPath();
  ctx.moveTo(20, 256); ctx.lineTo(236, 256);
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(60,50,30,.6)';
  ctx.stroke();
  drawHalf(ctx, a, 20, 20, 216, 216);
  drawHalf(ctx, b, 20, 276, 216, 216);
  return c;
}

/** Dark engraved back. */
export function tileBackCanvas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 512);
  g.addColorStop(0, '#2b3350');
  g.addColorStop(1, '#171d33');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 512);
  ctx.strokeStyle = 'rgba(140,170,255,.25)';
  ctx.lineWidth = 4;
  ctx.strokeRect(16, 16, 224, 480);
  ctx.beginPath();
  ctx.arc(128, 256, 62, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140,170,255,.35)';
  ctx.stroke();
  ctx.font = '90px serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(190,205,255,.5)';
  ctx.fillText('🁢', 128, 260);
  return c;
}

const dataUrlCache = new Map();
/** dataURL for hand tiles (vertical, a over b). */
export function tileImage(a, b) {
  const key = `${a}-${b}`;
  if (!dataUrlCache.has(key)) dataUrlCache.set(key, tileFaceCanvas(a, b).toDataURL());
  return dataUrlCache.get(key);
}

/** Felt texture for the table. */
export function feltCanvas() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(512, 512, 80, 512, 512, 720);
  g.addColorStop(0, '#1d6a4f');
  g.addColorStop(.7, '#155040');
  g.addColorStop(1, '#0e382e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
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
