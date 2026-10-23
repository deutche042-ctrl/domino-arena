// js/sfx.js — Domino Arena sound engine, fully synthesized from scratch (no audio assets).
//
// Design notes:
// - Tile impacts use modal synthesis: a contact transient (filtered noise) plus a bank of
//   inharmonic sine partials with individual decays, the way a struck piece of bone/wood
//   actually rings. This reads as "real clack", not a video-game blip.
// - A synthesized stereo room impulse (decaying noise) feeds a convolution reverb send, so
//   everything sits in the same acoustic space instead of dry in the listener's head.
// - A gentle master compressor acts only as a peak safety net (narrow knee, low ratio) so
//   long sessions stay comfortable without squashing the dynamics.
// - Every hit randomizes pitch, timing, stereo position and velocity slightly, so repeated
//   actions never sound like a sample looping.

let ctx = null;
let master = null, dryBus = null, revSend = null;
let _noiseBuf = null;
let ambSrc = null, ambGain = null;
const _irCache = new Map();

// user mute preference (persisted). Every SFX voice routes through out(), so
// gating there silences everything except the ambient bed, which gates itself.
let muted = false;
try { muted = localStorage.getItem('domino_sfx_muted') === '1'; } catch (e) { /* no storage */ }

// K3.C6: master volume (0..1), persisted; the mute toggle sits on top of it.
let vol = 1;
try {
  const v = parseFloat(localStorage.getItem('domino_volume'));
  if (!Number.isNaN(v) && v >= 0 && v <= 1) vol = v;
} catch (e) { /* no storage */ }

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (!master) {
    master = ctx.createGain();
    master.gain.value = 0.95 * vol;
    // No DynamicsCompressor here: Chromium's implementation applies large gain
    // reduction even to quiet signals in OfflineAudioContext renders (params are
    // read back correctly but the DSP ignores them), and voice gains are already
    // bounded by design — so a straight master bus is predictable and safe.
    master.connect(ctx.destination);
    dryBus = ctx.createGain();
    dryBus.connect(master);
    revSend = ctx.createGain();
    revSend.gain.value = 0.32;
    const conv = ctx.createConvolver();
    conv.buffer = impulse(1.4, 3.2);
    revSend.connect(conv);
    conv.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// synthesized room impulse: stereo noise with an exponential decay tail
function impulse(seconds, decay) {
  const key = seconds + ':' + decay;
  if (_irCache.has(key)) return _irCache.get(key);
  const a = ac();
  const len = Math.max(1, Math.floor(a.sampleRate * seconds));
  const buf = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  _irCache.set(key, buf);
  return buf;
}

// one second of loopable white noise, shared by every noise voice
function noise() {
  if (_noiseBuf) return _noiseBuf;
  const a = ac();
  const len = a.sampleRate;
  _noiseBuf = a.createBuffer(1, len, a.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}

// per-voice output: gain → optional pan → dry bus (+ optional reverb send)
function out(pan, rev) {
  const a = ac();
  if (muted) {
    // silent dummy sink: oscillators still get scheduled (negligible cost)
    // but nothing reaches the speakers
    const g = a.createGain();
    g.gain.value = 0;
    return g;
  }
  const g = a.createGain();
  let tail = g;
  if (a.createStereoPanner && pan) {
    const p = a.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    tail = p;
  }
  tail.connect(dryBus);
  if (rev > 0) {
    const rs = a.createGain();
    rs.gain.value = rev;
    tail.connect(rs);
    rs.connect(revSend);
  }
  return g;
}

// instant-attack / exponential-decay envelope on a fresh GainNode
function env(t0, peak, attack, decay) {
  const a = ac();
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

// a single ringing modal partial
function ping(t0, freq, decay, amp, pan = 0, rev = 0.12) {
  const a = ac();
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.value = freq;
  const g = env(t0, amp, 0.002, decay);
  o.connect(g);
  g.connect(out(pan, rev));
  o.start(t0);
  o.stop(t0 + decay + 0.05);
}

// short pitched-down sine — the "body" of a knock on the table
function thump(t0, freq, dur, amp, pan = 0) {
  const a = ac();
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, t0);
  o.frequency.exponentialRampToValueAtTime(freq * 0.55, t0 + dur);
  const g = env(t0, amp, 0.004, dur);
  o.connect(g);
  g.connect(out(pan, 0.05));
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// filtered noise voice; sweepTo bends the filter for slides and whooshes
function burst(t0, opts = {}) {
  const { dur = 0.05, type = 'bandpass', freq = 2000, q = 1, amp = 0.3, sweepTo = null, pan = 0, rev = 0.08 } = opts;
  const a = ac();
  const src = a.createBufferSource();
  src.buffer = noise();
  src.loop = true;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const g = env(t0, amp, 0.004, dur);
  src.connect(f);
  f.connect(g);
  g.connect(out(pan, rev));
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.05);
}

// the hero sound: a tile striking the table
function clack(t0, pan = 0, vel = 1, depth = 0) {
  const k = 0.94 + Math.random() * 0.12; // per-hit pitch variation
  burst(t0, { dur: 0.014, freq: 3400 * k, q: 0.8, amp: 0.42 * vel, pan });
  // modal partials, each micro-detuned plus a grain of bandpassed noise so the
  // ring reads as wood grain instead of a clean synth sine
  [[1520, 0.052, 0.29], [2340, 0.04, 0.21], [3300, 0.03, 0.125], [4700, 0.022, 0.07]].forEach(([f, d, amp]) => {
    const kj = k * (0.985 + Math.random() * 0.03);
    ping(t0, f * kj, d, amp * vel, pan);
    burst(t0, { dur: d * 0.6, freq: f * kj, q: 9, amp: amp * vel * 0.35, pan });
  });
  thump(t0, 170 * k, 0.055, 0.25 * vel, pan);
  // tiles sometimes kiss a second time as they settle
  if (depth < 2 && Math.random() < 0.5) {
    clack(t0 + 0.03 + Math.random() * 0.05, pan, vel * (0.16 + Math.random() * 0.14), depth + 1);
  }
}

export const sfx = {
  // test hook: point the engine at an OfflineAudioContext (or null to reset)
  _use(c) {
    ctx = c;
    master = dryBus = revSend = null;
    _noiseBuf = null;
    ambSrc = ambGain = null;
    _irCache.clear();
  },

  isMuted() { return muted; },

  setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('domino_sfx_muted', muted ? '1' : '0'); } catch (e) { /* no storage */ }
    if (muted) this.ambient(false);
  },

  // K3.C6: settings-modal master volume slider
  getVolume() { return vol; },
  setVolume(v) {
    vol = Math.max(0, Math.min(1, Number(v) || 0));
    try { localStorage.setItem('domino_volume', String(vol)); } catch (e) { /* no storage */ }
    if (master) master.gain.value = 0.95 * vol;
  },

  click() {
    const a = ac();
    const t = a.currentTime + 0.005;
    burst(t, { dur: 0.02, freq: 1800, q: 1.2, amp: 0.24, rev: 0.04 });
    ping(t, 2400, 0.03, 0.1);
  },

  select() {
    const a = ac();
    const t = a.currentTime + 0.005;
    ping(t, 940, 0.035, 0.14);
    burst(t, { dur: 0.012, freq: 2600, q: 1.5, amp: 0.12 });
  },

  place(vel = 1) {
    const a = ac();
    const t = a.currentTime + 0.004 + Math.random() * 0.006;
    const pan = (Math.random() - 0.5) * 0.24; // tiles land anywhere on the table
    clack(t, pan, 0.95 * vel);
    if (Math.random() < 0.4) clack(t + 0.045 + Math.random() * 0.03, pan, 0.28); // settle tap
  },

  draw() {
    const a = ac();
    const t = a.currentTime + 0.005;
    // felt slide + soft pickup flick at the end
    burst(t, { dur: 0.13, type: 'lowpass', freq: 1100, sweepTo: 420, amp: 0.24, rev: 0.05 });
    burst(t + 0.115, { dur: 0.02, freq: 2100, q: 1.4, amp: 0.15 });
    thump(t + 0.118, 190, 0.03, 0.1);
  },

  pass() {
    const a = ac();
    const t = a.currentTime + 0.005;
    thump(t, 150, 0.07, 0.22);
    burst(t, { dur: 0.05, type: 'lowpass', freq: 600, amp: 0.09 });
  },

  score() {
    const a = ac();
    const t = a.currentTime + 0.005;
    // warm marimba-like pair — rewarding, never shrill
    [[880, 0], [1320, 0.07]].forEach(([f, w]) => {
      ping(t + w, f, 0.22, 0.2, 0, 0.2);
      ping(t + w, f * 2.51, 0.1, 0.055, 0, 0.2); // inharmonic overtone = wooden bar
    });
  },

  tick() {
    const a = ac();
    const t = a.currentTime + 0.002;
    // soft wooden tick for the countdown — present but not annoying
    burst(t, { dur: 0.012, freq: 2300, q: 2.2, amp: 0.16 });
    thump(t, 320, 0.025, 0.12);
  },

  yourTurn() {
    const a = ac();
    const t = a.currentTime + 0.005;
    [[587, 0], [784, 0.09]].forEach(([f, w]) => {
      ping(t + w, f, 0.28, 0.17, 0, 0.22);
      ping(t + w, f * 2, 0.14, 0.05, 0, 0.22);
    });
  },

  start() {
    const a = ac();
    const t = a.currentTime + 0.05;
    // a hand of tiles riffling onto the felt, then settling
    for (let i = 0; i < 7; i++) {
      clack(t + i * 0.052 + Math.random() * 0.02, (i % 2 ? 0.4 : -0.4) * (0.6 + Math.random() * 0.4), 0.5 + Math.random() * 0.3);
    }
    clack(t + 0.46, 0, 0.85);
  },

  handWin() {
    const a = ac();
    const t = a.currentTime + 0.02;
    [523, 659, 784, 1047].forEach((f, i) => {
      ping(t + i * 0.09, f, 0.34, 0.19, 0, 0.3);
      ping(t + i * 0.09, f * 2.51, 0.16, 0.045, 0, 0.3);
    });
    burst(t + 0.3, { dur: 0.25, type: 'highpass', freq: 5200, amp: 0.035, rev: 0.4 }); // shimmer tail
  },

  matchWin() {
    const a = ac();
    const t = a.currentTime + 0.02;
    [523, 659, 784, 1047].forEach((f, i) => {
      ping(t + i * 0.1, f, 0.4, 0.19, 0, 0.32);
      ping(t + i * 0.1, f * 2.51, 0.2, 0.05, 0, 0.32);
    });
    // final chord blooms in the reverb
    [523, 659, 784, 1047, 1319].forEach((f) => ping(t + 0.48, f, 0.8, 0.13, 0, 0.45));
    burst(t + 0.46, { dur: 0.4, type: 'highpass', freq: 4800, amp: 0.05, rev: 0.5 });
  },

  alarm() {
    // last 5 seconds of my turn: two quick wooden beeps — urgent, not harsh
    const a = ac();
    const t = a.currentTime + 0.002;
    ping(t, 1040, 0.07, 0.17, 0, 0.05);
    ping(t + 0.1, 1040, 0.07, 0.17, 0, 0.05);
    thump(t, 300, 0.03, 0.1);
  },

  chatPop() {
    const a = ac();
    const t = a.currentTime + 0.005;
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(340, t);
    o.frequency.exponentialRampToValueAtTime(690, t + 0.055);
    const g = env(t, 0.15, 0.006, 0.07);
    o.connect(g);
    g.connect(out(0, 0.1));
    o.start(t);
    o.stop(t + 0.14);
  },

  // quiet felt-room bed: a seamless low room-tone loop that starts with the
  // match and stops on leaving — gives the table a sense of place
  ambient(on) {
    const a = ac();
    if (on && muted) return; // gate the bed while muted; stopping always works
    if (on) {
      if (ambSrc) return;
      const len = a.sampleRate * 3;
      const buf = a.createBuffer(2, len, a.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02; // leaky integrator → warm brown-ish tone
          d[i] = last * 3.5;
        }
        // crossfade the seam so the loop point is inaudible
        const f = Math.floor(a.sampleRate * 0.05);
        for (let i = 0; i < f; i++) {
          const x = i / f;
          d[i] = d[i] * x + d[len - f + i] * (1 - x);
        }
      }
      const src = a.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      lp.Q.value = 0.4;
      const g = a.createGain();
      g.gain.setValueAtTime(0.0001, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.02, a.currentTime + 2.5); // slow fade-in
      src.connect(lp);
      lp.connect(g);
      g.connect(master);
      src.start();
      ambSrc = src;
      ambGain = g;
    } else if (ambSrc) {
      try {
        ambGain.gain.cancelScheduledValues(a.currentTime);
        ambGain.gain.setValueAtTime(Math.max(0.0002, ambGain.gain.value), a.currentTime);
        ambGain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.8);
        ambSrc.stop(a.currentTime + 0.9);
      } catch (e) { /* already stopped */ }
      ambSrc = null;
      ambGain = null;
    }
  },
};
