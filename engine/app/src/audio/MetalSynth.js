/**
 * Struck metal by modal synthesis: a part rings as a sum of exponentially decaying sine modes.
 * Tuned for hollow metal boxes rather than bells, and dry: modes die within a fraction of a second,
 * high ones fade first, a short resonance of the part's hollow body (air and panels, pitched by
 * its size) gives the knock some body without ringing on (a long resonant noise sounds like a
 * bloop, a sagging pitch like a drop of water), and the contact is a short knock. What changes with the part:
 *   solid  (brackets, blocks, beams)  inharmonic bending families (free-free beam ratios 1, 2.76,
 *          5.40, 8.93, ... on three axes) plus torsion modes, lowest mode ~150 Hz x 15 cm / size;
 *          parts over 15 cm add a low thump (the weight landing)
 *   sheet  (thin shells: hull plates, covers)  dense plate modes (m^2 + k n^2), each split in two
 *          slightly detuned twins so it wobbles, plus a short high rattle: the metal-foil sound
 * Damping grows with frequency (internal friction: tau = 1 / (pi f eta)), capped by the part's
 * size (contacts in a pile damp it too), so a hit is bright for a moment and then hums. A part
 * smaller than a mode's wavelength radiates it poorly (amplitude ~ f / (c / 2 pi r) below that):
 * small parts lose their lowest modes, which keeps them metallic rather than boomy. Hardness
 * (speed) is left to the caller's low-pass. Everything is seeded: one part, one voice.
 */

const BEAM = [1, 2.756, 5.404, 8.933, 13.344, 18.638];

/** Small seeded PRNG (mulberry32), 0..1. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Modes [{ f, a, tau }] of a struck part of `kind` ('solid' | 'sheet') and bounding radius `radius` (m). */
export function modes(kind, radius, seed) {
  const r = rng(seed);
  const out = [];
  const eta = kind === 'sheet' ? 0.004 : 0.006; // loss factor: how fast a mode dies, per cycle
  const size = Math.min(1, radius / 0.5);
  const tauMax = kind === 'sheet' ? 0.05 + 0.15 * size : 0.035 + 0.12 * size; // big parts ring longer
  const radiates = 343 / (2 * Math.PI * radius); // Hz: below this the part is small for the wavelength
  const add = (f, a, detune = 0) => {
    if (f < 30 || f > 14000) return;
    const tau = Math.min(tauMax, 1 / (Math.PI * f * eta));
    out.push({ f: f * (1 + detune), a: a * Math.min(1, f / radiates), tau, phase: r() * 2 * Math.PI });
  };
  if (kind === 'sheet') {
    const f0 = 95 * Math.pow(0.15 / radius, 1.2);
    const k = 0.45 + 0.55 * r(); // plate aspect
    for (let m = 1; m <= 6; m++) {
      for (let n = 1; n <= 6; n++) {
        const ratio = (m * m + k * n * n) / (1 + k);
        const a = (0.25 + 0.75 * r()) * Math.pow(1 / ratio, 0.4);
        const split = 0.003 + 0.008 * r(); // twins a few Hz apart: the wobble
        add(f0 * ratio, a, -split);
        add(f0 * ratio, a * (0.5 + 0.5 * r()), split);
      }
    }
  } else {
    const f0 = 150 * (0.15 / radius);
    for (const axis of [1, 1.31 + 0.2 * r(), 1.85 + 0.35 * r()]) {
      BEAM.forEach((ratio, i) => add(f0 * axis * ratio * (1 + 0.05 * (r() - 0.5)), (0.3 + 0.7 * r()) * Math.pow(1 / (1 + i), 0.5)));
    }
    for (let i = 1; i <= 4; i++) add(f0 * (1.62 + 0.1 * r()) * i, (0.2 + 0.4 * r()) / i); // torsion
  }
  return out;
}

/**
 * Heavy scrap, for parts of `heavyMass` and more: ten characters on top of the size-bucketed voices.
 *   family  mode pattern: beam (bending, three axes, torsion), bar (fewer, brighter partials),
 *           plate (dense m^2 + k n^2), pipe (bending plus breathing rings), block (a damped cluster)
 *   f0 Hz lowest mode, ring s longest ring, bright amplitude roll-off (low: brighter),
 *   thump [Hz, level, decay s], bounce [delay s, level] (lands twice), twins (beating detune),
 *   rattle (loose high noise), grind (low scraping noise)
 */
export const HEAVY = [
  { name: 'girder', family: 'beam', f0: 62, ring: 0.34, bright: 0.25, thump: [48, 1.0, 0.09] },
  { name: 'anvil', family: 'bar', f0: 96, ring: 0.36, bright: 0.08, thump: [60, 0.6, 0.05] },
  { name: 'manhole cover', family: 'plate', f0: 70, ring: 0.34, bright: 0.2, thump: [45, 1.2, 0.1], twins: 0.004 },
  { name: 'oil drum', family: 'plate', f0: 52, ring: 0.3, bright: 0.35, thump: [40, 1.4, 0.12], rattle: 0.15 },
  { name: 'beam bounce', family: 'beam', f0: 58, ring: 0.28, bright: 0.3, thump: [50, 1.1, 0.08], bounce: [0.09, 0.45] },
  { name: 'slab', family: 'plate', f0: 40, ring: 0.35, bright: 0.4, thump: [36, 1.3, 0.11], twins: 0.008 },
  { name: 'chain', family: 'bar', f0: 110, ring: 0.15, bright: 0.2, thump: [55, 0.5, 0.05], rattle: 0.25, bounce: [0.05, 0.3] },
  { name: 'pipe', family: 'pipe', f0: 85, ring: 0.4, bright: 0.15, thump: [52, 0.7, 0.06] },
  { name: 'engine block', family: 'block', f0: 48, ring: 0.18, bright: 0.5, thump: [42, 1.5, 0.13], grind: 0.2 },
  { name: 'hull plate', family: 'plate', f0: 34, ring: 0.38, bright: 0.3, thump: [32, 1.2, 0.12], twins: 0.006, rattle: 0.1 },
];

/** Modes of a heavy preset (see HEAVY), varied a little by `seed`. */
export function heavyModes(preset, seed) {
  const r = rng(seed);
  const { family, f0, ring, bright, twins = 0 } = preset;
  const out = [];
  const add = (f, a) => {
    if (f < 25 || f > 12000) return;
    const tau = Math.min(0.45 * ring * (0.85 + 0.3 * r()), 1 / (Math.PI * f * 0.005));
    const radiates = Math.sqrt(Math.min(1, f / 180)); // big parts: the low modes stay audible
    const phase = r() * 2 * Math.PI;
    out.push({ f, a: a * radiates, tau, phase });
    if (twins) out.push({ f: f * (1 + twins * (0.5 + r())), a: a * radiates * 0.7, tau, phase: r() * 2 * Math.PI });
  };
  const roll = (i) => (0.4 + 0.6 * r()) * Math.pow(1 / (1 + i), bright + 0.3);
  const base = f0 * (0.94 + 0.12 * r());
  if (family === 'beam' || family === 'pipe') {
    for (const axis of [1, 1.27 + 0.2 * r(), 1.9 + 0.3 * r()]) BEAM.forEach((k, i) => add(base * axis * k, roll(i)));
    if (family === 'pipe') for (const k of [3.3, 7.9, 12.6]) add(base * k * (1 + 0.03 * r()), 0.8 * roll(1)); // breathing rings
    else for (let i = 1; i <= 3; i++) add(base * (1.6 + 0.1 * r()) * i, 0.5 * roll(i)); // torsion
  } else if (family === 'bar') {
    BEAM.forEach((k, i) => add(base * k, roll(i)));
    BEAM.forEach((k, i) => add(base * 1.41 * k, 0.6 * roll(i)));
  } else if (family === 'plate') {
    const k = 0.45 + 0.55 * r();
    for (let m = 1; m <= 5; m++) for (let n = 1; n <= 5; n++) add(base * ((m * m + k * n * n) / (1 + k)), roll(m + n - 2));
  } else {
    for (let i = 0; i < 14; i++) add(base * (1 + i * (0.55 + 0.3 * r())) * (1 + 0.1 * r()), roll(i)); // block: a lumpy cluster
  }
  return out;
}

/** A heavy preset's strike as samples (modes, thump, bounce, rattle, grind), peak-normalised to 0.9. */
export function renderHeavy(preset, seed, sampleRate = 32000) {
  const list = heavyModes(preset, seed);
  const r = rng(seed ^ 0x51ed27);
  const longest = Math.max(...list.map((m) => m.tau));
  const [delay = 0, again = 0] = preset.bounce ?? [];
  const n = Math.ceil(sampleRate * Math.min(2.2, Math.max(0.5, 5 * longest + delay + 0.05)));
  const strike = new Float32Array(n);
  addModes(strike, list, sampleRate);
  knock(strike, r, sampleRate);
  hollow(strike, r, sampleRate, preset.f0 * (2.2 + 0.6 * r()), 0.025 + 0.05 * preset.ring, 0.6);
  const [tf, tl, td] = preset.thump;
  for (let i = 0; i < Math.min(n, Math.ceil(4.2 * td * sampleRate)); i++) {
    const t = i / sampleRate;
    strike[i] += tl * Math.sin(2 * Math.PI * tf * t) * Math.exp(-t / (0.7 * td)); // steady pitch: a sagging one sounds like a drop of water
  }
  if (preset.rattle) noise(strike, r, sampleRate, 0.4 * preset.rattle, 0.08, 0.35, true);
  if (preset.grind) noise(strike, r, sampleRate, preset.grind, 0.18, 0.08, false);
  const out = strike.slice();
  if (again) {
    const off = Math.floor(delay * sampleRate);
    for (let i = off; i < n; i++) out[i] += again * strike[i - off];
  }
  return finish(out, sampleRate);
}

/** Adds decaying sines (recurrence s_n = 2 q cos w s_n-1 - q^2 s_n-2), each down to ~ -60 dB. */
function addModes(out, list, sampleRate) {
  const n = out.length;
  for (const { f, a, tau, phase } of list) {
    const w = (2 * Math.PI * f) / sampleRate;
    const q = Math.exp(-1 / (tau * sampleRate));
    const c = 2 * q * Math.cos(w);
    const q2 = q * q;
    let s2 = a * Math.cos(phase - w) / q; // s_-1
    let s1 = a * Math.cos(phase); // s_0
    const end = Math.min(n, Math.ceil(7 * tau * sampleRate));
    for (let i = 0; i < end; i++) {
      out[i] += s1;
      const s0 = c * s1 - q2 * s2;
      s2 = s1;
      s1 = s0;
    }
  }
}

/** The contact: a short, dry knock, 1.5 ms of lightly low-passed noise. */
function knock(out, r, sampleRate) {
  const k = Math.floor(0.0015 * sampleRate);
  let lp = 0;
  for (let i = 0; i < Math.min(out.length, k * 5); i++) {
    lp += 0.35 * (r() * 2 - 1 - lp);
    out[i] += 1.4 * lp * Math.exp(-i / k);
  }
}

/**
 * The hollow body: a resonance at `f` (air and panels of a box-like part) that decays over `tau`,
 * rung by a short noise burst, added at `level` (relative to its own peak).
 */
function hollow(out, r, sampleRate, f, tau, level) {
  const w = (2 * Math.PI * f) / sampleRate;
  const q = Math.exp(-1 / (tau * sampleRate));
  const c = 2 * q * Math.cos(w);
  const q2 = q * q;
  const burst = Math.floor(0.004 * sampleRate);
  const n = Math.min(out.length, burst + Math.ceil(7 * tau * sampleRate));
  const y = new Float32Array(n);
  let y1 = 0, y2 = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const v = (i < burst ? r() * 2 - 1 : 0) + c * y1 - q2 * y2;
    y2 = y1;
    y1 = v;
    y[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak > 0) for (let i = 0; i < n; i++) out[i] += (level * y[i]) / peak;
}

/** Noise decaying over `tau` s: high-passed with flutter (rattle) or low-passed (grind) by a one-pole of `pole`. */
function noise(out, r, sampleRate, level, tau, pole, high) {
  let lp = 0;
  for (let i = 0; i < Math.min(out.length, Math.ceil(5 * tau * sampleRate)); i++) {
    const x = r() * 2 - 1;
    lp += pole * (x - lp);
    const t = i / sampleRate;
    const flutter = high ? 0.7 + 0.3 * Math.sin(2 * Math.PI * 23 * t) : 1;
    out[i] += level * (high ? x - lp : 4 * lp) * Math.exp(-t / tau) * flutter;
  }
}

/** Peak-normalises to 0.9 and fades the last 20 ms, so a cut tail does not click. */
function finish(out, sampleRate) {
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.9 / peak;
  const fade = Math.floor(0.02 * sampleRate);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

/**
 * The strike as samples at `sampleRate`: the modes, a 2 ms contact click, the sheet's rattle or
 * the solid's thump. Peak-normalised to 0.9.
 */
export function renderStrike(kind, radius, seed, sampleRate = 32000) {
  const list = modes(kind, radius, seed);
  const longest = Math.max(...list.map((m) => m.tau));
  const n = Math.ceil(sampleRate * Math.min(2, Math.max(0.35, 5 * longest + 0.05)));
  const out = new Float32Array(n);
  addModes(out, list, sampleRate);
  const r = rng(seed ^ 0x9e3779b9);
  knock(out, r, sampleRate);
  const size = Math.min(1, radius / 0.5);
  hollow(out, r, sampleRate, Math.min(1600, Math.max(110, 343 / (5 * radius))) * (0.9 + 0.2 * r()), 0.012 + 0.04 * size, 0.5);
  if (kind === 'sheet') {
    noise(out, r, sampleRate, 0.08, 0.04 + 0.06 * Math.min(1, radius / 0.4), 0.35, true);
  } else if (radius > 0.1) {
    // thump: the weight landing, a low damped sine
    const f = 55 + 35 * (0.15 / radius);
    for (let i = 0; i < Math.min(n, Math.ceil(0.4 * sampleRate)); i++) {
      const t = i / sampleRate;
      out[i] += 1.2 * Math.min(1, radius / 0.3) * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.07);
    }
  }
  return finish(out, sampleRate);
}

/**
 * Voices per part for Web Audio: sizes are bucketed (25% steps) and each bucket has 3 variants;
 * a part plays its bucket's variant at the rate that moves it to its own size (pitch ~ 1 / size).
 * Parts of `heavyMass` (kg) and more pick one of 13 voices, always the same for a part: their 3
 * bucket variants or one of the 10 HEAVY presets, pitched by size around 30 cm.
 * Buffers are made on first use and kept.
 */
export class MetalSynth {
  constructor(ctx, { sampleRate = 32000, sheetFill = 8, variants = 3, heavyMass = 0.75 } = {}) {
    this.ctx = ctx;
    this.options = { sampleRate, sheetFill, variants, heavyMass };
    this.cache = new Map();
  }

  /** 'sheet' for thin shells (little mass for the size of their bounding sphere), else 'solid'. */
  kindOf(part) {
    const r = Math.max(0.03, part.boundingRadius);
    return part.mass / ((4 / 3) * Math.PI * r ** 3) < this.options.sheetFill ? 'sheet' : 'solid';
  }

  /** { buffer, rate } for `part`. */
  voice(part) {
    const { variants, heavyMass } = this.options;
    const r = Math.min(0.7, Math.max(0.03, part.boundingRadius));
    const hash = (part.id * 2654435761) >>> 0;
    if (part.mass >= heavyMass) {
      const v = hash % (variants + HEAVY.length);
      if (v >= variants) return { buffer: this._heavy(v - variants), rate: Math.min(1.25, Math.max(0.8, Math.sqrt(0.3 / r))) };
    }
    const bucket = Math.round(Math.log(r / 0.03) / Math.log(1.25));
    return { buffer: this._buffer(this.kindOf(part), bucket, hash % variants), rate: (0.03 * 1.25 ** bucket) / r };
  }

  /** Renders every voice ahead of use, one per idle slot, so a first hit does not stall a frame. */
  prepare() {
    const todo = HEAVY.map((_, i) => () => this._heavy(i));
    for (let bucket = 0; bucket <= 14; bucket++) {
      for (const kind of ['solid', 'sheet']) for (let v = 0; v < this.options.variants; v++) todo.push(() => this._buffer(kind, bucket, v));
    }
    const idle = globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 16));
    const next = () => {
      const job = todo.shift();
      if (!job) return;
      job();
      idle(next);
    };
    idle(next);
  }

  _buffer(kind, bucket, variant) {
    return this._cached(`${kind} ${bucket} ${variant}`, () => renderStrike(kind, 0.03 * 1.25 ** bucket, bucket * 31 + variant * 7919 + (kind === 'sheet' ? 1 : 0), this.options.sampleRate));
  }

  _heavy(i) {
    return this._cached(`heavy ${i}`, () => renderHeavy(HEAVY[i], 1000 + i * 7919, this.options.sampleRate));
  }

  _cached(key, render) {
    let buffer = this.cache.get(key);
    if (!buffer) {
      const data = render();
      buffer = this.ctx.createBuffer(1, data.length, this.options.sampleRate);
      buffer.copyToChannel(data, 0);
      this.cache.set(key, buffer);
    }
    return buffer;
  }
}
