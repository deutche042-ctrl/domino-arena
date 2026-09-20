// js/sfx.js — tiny WebAudio synth SFX (no audio assets needed)

let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function noiseBurst(dur, freq, gain = .3) {
  const a = ac();
  const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = a.createGain(); g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

function tone(freq, dur, type = 'sine', gain = .18, when = 0) {
  const a = ac();
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, a.currentTime + when);
  g.gain.exponentialRampToValueAtTime(.001, a.currentTime + when + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + when); o.stop(a.currentTime + when + dur);
}

export const sfx = {
  click() { noiseBurst(.05, 2500, .15); },
  place() { noiseBurst(.09, 900, .5); tone(140, .08, 'triangle', .22); },
  draw() { noiseBurst(.16, 1800, .12); },
  pass() { tone(220, .15, 'sine', .12); },
  select() { tone(660, .06, 'sine', .08); },
  score() { tone(880, .12, 'sine', .15); tone(1320, .18, 'sine', .12, .08); },
  start() { tone(440, .1, 'sine', .1); tone(554, .1, 'sine', .1, .08); tone(659, .15, 'sine', .12, .16); noiseBurst(.15, 1200, .2); },
  handWin() { [523, 659, 784, 1047].forEach((f, i) => tone(f, .25, 'triangle', .16, i * .1)); },
  matchWin() { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, .35, 'triangle', .16, i * .12)); },
  yourTurn() { tone(587, .1, 'sine', .1); tone(880, .14, 'sine', .1, .1); },
};
