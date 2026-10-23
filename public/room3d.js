// public/room3d.js — full three-dimensional room for Domino Arena.
//
// Performance budget (kept by design, checked in the demo page):
//   < 60,000 triangles, < 25 materials, one 1K wall image per panel,
//   one 1024x1024 shadow map, no post-processing — 60 fps on a mid-range phone.
//
// Public API:
//   createRoom(scene, styleId, opts = { table: boolean }) -> THREE.Group
//   disposeRoom(group)
//
// Only `three` (through the page import map) and the optional data module
// ./room3d-styles.js are imported. All textures are painted on canvases in
// memory; the only image files touched are the existing vendor environment
// JPEGs referenced by the style data.
import * as THREE from 'three';

const ROOM = { width: 9, depth: 7, height: 3.2 };
const ART_LIMIT = 5;          // keeps the material budget under 25
const MAX_SHADOW = 1024;      // one shadow map only

// ── Optional style data ─────────────────────────────────────────────────────
// The styles module is written by a sibling task; if it is missing or broken
// the room still builds from the internal palettes below.
let FILE_STYLES = null;
try {
  const mod = await import('./room3d-styles.js');
  if (Array.isArray(mod.ROOM_STYLES) && mod.ROOM_STYLES.length > 0) {
    FILE_STYLES = mod.ROOM_STYLES;
  }
} catch {
  FILE_STYLES = null;
}

const FALLBACK_STYLES = [
  {
    id: 'modern',
    label: 'Modern',
    palette: {
      floor: '#c9c2b6', wall: '#e9e6e0', ceiling: '#f7f5f1', rug: '#7f8794',
      wood: '#8a6a4a', fabric: '#3e5a6e', metal: '#c3c7cc',
      light: '#fff3df', lightIntensity: 1.05, ambient: 0.85,
    },
    wallArt: [
      { wall: 'back', image: 'photo_studio_loft_hall', w: 3.6, h: 2.0, x: 0, y: 1.8, frame: '#2c3138' },
      { wall: 'left', image: 'blue_photo_studio', w: 1.9, h: 1.25, x: -0.6, y: 1.72, frame: '#9aa3ad' },
      { wall: 'right', image: 'brown_photostudio_02', w: 1.5, h: 1.9, x: 0.9, y: 1.78, frame: '#2c3138' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'plant', 'lamp'],
  },
  {
    id: 'cozy',
    label: 'Cozy',
    palette: {
      floor: '#6f4a2f', wall: '#bf9b74', ceiling: '#dcc9ad', rug: '#8c3b32',
      wood: '#5a3722', fabric: '#8a6a4f', metal: '#a67c3d',
      light: '#ffb46b', lightIntensity: 0.8, ambient: 0.72,
    },
    wallArt: [
      { wall: 'back', image: 'warm_restaurant_night', w: 3.2, h: 1.8, x: 0, y: 1.8, frame: '#4a2f1d' },
      { wall: 'left', image: 'wooden_lounge', w: 2.2, h: 1.35, x: 0.5, y: 1.75, frame: '#6b4626' },
      { wall: 'right', image: 'comfy_cafe', w: 1.7, h: 1.15, x: -0.7, y: 1.72, frame: '#3f2a1a' },
      { wall: 'right', image: 'fireplace', w: 1.2, h: 1.6, x: 1.9, y: 1.75, frame: '#3f2a1a' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'fireplace', 'plant', 'books', 'lamp'],
  },
  {
    id: 'billiard',
    label: 'Billiard hall',
    palette: {
      floor: '#2b3b36', wall: '#3a4a41', ceiling: '#1d2724', rug: '#7a1f24',
      wood: '#4a2d1a', fabric: '#125c3a', metal: '#b08d57',
      light: '#ffe3ae', lightIntensity: 0.92, ambient: 0.6,
    },
    wallArt: [
      { wall: 'back', image: 'billiard_hall', w: 3.4, h: 1.9, x: 0, y: 1.8, frame: '#b08d57' },
      { wall: 'left', image: 'warm_bar', w: 2.2, h: 1.3, x: 0, y: 1.72, frame: '#6b4a2a' },
      { wall: 'right', image: 'brown_photostudio_02', w: 1.3, h: 1.7, x: -1.2, y: 1.75, frame: '#b08d57' },
      { wall: 'right', image: 'wooden_lounge', w: 1.6, h: 1.0, x: 1.3, y: 1.7, frame: '#6b4a2a' },
    ],
    props: ['billiardTable', 'chairs', 'shelf', 'lamp', 'starLights'],
  },
  {
    id: 'playful',
    label: 'Playful',
    palette: {
      floor: '#5ec4c9', wall: '#ffe27a', ceiling: '#fff6c9', rug: '#ef476f',
      wood: '#e0a13a', fabric: '#118ab2', metal: '#845ec2',
      light: '#ffffff', lightIntensity: 1.15, ambient: 1.05,
    },
    wallArt: [
      { wall: 'back', image: 'cayley_interior', w: 3.3, h: 1.8, x: 0, y: 1.8, frame: '#ef476f' },
      { wall: 'back', image: 'blue_photo_studio', w: 1.1, h: 1.1, x: -3.4, y: 1.9, frame: '#118ab2' },
      { wall: 'left', image: 'brown_photostudio_02', w: 1.6, h: 2.0, x: -1.0, y: 1.75, frame: '#06d6a0' },
      { wall: 'left', image: 'comfy_cafe', w: 1.2, h: 0.9, x: 1.6, y: 1.7, frame: '#f7b32b' },
      { wall: 'right', image: 'photo_studio_loft_hall', w: 1.3, h: 1.6, x: 0.4, y: 1.75, frame: '#845ec2' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'plant', 'lamp'],
  },
];

const ROOMS = new WeakMap();      // scene -> room state
const GROUP_STATE = new WeakMap(); // group -> room state
const TEXTURE_LOADER = new THREE.TextureLoader();

// ── Small utilities ─────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toHex(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string' && value.trim()) {
    try {
      const c = new THREE.Color();
      c.setStyle(value.trim());
      return c.getHex();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function css(hex) {
  return '#' + new THREE.Color(hex).getHexString();
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function resolveStyle(styleId) {
  const list = Array.isArray(FILE_STYLES) ? FILE_STYLES : FALLBACK_STYLES;
  const wanted = typeof styleId === 'string' ? styleId : 'modern';
  const fallback = FALLBACK_STYLES.find((s) => s.id === wanted) || FALLBACK_STYLES[0];
  const raw = list.find((s) => s && s.id === wanted) || fallback;
  const base = FALLBACK_STYLES.find((s) => s.id === raw.id) || fallback;
  return {
    id: raw.id || base.id,
    label: raw.label || base.label || raw.id || base.id,
    palette: { ...base.palette, ...(raw.palette || {}) },
    wallArt: Array.isArray(raw.wallArt)
      ? raw.wallArt.filter((a) => a && typeof a.image === 'string' && a.image.trim())
      : base.wallArt,
    props: Array.isArray(raw.props) ? raw.props : base.props,
  };
}

// ── Canvas textures (no external files) ─────────────────────────────────────
const CAN_PAINT = (() => {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext && c.getContext('2d'));
  } catch {
    return false;
  }
})();

function canvasPair(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d') };
}

function makeTexture(canvas, repeatX, repeatY) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

// Planks with grain, joints and a few knots. `vertical` turns the grain 90°.
function paintWood(color, seed, vertical = false) {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(512);
  if (!ctx) return null;
  const rnd = makeRng(seed);
  const base = toHex(color, 0x8a5a3b);
  const rows = vertical ? 8 : 6;
  const step = 512 / rows;

  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < rows; i++) {
    const tone = new THREE.Color(base);
    tone.offsetHSL((rnd() - 0.5) * 0.015, 0, (rnd() - 0.5) * 0.085);
    ctx.fillStyle = css(tone.getHex());
    if (vertical) ctx.fillRect(i * step, 0, step, 512);
    else ctx.fillRect(0, i * step, 512, step);

    ctx.save();
    ctx.lineWidth = 1;
    for (let g = 0; g < 16; g++) {
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(32,16,6,0.10)' : 'rgba(255,240,215,0.08)';
      ctx.beginPath();
      if (vertical) {
        const x = i * step + rnd() * step;
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + (rnd() - 0.5) * 10, 170, x + (rnd() - 0.5) * 14, 340, x + (rnd() - 0.5) * 8, 512);
      } else {
        const y = i * step + rnd() * step;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(170, y + (rnd() - 0.5) * 10, 340, y + (rnd() - 0.5) * 14, 512, y + (rnd() - 0.5) * 8);
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(18,9,3,0.28)';
    if (vertical) ctx.fillRect(i * step, 0, 2, 512);
    else ctx.fillRect(0, i * step, 512, 2);
  }

  if (!vertical) {
    // Staggered end joints on every other plank.
    ctx.fillStyle = 'rgba(22,11,4,0.20)';
    for (let i = 0; i < rows; i++) {
      const off = (i % 2 ? 0.31 : 0.67) * 512;
      ctx.fillRect(off, i * step, 2, step);
    }
  }

  for (let k = 0; k < 4; k++) {
    const x = rnd() * 512;
    const y = rnd() * 512;
    ctx.strokeStyle = 'rgba(38,19,8,0.18)';
    for (let r = 4; r <= 12; r += 4) {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.7, r, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  return canvas;
}

function paintPlaster(color, seed) {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(512);
  if (!ctx) return null;
  const rnd = makeRng(seed);
  ctx.fillStyle = css(toHex(color, 0xe9e6e0));
  ctx.fillRect(0, 0, 512, 512);

  // Fine trowel noise, not a visible repeating pattern.
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.030)' : 'rgba(0,0,0,0.026)';
    const s = 1 + rnd() * 2;
    ctx.fillRect(rnd() * 512, rnd() * 512, s, s);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.022)';
  ctx.lineWidth = 10;
  for (let i = 0; i < 14; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * 512, rnd() * 512, 40 + rnd() * 120, rnd() * 6.28, rnd() * 6.28 + 0.6);
    ctx.stroke();
  }
  return canvas;
}

function paintRug(palette) {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(512);
  if (!ctx) return null;
  const base = toHex(palette.rug, 0x8c3b32);
  const accent = toHex(palette.fabric, 0x3e5a6e);
  const metal = toHex(palette.metal, 0xb08d57);
  const light = toHex(palette.light, 0xfff3df);

  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = css(accent);
  ctx.lineWidth = 26;
  ctx.strokeRect(24, 24, 464, 464);
  ctx.strokeStyle = css(metal);
  ctx.lineWidth = 5;
  ctx.strokeRect(52, 52, 408, 408);
  ctx.strokeStyle = css(light);
  ctx.lineWidth = 2;
  ctx.strokeRect(64, 64, 384, 384);

  // Border diamonds.
  ctx.fillStyle = css(light);
  for (let i = 0; i < 14; i++) {
    const t = 40 + i * 33;
    for (const [x, y] of [[t, 38], [t, 474], [38, t], [474, t]]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-4, -4, 8, 8);
      ctx.restore();
    }
  }

  // Inner lattice.
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = css(accent);
  ctx.lineWidth = 3;
  for (let x = 90; x <= 422; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, 90);
    ctx.lineTo(x, 422);
    ctx.stroke();
  }
  for (let y = 90; y <= 422; y += 42) {
    ctx.beginPath();
    ctx.moveTo(90, y);
    ctx.lineTo(422, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Centre medallion.
  const cx = 256;
  const cy = 256;
  for (const [size, color] of [[126, accent], [98, light], [70, metal], [38, light]]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = css(color);
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = css(base);
  ctx.fillRect(-18, -18, 36, 36);
  ctx.restore();
  return canvas;
}

function paintFabric(color, seed) {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(256);
  if (!ctx) return null;
  const rnd = makeRng(seed);
  ctx.fillStyle = css(toHex(color, 0x3e5a6e));
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 256; i += 4) {
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(i, 0, 1, 256);
    ctx.fillStyle = 'rgba(0,0,0,0.035)';
    ctx.fillRect(0, i, 256, 1);
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.03)';
    ctx.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  return canvas;
}

function paintMetal(color, seed) {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(256);
  if (!ctx) return null;
  const rnd = makeRng(seed);
  const base = toHex(color, 0xc3c7cc);
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  const c1 = new THREE.Color(base).offsetHSL(0, 0, 0.08);
  const c2 = new THREE.Color(base).offsetHSL(0, 0, -0.10);
  grad.addColorStop(0, css(c1.getHex()));
  grad.addColorStop(0.45, css(base));
  grad.addColorStop(0.7, css(c2.getHex()));
  grad.addColorStop(1, css(base));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(rnd() * 256, 0, 0.7, 256);
  }
  return canvas;
}

function paintBrick() {
  if (!CAN_PAINT) return null;
  const { canvas, ctx } = canvasPair(256);
  if (!ctx) return null;
  const rnd = makeRng(0xb21c4);
  ctx.fillStyle = '#4b382c';
  ctx.fillRect(0, 0, 256, 256);
  const bw = 64;
  const bh = 32;
  for (let row = 0; row < 8; row++) {
    const off = row % 2 ? -bw / 2 : 0;
    for (let col = -1; col < 5; col++) {
      const x = col * bw + off + 1.5;
      const y = row * bh + 1.5;
      const brick = new THREE.Color(0x9a5a44);
      brick.offsetHSL((rnd() - 0.5) * 0.02, 0, (rnd() - 0.5) * 0.10);
      ctx.fillStyle = css(brick.getHex());
      ctx.fillRect(x, y, bw - 3, bh - 3);
      ctx.fillStyle = 'rgba(255,230,205,0.045)';
      ctx.fillRect(x + 2, y + 2, bw - 7, 2);
    }
  }
  return canvas;
}

// ── Materials and shared geometry ───────────────────────────────────────────
function createMaterials(state, style) {
  const p = style.palette;
  const seed = hashString(style.id);
  const m = {};
  const add = (key, material) => {
    state.materials.add(material);
    m[key] = material;
    return material;
  };
  const texture = (canvas, rx, ry) => {
    if (!canvas) return null;
    const tex = makeTexture(canvas, rx, ry);
    state.textures.add(tex);
    return tex;
  };

  const floorTex = texture(paintWood(p.floor, seed + 1), 5, 4);
  const wallTex = texture(paintPlaster(p.wall, seed + 2), 3, 2);
  const rugTex = texture(paintRug(p), 1, 1);
  const fabricTex = texture(paintFabric(p.fabric, seed + 3), 2, 2);
  const woodTex = texture(paintWood(p.wood, seed + 4, true), 1, 1);
  const metalTex = texture(paintMetal(p.metal, seed + 5), 1, 1);

  add('floor', new THREE.MeshStandardMaterial({
    map: floorTex, color: floorTex ? 0xffffff : toHex(p.floor, 0xc9c2b6),
    roughness: 0.64, metalness: 0.02,
  }));
  add('wall', new THREE.MeshStandardMaterial({
    map: wallTex, color: wallTex ? 0xffffff : toHex(p.wall, 0xe9e6e0),
    roughness: 0.96, metalness: 0,
  }));
  add('ceiling', new THREE.MeshStandardMaterial({
    color: toHex(p.ceiling, 0xf7f5f1), roughness: 0.98, metalness: 0,
  }));
  add('wood', new THREE.MeshStandardMaterial({
    map: woodTex, color: woodTex ? 0xffffff : toHex(p.wood, 0x8a6a4a),
    roughness: 0.56, metalness: 0.04,
  }));
  add('rug', new THREE.MeshStandardMaterial({
    map: rugTex, color: rugTex ? 0xffffff : toHex(p.rug, 0x8c3b32),
    roughness: 1, metalness: 0,
  }));
  add('fabric', new THREE.MeshStandardMaterial({
    map: fabricTex, color: fabricTex ? 0xffffff : toHex(p.fabric, 0x3e5a6e),
    roughness: 0.92, metalness: 0,
  }));
  add('metal', new THREE.MeshStandardMaterial({
    map: metalTex, color: metalTex ? 0xffffff : toHex(p.metal, 0xc3c7cc),
    roughness: 0.34, metalness: 0.78,
  }));
  add('leaf', new THREE.MeshStandardMaterial({
    color: style.id === 'playful' ? 0x3fbf6a : style.id === 'cozy' ? 0x4f6f2e : 0x4d7a46,
    roughness: 0.85, metalness: 0,
  }));
  add('pot', new THREE.MeshStandardMaterial({
    color: style.id === 'playful' ? 0xf25c54 : style.id === 'modern' ? 0x6b6f72 : 0x9a5b3f,
    roughness: 0.9, metalness: 0,
  }));
  add('glass', new THREE.MeshStandardMaterial({
    color: 0xcfe8ff, transparent: true, opacity: 0.16, roughness: 0.06,
    metalness: 0.2, side: THREE.DoubleSide, depthWrite: false,
  }));
  add('frame', new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.45, metalness: 0.3,
  }));
  add('shade', new THREE.MeshStandardMaterial({
    color: toHex(p.light, 0xfff3df),
    emissive: toHex(p.light, 0xfff3df),
    emissiveIntensity: 0.7,
    roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
  }));
  add('books', new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.78, metalness: 0,
  }));
  // Game table materials are copied verbatim from demo-environment.html.
  add('gameWood', new THREE.MeshStandardMaterial({ color: 0x6b3f22, roughness: 0.55, metalness: 0.05 }));
  add('gameFelt', new THREE.MeshStandardMaterial({ color: 0x146b3a, roughness: 0.92, metalness: 0 }));
  add('tileWhite', new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.5 }));
  add('tileBlack', new THREE.MeshStandardMaterial({ color: 0x1b1c22, roughness: 0.35, metalness: 0.1 }));

  return m;
}

function createGeometry(state) {
  const g = {
    box: new THREE.BoxGeometry(1, 1, 1),
    plane: new THREE.PlaneGeometry(1, 1),
    cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
    cyl12: new THREE.CylinderGeometry(1, 1, 1, 12),
    cyl16: new THREE.CylinderGeometry(1, 1, 1, 16),
    pot: new THREE.CylinderGeometry(1, 0.72, 1, 12),
    shade: new THREE.CylinderGeometry(0.62, 1, 1, 16, 1, true),
    cone16: new THREE.ConeGeometry(1, 1, 16, 1, true),
    cone8: new THREE.ConeGeometry(1, 1, 8, 1, true),
    sphereLo: new THREE.SphereGeometry(1, 6, 4),
  };
  for (const key of Object.keys(g)) state.geometries.add(g[key]);
  return g;
}

function addMesh(parent, geometry, material, opts = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  const s = opts.scale;
  if (s) mesh.scale.set(s[0], s[1], s[2]);
  const p = opts.pos;
  if (p) mesh.position.set(p[0], p[1], p[2]);
  const r = opts.rot;
  if (r) mesh.rotation.set(r[0], r[1], r[2]);
  mesh.castShadow = opts.cast !== false;
  mesh.receiveShadow = opts.receive !== false;
  parent.add(mesh);
  return mesh;
}

// ── Room shell ──────────────────────────────────────────────────────────────
function buildShell(room, geo, mats) {
  const W = ROOM.width;
  const D = ROOM.depth;
  const H = ROOM.height;
  const t = 0.12;

  addMesh(room, geo.plane, mats.floor, {
    scale: [W, D, 1], pos: [0, 0, 0], rot: [-Math.PI / 2, 0, 0], cast: false,
  });
  addMesh(room, geo.plane, mats.ceiling, {
    scale: [W, D, 1], pos: [0, H, 0], rot: [Math.PI / 2, 0, 0], cast: false, receive: false,
  });

  addMesh(room, geo.box, mats.wall, {
    scale: [W + t * 2, H, t], pos: [0, H / 2, -D / 2 - t / 2], cast: false,
  });
  addMesh(room, geo.box, mats.wall, {
    scale: [t, H, D + t * 2], pos: [-W / 2 - t / 2, H / 2, 0], cast: false,
  });
  addMesh(room, geo.box, mats.wall, {
    scale: [t, H, D + t * 2], pos: [W / 2 + t / 2, H / 2, 0], cast: false,
  });

  // Front wall: only two narrow returns. The full-height opening lets the game
  // camera sit outside the room without a lintel crossing the view.
  const opening = 5.5;
  const side = (W - opening) / 2;
  const frontZ = D / 2 + t / 2;
  addMesh(room, geo.box, mats.wall, {
    scale: [side, H, t], pos: [-(opening / 2 + side / 2), H / 2, frontZ], cast: false,
  });
  addMesh(room, geo.box, mats.wall, {
    scale: [side, H, t], pos: [opening / 2 + side / 2, H / 2, frontZ], cast: false,
  });

  // Baseboards.
  addMesh(room, geo.box, mats.wood, { scale: [W - 0.1, 0.12, 0.05], pos: [0, 0.06, -D / 2 + 0.025], cast: false });
  addMesh(room, geo.box, mats.wood, { scale: [0.05, 0.12, D], pos: [-W / 2 + 0.025, 0.06, 0], cast: false });
  addMesh(room, geo.box, mats.wood, { scale: [0.05, 0.12, D], pos: [W / 2 - 0.025, 0.06, 0], cast: false });
  addMesh(room, geo.box, mats.wood, {
    scale: [side, 0.12, 0.05], pos: [-(opening / 2 + side / 2), 0.06, D / 2 - 0.025], cast: false,
  });
  addMesh(room, geo.box, mats.wood, {
    scale: [side, 0.12, 0.05], pos: [opening / 2 + side / 2, 0.06, D / 2 - 0.025], cast: false,
  });

  // Crown moulding.
  addMesh(room, geo.box, mats.wood, { scale: [W, 0.08, 0.05], pos: [0, H - 0.04, -D / 2 + 0.025], cast: false });
  addMesh(room, geo.box, mats.wood, { scale: [0.05, 0.08, D], pos: [-W / 2 + 0.025, H - 0.04, 0], cast: false });
  addMesh(room, geo.box, mats.wood, { scale: [0.05, 0.08, D], pos: [W / 2 - 0.025, H - 0.04, 0], cast: false });

  // Rug — sits a couple of centimetres above the floor.
  addMesh(room, geo.box, mats.rug, {
    scale: [5.8, 0.025, 4.4], pos: [0, 0.0125, -0.1], cast: false,
  });
}

// ── Wall art (large framed panels) ──────────────────────────────────────────
function artPlacements(style) {
  const out = [];
  for (const art of style.wallArt.slice(0, ART_LIMIT)) {
    const wall = art.wall === 'left' || art.wall === 'right' ? art.wall : 'back';
    const half = wall === 'back' ? ROOM.width / 2 : ROOM.depth / 2;
    const w = clamp(num(art.w) || 2, 0.6, half * 2 - 0.4);
    const h = clamp(num(art.h) || 1.5, 0.5, ROOM.height - 0.35);
    const maxX = half - w / 2 - 0.12;
    const x = clamp(num(art.x) || 0, -maxX, maxX);
    const y = clamp(num(art.y) || 1.8, h / 2 + 0.2, ROOM.height - h / 2 - 0.12);
    out.push({ ...art, wall, w, h, x, y, framed: art.frame !== false && art.frame != null });
  }
  return out;
}

function artUrl(image) {
  const s = typeof image === 'string' ? image.trim() : '';
  if (!s) return null;
  if (s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || /^https?:/i.test(s)) return s;
  return `./vendor/environments/${s}/${s}_1k.jpg`;
}

function wallPoint(wall, x, y) {
  if (wall === 'left') return { x: -ROOM.width / 2 + 0.012, y, z: x, rot: Math.PI / 2 };
  if (wall === 'right') return { x: ROOM.width / 2 - 0.012, y, z: x, rot: -Math.PI / 2 };
  return { x, y, z: -ROOM.depth / 2 + 0.012, rot: 0 };
}

function loadPanelTexture(state, image, material) {
  if (!CAN_PAINT) return;
  const url = artUrl(image);
  if (!url) return;
  try {
    TEXTURE_LOADER.load(
      url,
      (tex) => {
        if (state.disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        state.textures.add(tex);
        material.map = tex;
        material.emissiveMap = tex;
        material.emissive.set(0xffffff);
        material.emissiveIntensity = 0.16;
        material.color.set(0xffffff);
        material.needsUpdate = true;
        if (state.group.userData.stats) {
          state.group.userData.stats.textures = state.textures.size;
        }
      },
      undefined,
      () => {
        // Missing image: keep the muted panel and the room keeps working.
      },
    );
  } catch {
    // TextureLoader is unavailable in a non-browser host — ignore the art.
  }
}

function buildWallArt(room, state, style, geo, mats) {
  const panels = artPlacements(style);
  const frames = [];

  for (const panel of panels) {
    const at = wallPoint(panel.wall, panel.x, panel.y);
    const normalX = Math.sin(at.rot);
    const normalZ = Math.cos(at.rot);

    const material = new THREE.MeshStandardMaterial({
      color: 0x242a31, roughness: 0.9, metalness: 0,
    });
    state.materials.add(material);

    // PlaneGeometry faces +Z locally; the wall rotation turns it into the room.
    const offset = panel.framed ? 0.045 : 0.022;
    addMesh(room, geo.plane, material, {
      scale: [panel.w, panel.h, 1],
      pos: [at.x + normalX * offset, at.y, at.z + normalZ * offset],
      rot: [0, at.rot, 0],
      cast: false,
    });
    loadPanelTexture(state, panel.image, material);

    if (panel.framed) {
      const dummy = new THREE.Object3D();
      dummy.position.set(at.x, at.y, at.z);
      dummy.rotation.y = at.rot;
      dummy.scale.set(panel.w + 0.14, panel.h + 0.14, 0.06);
      dummy.updateMatrix();
      frames.push({
        matrix: dummy.matrix.clone(),
        color: toHex(panel.frame, 0x2a211a),
      });
    }
  }

  if (frames.length > 0) {
    const inst = new THREE.InstancedMesh(geo.box, mats.frame, frames.length);
    for (let i = 0; i < frames.length; i++) {
      inst.setMatrixAt(i, frames[i].matrix);
      inst.setColorAt(i, new THREE.Color(frames[i].color));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    room.add(inst);
  }
}

// ── Window ──────────────────────────────────────────────────────────────────
function findFreeSlot(occupied, min, max, needed) {
  const list = occupied
    .map(([a, b]) => [Math.max(min, a), Math.min(max, b)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let cursor = min;
  let best = null;
  const consider = (a, b) => {
    if (b - a < needed) return;
    if (!best || b - a > best.width) best = { center: (a + b) / 2, width: b - a };
  };
  for (const [a, b] of list) {
    consider(cursor, a);
    cursor = Math.max(cursor, b);
  }
  consider(cursor, max);
  return best;
}

function chooseWindow(style, placements, shelf, bar) {
  const wallMin = -ROOM.depth / 2 + 0.12;
  const wallMax = ROOM.depth / 2 - 0.12;
  const needed = 2.2;
  const occupied = { left: [], right: [] };

  for (const p of placements) {
    if (p.wall === 'left' || p.wall === 'right') {
      occupied[p.wall].push([p.x - p.w / 2 - 0.08, p.x + p.w / 2 + 0.08]);
    }
  }
  if (shelf && shelf.wall === 'right') {
    occupied.right.push([shelf.z - 0.85, shelf.z + 0.85]);
  }
  if (bar) {
    occupied.right.push([bar.z - 1.5, bar.z + 1.5]);
  }

  for (const wall of ['left', 'right']) {
    const slot = findFreeSlot(occupied[wall], wallMin, wallMax, needed);
    if (slot) {
      const w = Math.min(2.25, slot.width - 0.2);
      if (w >= 1.6) {
        return { wall, z: slot.center, w, h: 1.55 };
      }
    }
  }
  return null;
}

function buildWindow(room, geo, mats, style, spec) {
  const group = new THREE.Group();
  const isLeft = spec.wall === 'left';
  group.position.set(isLeft ? -ROOM.width / 2 + 0.01 : ROOM.width / 2 - 0.01, 0, spec.z);
  group.rotation.y = isLeft ? Math.PI / 2 : -Math.PI / 2;

  const y = 1.86;
  const w = spec.w;
  const h = spec.h;
  const roomSide = 0.03;

  // Warm light behind the glass makes the window read as a real light source.
  addMesh(group, geo.plane, mats.shade, {
    scale: [w, h, 1], pos: [0, y, roomSide], cast: false, receive: false,
  });
  addMesh(group, geo.plane, mats.glass, {
    scale: [w, h, 1], pos: [0, y, roomSide + 0.03], cast: false, receive: false,
  });

  // Outer frame.
  addMesh(group, geo.box, mats.wood, { scale: [w + 0.16, 0.1, 0.12], pos: [0, y + h / 2 + 0.05, 0.08] });
  addMesh(group, geo.box, mats.wood, { scale: [w + 0.16, 0.1, 0.12], pos: [0, y - h / 2 - 0.05, 0.08] });
  addMesh(group, geo.box, mats.wood, { scale: [0.1, h + 0.2, 0.12], pos: [-w / 2 - 0.05, y, 0.08] });
  addMesh(group, geo.box, mats.wood, { scale: [0.1, h + 0.2, 0.12], pos: [w / 2 + 0.05, y, 0.08] });

  // Mullions and sill.
  addMesh(group, geo.box, mats.wood, { scale: [0.05, h, 0.06], pos: [0, y, 0.1] });
  addMesh(group, geo.box, mats.wood, { scale: [w, 0.05, 0.06], pos: [0, y, 0.1] });
  addMesh(group, geo.box, mats.wood, { scale: [w + 0.3, 0.08, 0.22], pos: [0, y - h / 2 - 0.12, 0.14] });

  if (style.id === 'cozy') {
    // Soft curtains either side.
    const sideX = w / 2 + 0.2;
    addMesh(group, geo.box, mats.fabric, { scale: [0.32, h + 0.25, 0.07], pos: [-sideX, y - 0.05, 0.15] });
    addMesh(group, geo.box, mats.fabric, { scale: [0.32, h + 0.25, 0.07], pos: [sideX, y - 0.05, 0.15] });
    addMesh(group, geo.cyl8, mats.metal, {
      scale: [0.02, w + 0.9, 0.02], pos: [0, y + h / 2 + 0.22, 0.14], rot: [0, 0, Math.PI / 2],
    });
  }

  room.add(group);
}

// ── Furniture ───────────────────────────────────────────────────────────────
function buildSofa(room, geo, mats, place) {
  const g = new THREE.Group();
  g.position.set(place.x, 0, place.z);
  g.rotation.y = place.rot;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addMesh(g, geo.cyl8, mats.tileBlack, { scale: [0.045, 0.08, 0.045], pos: [sx * 0.95, 0.04, sz * 0.34] });
    }
  }
  addMesh(g, geo.box, mats.fabric, { scale: [2.3, 0.34, 0.95], pos: [0, 0.25, 0] });
  addMesh(g, geo.box, mats.fabric, { scale: [2.3, 0.72, 0.22], pos: [0, 0.6, -0.37] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.24, 0.55, 0.95], pos: [-1.03, 0.45, 0] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.24, 0.55, 0.95], pos: [1.03, 0.45, 0] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.98, 0.16, 0.62], pos: [-0.51, 0.48, 0.05] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.98, 0.16, 0.62], pos: [0.51, 0.48, 0.05] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.95, 0.44, 0.16], pos: [-0.51, 0.68, -0.24] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.95, 0.44, 0.16], pos: [0.51, 0.68, -0.24] });
  room.add(g);
}

function buildChair(room, geo, mats, x, z, rot) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addMesh(g, geo.box, mats.wood, { scale: [0.05, 0.45, 0.05], pos: [sx * 0.21, 0.225, sz * 0.21] });
    }
  }
  addMesh(g, geo.box, mats.wood, { scale: [0.52, 0.08, 0.52], pos: [0, 0.45, 0] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.48, 0.07, 0.48], pos: [0, 0.51, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [0.52, 0.55, 0.07], pos: [0, 0.75, -0.225] });
  addMesh(g, geo.box, mats.fabric, { scale: [0.44, 0.4, 0.05], pos: [0, 0.72, -0.18] });
  room.add(g);
}

function buildBookStack(parent, geo, mats, x, y, z) {
  const height = [0.035, 0.04, 0.03];
  const colors = [0xb23a48, 0x2f6f8f, 0xd9a441];
  const inst = new THREE.InstancedMesh(geo.box, mats.books, height.length);
  const dummy = new THREE.Object3D();
  let top = y;
  for (let i = 0; i < height.length; i++) {
    const h = height[i];
    dummy.position.set(x + (i % 2 ? 0.012 : -0.006), top + h / 2, z + (i % 2 ? 0.008 : -0.01));
    dummy.rotation.set(0, (i % 2 ? 0.18 : -0.12), 0);
    dummy.scale.set(0.27 - i * 0.018, h, 0.19 - i * 0.012);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, new THREE.Color(colors[i]));
    top += h;
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  parent.add(inst);
}

function buildSideTable(room, geo, mats, place, withBooks) {
  const g = new THREE.Group();
  g.position.set(place.x, 0, place.z);
  g.rotation.y = place.rot || 0;
  addMesh(g, geo.cyl16, mats.wood, { scale: [0.3, 0.04, 0.3], pos: [0, 0.55, 0] });
  addMesh(g, geo.cyl8, mats.metal, { scale: [0.025, 0.53, 0.025], pos: [0, 0.27, 0] });
  addMesh(g, geo.cyl16, mats.metal, { scale: [0.2, 0.03, 0.2], pos: [0, 0.015, 0] });
  if (withBooks) buildBookStack(g, geo, mats, 0, 0.57, 0);
  room.add(g);
}

function buildShelf(room, geo, mats, place) {
  const g = new THREE.Group();
  g.position.set(place.x, 0, place.z);
  g.rotation.y = place.rot;
  const W = 1.5;
  const H = 1.9;
  const D = 0.34;

  addMesh(g, geo.box, mats.wood, { scale: [W, H, 0.03], pos: [0, H / 2, -D / 2 + 0.015] });
  addMesh(g, geo.box, mats.wood, { scale: [0.04, H, D], pos: [-W / 2 + 0.02, H / 2, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [0.04, H, D], pos: [W / 2 - 0.02, H / 2, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [W, 0.05, D], pos: [0, H - 0.025, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [W, 0.05, D], pos: [0, 0.025, 0] });

  const shelfY = [0.38, 0.74, 1.10, 1.46];
  for (const y of shelfY) {
    addMesh(g, geo.box, mats.wood, { scale: [W - 0.06, 0.035, D - 0.04], pos: [0, y, 0] });
  }

  const rnd = makeRng(0xb0015);
  const colors = [0xb23a48, 0x2f6f8f, 0xd9a441, 0x4f7a4a, 0x845ec2, 0xe07a2f, 0xf4f1e8];
  const slots = [];
  for (const y of shelfY) {
    for (let i = 0; i < 7; i++) {
      if (rnd() < 0.12) continue; // a gap here and there looks lived in
      slots.push({ x: -0.54 + i * 0.18, y, h: 0.17 + rnd() * 0.08, w: 0.085 + rnd() * 0.04 });
    }
  }

  const inst = new THREE.InstancedMesh(geo.box, mats.books, slots.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    dummy.position.set(s.x, s.y + 0.0175 + s.h / 2, 0.03);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(s.w, s.h, 0.17);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, new THREE.Color(colors[i % colors.length]));
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  g.add(inst);
  room.add(g);
}

function buildPlant(room, geo, mats, x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  addMesh(g, geo.pot, mats.pot, { scale: [0.26, 0.36, 0.26], pos: [0, 0.18, 0] });
  addMesh(g, geo.cyl12, mats.pot, { scale: [0.27, 0.04, 0.27], pos: [0, 0.36, 0] });
  addMesh(g, geo.cyl12, mats.tileBlack, { scale: [0.22, 0.02, 0.22], pos: [0, 0.37, 0], cast: false });
  addMesh(g, geo.cyl8, mats.wood, { scale: [0.03, 0.5, 0.03], pos: [0, 0.62, 0] });

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const leaf = addMesh(g, geo.sphereLo, mats.leaf, {
      scale: [0.15, 0.3, 0.055],
      pos: [Math.cos(a) * 0.2, 0.76 + (i % 3) * 0.14, Math.sin(a) * 0.2],
      rot: [0.55 * Math.sin(a), a, 0.45 * Math.cos(a)],
    });
    leaf.castShadow = true;
  }
  room.add(g);
}

function buildFloorLamp(room, geo, mats, x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addMesh(g, geo.cyl16, mats.metal, { scale: [0.22, 0.04, 0.22], pos: [0, 0.02, 0] });
  addMesh(g, geo.cyl8, mats.metal, { scale: [0.018, 1.5, 0.018], pos: [0, 0.78, 0] });
  addMesh(g, geo.shade, mats.shade, {
    scale: [0.32, 0.38, 0.32], pos: [0, 1.63, 0], cast: false, receive: false,
  });
  addMesh(g, geo.sphereLo, mats.shade, {
    scale: [0.07, 0.07, 0.07], pos: [0, 1.5, 0], cast: false, receive: false,
  });
  room.add(g);
}

function buildChandelier(room, geo, mats, lightColor, pointIntensity, place) {
  const g = new THREE.Group();
  const H = ROOM.height;
  const x = num(place && place.x) ?? 0;
  const z = num(place && place.z) ?? -2.45;
  g.position.set(x, 0, z);

  addMesh(g, geo.cyl12, mats.metal, { scale: [0.12, 0.035, 0.12], pos: [0, H - 0.02, 0] });
  // Cord runs from the ceiling rose down to the small shade (2.77 -> 3.18 m).
  addMesh(g, geo.cyl8, mats.tileBlack, { scale: [0.01, 0.41, 0.01], pos: [0, 2.975, 0], cast: false });
  addMesh(g, geo.cone16, mats.shade, {
    scale: [0.34, 0.22, 0.34], pos: [0, 2.65, 0], cast: false, receive: false,
  });
  addMesh(g, geo.sphereLo, mats.shade, {
    scale: [0.065, 0.065, 0.065], pos: [0, 2.56, 0], cast: false, receive: false,
  });
  addMesh(g, geo.cyl12, mats.metal, { scale: [0.05, 0.035, 0.05], pos: [0, 2.77, 0] });

  const point = new THREE.PointLight(new THREE.Color(lightColor), pointIntensity, 7.5, 2);
  point.position.set(0, 2.5, 0);
  g.add(point);
  room.add(g);
}

// ── Cozy fireplace ──────────────────────────────────────────────────────────
function getBrickMaterial(state) {
  if (state.brick) return state.brick;
  const canvas = paintBrick();
  let tex = null;
  if (canvas) {
    tex = makeTexture(canvas, 1, 1);
    state.textures.add(tex);
  }
  state.brick = new THREE.MeshStandardMaterial({
    map: tex, color: tex ? 0xffffff : 0x8a5a44, roughness: 0.95, metalness: 0,
  });
  state.materials.add(state.brick);
  return state.brick;
}

function getEmberMaterial(state) {
  if (state.ember) return state.ember;
  state.ember = new THREE.MeshStandardMaterial({
    color: 0x2a0d00, emissive: 0xff6a1a, emissiveIntensity: 1.6, roughness: 0.9,
  });
  state.materials.add(state.ember);
  return state.ember;
}

function buildFireplace(room, geo, mats, state, style, x) {
  const g = new THREE.Group();
  g.position.set(x, 0, -ROOM.depth / 2 + 0.01);
  const brick = getBrickMaterial(state);
  const ember = getEmberMaterial(state);

  // Hearth, body and chimney breast.
  addMesh(g, geo.box, brick, { scale: [2.1, 0.12, 0.55], pos: [0, 0.06, 0.25] });
  addMesh(g, geo.box, brick, { scale: [1.9, 1.35, 0.32], pos: [0, 0.735, 0.16] });
  addMesh(g, geo.box, brick, { scale: [1.9, 0.95, 0.2], pos: [0, 2.02, 0.1] });
  addMesh(g, geo.box, mats.wood, { scale: [2.1, 0.12, 0.44], pos: [0, 1.45, 0.22] });

  // Dark firebox with embers, logs and three low-poly flames.
  addMesh(g, geo.plane, mats.tileBlack, { scale: [1.15, 0.8, 1], pos: [0, 0.62, 0.325], cast: false });
  addMesh(g, geo.plane, ember, { scale: [0.95, 0.36, 1], pos: [0, 0.45, 0.335], cast: false, receive: false });
  addMesh(g, geo.cyl8, mats.tileBlack, {
    scale: [0.055, 0.65, 0.055], pos: [-0.12, 0.32, 0.43], rot: [0, 0, Math.PI / 2],
  });
  addMesh(g, geo.cyl8, mats.tileBlack, {
    scale: [0.05, 0.6, 0.05], pos: [0.12, 0.3, 0.41], rot: [0.1, 0, Math.PI / 2],
  });
  for (let i = 0; i < 3; i++) {
    addMesh(g, geo.cone8, ember, {
      scale: [0.09, 0.3 + (i % 2) * 0.1, 0.09], pos: [-0.16 + i * 0.16, 0.55, 0.42],
      cast: false, receive: false,
    });
  }

  const fire = new THREE.PointLight(new THREE.Color(toHex(style.palette.light, 0xffb46b)), 7, 4.5, 2);
  fire.position.set(0, 0.85, 0.75);
  g.add(fire);
  room.add(g);
}

// ── Billiard hall ───────────────────────────────────────────────────────────
function buildBilliardTable(room, geo, mats) {
  const g = new THREE.Group();
  g.name = 'billiard-table';
  g.position.set(0, 0, -2.55);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addMesh(g, geo.box, mats.wood, { scale: [0.16, 0.64, 0.16], pos: [sx * 1.05, 0.32, sz * 0.5] });
    }
  }
  addMesh(g, geo.box, mats.wood, { scale: [2.5, 0.16, 1.4], pos: [0, 0.72, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [2.34, 0.05, 1.2], pos: [0, 0.815, 0] });
  addMesh(g, geo.box, mats.gameFelt, { scale: [2.26, 0.02, 1.12], pos: [0, 0.85, 0], cast: false });

  // Rails and pockets.
  addMesh(g, geo.box, mats.wood, { scale: [2.5, 0.1, 0.16], pos: [0, 0.885, -0.66] });
  addMesh(g, geo.box, mats.wood, { scale: [2.5, 0.1, 0.16], pos: [0, 0.885, 0.66] });
  addMesh(g, geo.box, mats.wood, { scale: [0.16, 0.1, 1.16], pos: [-1.17, 0.885, 0] });
  addMesh(g, geo.box, mats.wood, { scale: [0.16, 0.1, 1.16], pos: [1.17, 0.885, 0] });
  for (const [px, pz] of [[-1.17, -0.66], [1.17, -0.66], [-1.17, 0.66], [1.17, 0.66], [0, -0.66], [0, 0.66]]) {
    addMesh(g, geo.cyl12, mats.tileBlack, { scale: [0.09, 0.02, 0.09], pos: [px, 0.94, pz], cast: false });
  }

  // Racked balls, one instanced draw.
  const rack = [
    [0, 0], [-0.09, -0.045], [-0.09, 0.045], [-0.18, -0.09], [-0.18, 0], [-0.18, 0.09],
    [-0.27, -0.135], [-0.27, -0.045], [-0.27, 0.045], [-0.27, 0.135],
  ];
  const colors = [0xf2c230, 0x2f6f8f, 0xb23a48, 0x4f7a4a, 0x845ec2, 0xe07a2f, 0x1b1c22, 0xf4f1e8, 0x8a3b3b, 0x3a6ea5];
  const ballCount = rack.length + 1;
  const balls = new THREE.InstancedMesh(geo.sphereLo, mats.books, ballCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < rack.length; i++) {
    dummy.position.set(-0.55 + rack[i][0], 0.905, rack[i][1]);
    dummy.scale.set(0.045, 0.045, 0.045);
    dummy.updateMatrix();
    balls.setMatrixAt(i, dummy.matrix);
    balls.setColorAt(i, new THREE.Color(colors[i]));
  }
  dummy.position.set(0.45, 0.905, 0.08);
  dummy.scale.set(0.045, 0.045, 0.045);
  dummy.updateMatrix();
  balls.setMatrixAt(rack.length, dummy.matrix);
  balls.setColorAt(rack.length, new THREE.Color(0xf4f1e8));
  balls.instanceMatrix.needsUpdate = true;
  if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
  balls.castShadow = true;
  balls.receiveShadow = true;
  g.add(balls);

  room.add(g);
}

function buildPendants(room, geo, mats, lightColor, intensity) {
  for (const x of [-0.85, 0, 0.85]) {
    const g = new THREE.Group();
    g.position.set(x, 0, -2.55);
    addMesh(g, geo.cyl12, mats.metal, { scale: [0.055, 0.04, 0.055], pos: [0, ROOM.height - 0.02, 0] });
    addMesh(g, geo.cyl8, mats.tileBlack, { scale: [0.01, 0.56, 0.01], pos: [0, 2.9, 0], cast: false });
    addMesh(g, geo.cone16, mats.shade, {
      scale: [0.2, 0.24, 0.2], pos: [0, 2.5, 0], cast: false, receive: false,
    });
    addMesh(g, geo.sphereLo, mats.shade, {
      scale: [0.05, 0.05, 0.05], pos: [0, 2.38, 0], cast: false, receive: false,
    });
    room.add(g);
  }
  const light = new THREE.PointLight(new THREE.Color(lightColor), intensity, 5, 2);
  light.position.set(0, 2.28, -2.55);
  room.add(light);
}

function buildStarLights(room, geo, mats) {
  const y = 2.95;
  const z = -ROOM.depth / 2 + 0.16;
  const from = -4.1;
  const to = 4.1;
  const count = 10;
  const step = (to - from) / (count - 1);
  for (let i = 0; i < count; i++) {
    addMesh(room, geo.sphereLo, mats.shade, {
      scale: [0.035, 0.035, 0.035], pos: [from + i * step, y, z], cast: false, receive: false,
    });
    if (i < count - 1) {
      addMesh(room, geo.cyl8, mats.tileBlack, {
        scale: [0.006, step, 0.006], pos: [from + (i + 0.5) * step, y, z],
        rot: [0, 0, Math.PI / 2], cast: false,
      });
    }
  }
}

function buildBar(room, geo, mats) {
  const g = new THREE.Group();
  g.position.set(ROOM.width / 2 - 0.25, 0, 0.85);
  g.rotation.y = -Math.PI / 2;

  addMesh(g, geo.box, mats.wood, { scale: [2.8, 0.1, 0.6], pos: [0, 1.0, 0.3] });
  addMesh(g, geo.box, mats.wood, { scale: [2.8, 1.0, 0.1], pos: [0, 0.5, 0.55] });
  addMesh(g, geo.box, mats.wood, { scale: [0.1, 1.0, 0.6], pos: [-1.35, 0.5, 0.3] });
  addMesh(g, geo.box, mats.wood, { scale: [0.1, 1.0, 0.6], pos: [1.35, 0.5, 0.3] });
  addMesh(g, geo.cyl8, mats.metal, {
    scale: [0.02, 2.6, 0.02], pos: [0, 0.22, 0.6], rot: [0, 0, Math.PI / 2],
  });

  // Bottles on the counter and a small back shelf.
  for (let i = 0; i < 6; i++) {
    const x = -1.05 + i * 0.42;
    addMesh(g, geo.cyl8, mats.glass, { scale: [0.05, 0.28, 0.05], pos: [x, 1.19, 0.28], cast: false });
    addMesh(g, geo.cyl8, mats.glass, { scale: [0.022, 0.12, 0.022], pos: [x, 1.39, 0.28], cast: false });
  }
  addMesh(g, geo.box, mats.wood, { scale: [2.6, 0.06, 0.28], pos: [0, 1.78, 0.14] });
  for (let i = 0; i < 5; i++) {
    addMesh(g, geo.cyl8, mats.glass, { scale: [0.045, 0.24, 0.045], pos: [-0.9 + i * 0.45, 1.93, 0.14], cast: false });
  }

  // Two stools.
  for (const x of [-0.75, 0.75]) {
    addMesh(g, geo.cyl12, mats.wood, { scale: [0.19, 0.05, 0.19], pos: [x, 0.72, 0.95] });
    addMesh(g, geo.cyl8, mats.metal, { scale: [0.025, 0.68, 0.025], pos: [x, 0.36, 0.95] });
    addMesh(g, geo.cyl12, mats.metal, { scale: [0.18, 0.03, 0.18], pos: [x, 0.015, 0.95] });
  }
  room.add(g);
}

// ── Game table (copied from demo-environment.html) ──────────────────────────
function buildGameTable(room, geo, mats) {
  const table = new THREE.Group();
  table.name = 'game-table';

  addMesh(table, geo.box, mats.gameWood, { scale: [2.6, 0.12, 2.6], pos: [0, 0.72, 0] });
  addMesh(table, geo.box, mats.gameFelt, { scale: [2.36, 0.03, 2.36], pos: [0, 0.795, 0], cast: false });

  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    addMesh(table, geo.box, mats.gameWood, { scale: [0.16, 0.66, 0.16], pos: [sx * 1.1, 0.33, sz * 1.1] });
  }

  for (let i = 0; i < 6; i++) {
    addMesh(table, geo.box, i % 2 ? mats.tileBlack : mats.tileWhite, {
      scale: [0.3, 0.09, 0.15],
      pos: [-0.75 + (i % 3) * 0.35, 0.855, -0.35 + Math.floor(i / 3) * 0.42],
      rot: [0, (i % 3 - 1) * 0.12, 0],
    });
  }
  room.add(table);
}

// ── Layout, lighting and assembly ───────────────────────────────────────────
function layout(style) {
  const props = new Set(style.props || []);
  const billiard = style.id === 'billiard' || props.has('billiardTable') || props.has('billiard');
  const cozy = style.id === 'cozy';

  return {
    props,
    billiard,
    sofa: billiard
      ? { x: -3.9, z: 0.9, rot: Math.PI / 2 }
      : { x: 0, z: -2.85, rot: 0 },
    sideTable: billiard
      ? { x: -3.35, z: -0.65, rot: 0 }
      : cozy
        ? { x: -1.75, z: -2.85, rot: 0 }
        : { x: 1.75, z: -2.85, rot: 0 },
    lamp: billiard ? { x: -2.9, z: 2.1 } : { x: -2.25, z: 2.8 },
    chandelier: billiard ? { x: -2.35, z: 0.9 } : { x: 1.55, z: -2.0 },
    plant: style.id === 'playful' ? { x: -3.85, z: -2.95 } : { x: 3.95, z: 2.85 },
    shelf: cozy
      ? { wall: 'right', x: ROOM.width / 2 - 0.18, z: -2.6, rot: -Math.PI / 2 }
      : billiard
        ? { wall: 'back', x: 3.3, z: -ROOM.depth / 2 + 0.18, rot: 0 }
        : { wall: 'right', x: ROOM.width / 2 - 0.18, z: -2.2, rot: -Math.PI / 2 },
    bar: props.has('bar') ? { z: 0.85 } : null,
    fireplace: cozy || props.has('fireplace'),
    books: props.has('books'),
    starLights: props.has('starLights'),
  };
}

function addLights(room, geo, mats, style, scene, opts, chandelierPlace) {
  const p = style.palette;
  const ambient = clamp(Math.max(num(p.ambient) ?? 0.85, 0.82), 0.5, 1.4);
  const intensity = clamp((num(p.lightIntensity) ?? 1) * 42, 18, 110);
  const lightColor = toHex(p.light, 0xfff3df);

  // Use the warm fixture colour as the sky term. Picking the (sometimes very
  // dark) ceiling colour made the billiard/cozy rooms fall into black at the
  // walls even with a healthy ambient value.
  const hemi = new THREE.HemisphereLight(
    new THREE.Color(lightColor),
    new THREE.Color(toHex(p.floor, 0xc9c2b6)).multiplyScalar(0.62),
    ambient,
  );
  hemi.position.set(0, 3, 0);
  room.add(hemi);

  // One shadow-casting key light, offset from the chandelier so the shade
  // does not block it.
  const key = new THREE.SpotLight(new THREE.Color(lightColor), intensity, 20, Math.PI / 3.6, 0.55, 2);
  key.position.set(0.9, 3.05, 1.0);
  key.target.position.set(0, 0.75, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(MAX_SHADOW, MAX_SHADOW);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  room.add(key, key.target);

  buildChandelier(room, geo, mats, lightColor, clamp(intensity * 0.16, 4, 9), chandelierPlace);

  // Configure the renderer when the page shares it; otherwise the page owns it.
  const renderer = (opts && opts.renderer) || (scene && scene.userData && scene.userData.renderer);
  if (renderer && renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
}

function buildRoom(state, style, wantTable) {
  const { group, geo, mats, scene, opts } = state;

  buildShell(group, geo, mats);
  const placements = artPlacements(style);
  buildWallArt(group, state, style, geo, mats);

  const l = layout(style);
  const win = chooseWindow(style, placements, l.shelf, l.bar);
  if (win) buildWindow(group, geo, mats, style, win);

  addLights(group, geo, mats, style, scene, opts, l.chandelier);

  buildSofa(group, geo, mats, l.sofa);
  buildChair(group, geo, mats, -2.55, 0.1, Math.PI / 2);
  buildChair(group, geo, mats, 2.55, 0.1, -Math.PI / 2);
  buildSideTable(group, geo, mats, l.sideTable, l.books);
  buildShelf(group, geo, mats, l.shelf);
  buildPlant(group, geo, mats, l.plant.x, l.plant.z);
  buildFloorLamp(group, geo, mats, l.lamp.x, l.lamp.z);

  if (l.fireplace) buildFireplace(group, geo, mats, state, style, 2.9);
  if (l.billiard) {
    buildBilliardTable(group, geo, mats);
    buildPendants(group, geo, mats, toHex(style.palette.light, 0xffe3ae), 8);
  }
  if (l.bar) buildBar(group, geo, mats);
  if (l.starLights) buildStarLights(group, geo, mats);

  if (wantTable) buildGameTable(group, geo, mats);

  group.userData.stats = {
    triangles: countTriangles(group),
    materials: state.materials.size,
    textures: state.textures.size,
    style: style.id,
    table: wantTable,
  };
}

function countTriangles(root) {
  let total = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    let tris = count / 3;
    if (o.isInstancedMesh) tris *= o.count;
    total += tris;
  });
  return Math.round(total);
}

function disposeState(state) {
  if (!state || state.disposed) return;
  state.disposed = true;

  const { group, scene } = state;
  if (group) {
    group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose?.();
      if (o.isLight) {
        o.shadow?.map?.dispose?.();
        o.shadow?.mapPass?.dispose?.();
        o.dispose?.();
      }
    });
    if (group.parent) group.parent.remove(group);
    else scene?.remove?.(group);
    group.clear();
  }

  for (const tex of state.textures) tex.dispose?.();
  for (const mat of state.materials) mat.dispose?.();
  for (const g of state.geometries) g.dispose?.();
  state.textures.clear();
  state.materials.clear();
  state.geometries.clear();

  if (group) GROUP_STATE.delete(group);
  if (scene && ROOMS.get(scene) === state) ROOMS.delete(scene);
}

// Public API ─────────────────────────────────────────────────────────────────
const CAMERA_MARGIN = 0.6;
const CAMERA_MIN_Y = 0.8;
const CAMERA_MAX_Y = 2.9;
const CAMERA_BOUNDS = {
  minX: -ROOM.width / 2 + CAMERA_MARGIN,
  maxX: ROOM.width / 2 - CAMERA_MARGIN,
  minZ: -ROOM.depth / 2 + CAMERA_MARGIN,
  maxZ: ROOM.depth / 2 - CAMERA_MARGIN,
};

/**
 * Keep an orbit camera inside the room. Call it after controls.update() every
 * frame: the camera can never leave the walls or go through the floor/ceiling,
 * so zooming out can never show the black outside of the room.
 */
export function clampCameraToRoom(camera, controls) {
  if (!camera || !camera.position) return null;
  const p = camera.position;
  p.x = clamp(p.x, CAMERA_BOUNDS.minX, CAMERA_BOUNDS.maxX);
  p.y = clamp(p.y, CAMERA_MIN_Y, CAMERA_MAX_Y);
  p.z = clamp(p.z, CAMERA_BOUNDS.minZ, CAMERA_BOUNDS.maxZ);

  // Panning is disabled in the demo, but keep the pivot inside too so the
  // helper is safe for callers that let the user pan.
  if (controls && controls.target) {
    const t = controls.target;
    const tx = clamp(t.x, CAMERA_BOUNDS.minX + 0.3, CAMERA_BOUNDS.maxX - 0.3);
    const ty = clamp(t.y, 0.35, 2.2);
    const tz = clamp(t.z, CAMERA_BOUNDS.minZ + 0.3, CAMERA_BOUNDS.maxZ - 0.3);
    if (tx !== t.x || ty !== t.y || tz !== t.z) {
      t.set(tx, ty, tz);
      camera.lookAt(t);
    }
  }
  return p;
}

export function createRoom(scene, styleId, opts = {}) {
  // Never throw on a missing/invalid scene — the caller may still be booting.
  if (!scene || typeof scene.add !== 'function') return new THREE.Group();

  const style = resolveStyle(styleId);
  const wantTable = !!(opts && opts.table);
  const existing = ROOMS.get(scene);

  if (existing) {
    const stillAttached = existing.group && existing.group.parent === scene;
    if (!existing.disposed && stillAttached && existing.styleId === style.id && existing.table === wantTable) {
      return existing.group;
    }
    disposeState(existing);
  }

  const state = {
    scene,
    group: new THREE.Group(),
    styleId: style.id,
    table: wantTable,
    opts: opts || {},
    disposed: false,
    materials: new Set(),
    textures: new Set(),
    geometries: new Set(),
    brick: null,
    ember: null,
  };
  state.group.name = `room3d-${style.id}`;
  state.group.userData.room = { width: ROOM.width, depth: ROOM.depth, height: ROOM.height };
  state.group.userData.dispose = () => disposeState(state);
  state.geo = createGeometry(state);
  state.mats = createMaterials(state, style);

  ROOMS.set(scene, state);
  GROUP_STATE.set(state.group, state);

  try {
    buildRoom(state, style, wantTable);
  } catch (err) {
    // A partial room is worse than an empty one; report and clean up.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[room3d] room build failed:', err);
    }
    disposeState(state);
    return new THREE.Group();
  }

  scene.add(state.group);
  return state.group;
}

/** Dispose a room group returned by createRoom (also used on style changes). */
export function disposeRoom(group) {
  if (!group) return;
  const state = GROUP_STATE.get(group);
  if (state) {
    disposeState(state);
    return;
  }
  // Foreign/cloned group: best-effort cleanup.
  group.traverse((o) => {
    if (o.isInstancedMesh) o.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        m?.[key]?.dispose?.();
      }
      m?.dispose?.();
    }
    o.geometry?.dispose?.();
  });
  group.parent?.remove(group);
}
