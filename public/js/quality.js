// quality.js — adaptive quality tier for the 3D boards (plan B2).
// Resolves a rendering tier ('high' | 'low') from a device heuristic plus a
// short live frame-time probe. Modes ('auto' | 'high' | 'low') are the user's
// pick, persisted in localStorage; only 'auto' may switch tier on its own,
// and a probe downgrade sticks for the session so tiers never flap mid-match.

const LS_KEY = 'domino_quality';
const PROBE_MS = 2000;          // live probe window
const PROBE_MIN_FPS = 28;       // below this the tier drops
const PROBE_SLOW_RATIO = 0.4;   // …or this share of frames ran under ~20fps

const listeners = new Set();

function loadMode() {
  try { const m = localStorage.getItem(LS_KEY); if (m === 'auto' || m === 'high' || m === 'low') return m; }
  catch { /* storage unavailable — default to auto */ }
  return 'auto';
}
function saveMode(m) {
  try { localStorage.setItem(LS_KEY, m); } catch { /* private mode etc. */ }
}

let mode = loadMode();
let downgraded = false;   // probe verdict for the session (auto mode only)
let heuristic = null;     // cached heuristic verdict
let probe = null;

function heuristicTier() {
  if (heuristic) return heuristic;
  let score = 0;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores >= 6) score += 2;
  else if (cores >= 4) score += 1;
  const mem = navigator.deviceMemory;
  if (mem === undefined) score += 1;        // unknown — don't punish desktops
  else if (mem >= 8) score += 2;
  else if (mem >= 4) score += 1;
  if ((window.devicePixelRatio || 1) <= 2) score += 1;
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches) score -= 1;
  else score += 2;
  heuristic = score >= 4 ? 'high' : 'low';
  return heuristic;
}

function currentTier() {
  if (mode === 'high' || mode === 'low') return mode;
  if (downgraded) return 'low';
  return heuristicTier();
}

function notify() {
  const q = getQuality();
  for (const cb of listeners) {
    try { cb(q); } catch (e) { console.warn('quality listener failed', e); }
  }
}

export function getQuality() {
  return { mode, tier: currentTier() };
}

export function setQuality(next) {
  if (next !== 'auto' && next !== 'high' && next !== 'low') return false;
  if (next !== mode) {
    mode = next;
    saveMode(mode);
    if (mode === 'auto') downgraded = false;   // fresh auto decision
    notify();
  }
  return true;
}

export function onQualityChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Called once per board construction. The probe only matters when auto mode
// resolved to 'high' — low starts cheap, and forced tiers are never switched.
export function startProbe() {
  if (probe || mode !== 'auto' || currentTier() !== 'high') return;
  probe = { t0: 0, last: 0, frames: 0, slow: 0 };
}

// One call per rendered frame (board3d/home3d render loops).
export function feedFrame(now) {
  if (!probe || mode !== 'auto') return;
  if (document.hidden) { probe.last = now; return; }   // hidden tabs stall rAF — don't count
  if (!probe.t0) { probe.t0 = now; probe.last = now; return; }
  probe.frames++;
  const dt = now - probe.last;
  probe.last = now;
  if (dt > 50) probe.slow++;   // ran under ~20fps
  const elapsed = now - probe.t0;
  if (elapsed >= PROBE_MS) {
    const fps = probe.frames / (elapsed / 1000);
    const ratio = probe.slow / Math.max(1, probe.frames);
    probe = null;   // one decision per session — no flapping
    if (fps < PROBE_MIN_FPS || ratio > PROBE_SLOW_RATIO) {
      downgraded = true;
      console.info('[quality] auto-downgraded to low tier');
      notify();
    }
  }
}
