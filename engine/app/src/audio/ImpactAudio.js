import { Vec3 } from '@sdfphys/core';
import { MetalSynth } from './MetalSynth.js';

const point = new Vec3();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MASS_CLASSES = [['light', 0.12], ['medium', 0.75], ['heavy', Infinity]]; // kg, upper bounds
const CLASS_MASS = { light: 0.06, medium: 0.3, heavy: 1.5 }; // a typical part of each class
const FALLBACK = { light: ['light', 'medium', 'heavy'], medium: ['medium', 'light', 'heavy'], heavy: ['heavy', 'medium', 'light'] };

/**
 * Metal impact sounds from the contacts of every physics step. A contact records how fast its
 * bodies were closing when the step began (Contact.approach); per touching pair the hardest one
 * counts, ranked by energy 1/2 mu v^2 (mu: the pair's reduced mass, a static body counting as
 * infinitely heavy). The loudest few hits of a step play, each pair at most once per `cooldown`,
 * and no more than `perSecond` in all: a pile landing is a rumble, not a drum roll.
 * Light parts (under 0.12 kg) tinkle, so they play sparingly: at most one a step, a `light.chance`
 * of the time, at `light.gain`. The sound is the pair's heavier moving part:
 *   voice     synthesised from the part (MetalSynth: size sets pitch and ring, thin shells ring
 *             as sheet metal, heavy parts get one of 13 heavy voices), or, when sample packs were indexed into
 *             `bank.json` (scripts/index-sounds.mjs), a sample of the part's shape and mass class
 *   loudness  ~ v * m^0.25 (clamped); brightness (low-pass cutoff, 2.5 to 12 kHz) rising with v
 *   position  at the contact, heard from the camera (Web Audio panner and listener)
 * The mix is dry: a little of a short generated room (0.6 s, `reverb` 7%) and a compressor. A low
 * cutoff, a long hall or a bass boost made it sound wet, as if underwater.
 * Resting contacts close at mm/s and stay silent. Browsers only start audio after a user
 * gesture, so the context is created by `unlock()` on the first click or key.
 */
export class ImpactAudio {
  constructor({ base = 'sounds/', volume = 0.6, minSpeed = 0.5, maxVoices = 32, perStep = 3, cooldown = 0.15, perSecond = 24, reverb = 0.07, light = { chance: 0.25, gain: 0.6 } } = {}) {
    this.options = { base, minSpeed, maxVoices, perStep, cooldown, perSecond, reverb, light };
    this._recent = []; // start times of the last second's sounds
    this.volume = volume;
    this.pitch = 0.8; // playback rate of every sound (the panel's "Pitch")
    this.enabled = true;
    this.ctx = null;
    this.synth = null;
    this.samples = null; // { solid: { heavy: [AudioBuffer], ... }, sheet: { ... } } when a pack is indexed
    this.booms = [];
    this.voices = 0;
    this.last = new Map(); // pair key -> time of its last sound
    this._off = null;
  }

  /** Creates the audio context and the mix bus, and loads the indexed samples (call from a user gesture). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    const ctx = (this.ctx = new Context());
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    limiter.connect(ctx.destination);
    const hall = ctx.createConvolver();
    hall.buffer = this._hall(0.6);
    const wet = ctx.createGain();
    wet.gain.value = this.options.reverb;
    hall.connect(wet).connect(limiter);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(limiter);
    this.master.connect(hall);
    this.synth = new MetalSynth(ctx);
    this.synth.prepare(); // every voice, in idle time (about 10 ms each)
    this._load();
  }

  /** Reads bank.json (written by scripts/index-sounds.mjs) and decodes what it lists. */
  async _load() {
    const { base } = this.options;
    const bank = await fetch(`${base}bank.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!bank) return;
    const decode = (file) => fetch(base + file).then((r) => r.arrayBuffer()).then((d) => this.ctx.decodeAudioData(d)).catch(() => null);
    const all = async (files) => (await Promise.all((files ?? []).map(decode))).filter(Boolean);
    this.booms = await all(bank.boom);
    const samples = {};
    let count = 0;
    for (const shape of ['solid', 'sheet']) {
      samples[shape] = {};
      for (const size of ['heavy', 'medium', 'light']) count += (samples[shape][size] = await all(bank.impacts?.[shape]?.[size])).length;
    }
    if (count > 0) this.samples = samples;
  }

  /** A stereo impulse response: decaying, darkening noise (a room `seconds` long). */
  _hall(seconds) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const ir = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      let y = 0;
      for (let i = 0; i < n; i++) {
        y += 0.3 * (Math.random() * 2 - 1 - y); // one-pole low-pass
        data[i] = y * Math.exp((-6.9 * i) / n);
      }
    }
    return ir;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Listens to `world`'s steps (call again for every new world). */
  attach(world) {
    this._off?.();
    this._off = world.on('step', () => this._collect(world));
  }

  /** Puts the listener at the camera. */
  updateListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const e = camera.matrixWorld.elements; // forward = -z column, up = y column
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = -e[8]; l.forwardY.value = -e[9]; l.forwardZ.value = -e[10];
      l.upX.value = e[4]; l.upY.value = e[5]; l.upZ.value = e[6];
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
  }

  _collect(world) {
    if (!this.ctx || !this.enabled || this.ctx.state !== 'running') return;
    // the GPU engine reads contacts back once every frame or two: hear each batch once
    if (world.stats.contactsStep === this._heard) return;
    this._heard = world.stats.contactsStep;
    const { minSpeed, perStep, cooldown } = this.options;
    const hits = new Map();
    for (const c of world.contacts) {
      const v = c.approach;
      if (!(v >= minSpeed)) continue;
      const a = c.bodyA, b = c.bodyB;
      const key = a.id < b.id ? a.id * 1e6 + b.id : b.id * 1e6 + a.id;
      const mu = 1 / ((a.isDynamic ? 1 / a.mass : 0) + (b.isDynamic ? 1 / b.mass : 0));
      if (!Number.isFinite(mu)) continue;
      const energy = 0.5 * mu * v * v;
      const hit = hits.get(key);
      if (!hit || energy > hit.energy) hits.set(key, { key, v, energy, contact: c });
    }
    const now = this.ctx.currentTime;
    const loudest = [...hits.values()].sort((x, y) => y.energy - x.energy).slice(0, perStep);
    let light = 0;
    while (this._recent.length && now - this._recent[0] > 1) this._recent.shift();
    for (const h of loudest) {
      if (this._recent.length >= this.options.perSecond) break; // a pile landing is a rumble, not a drum roll
      if (now - (this.last.get(h.key) ?? -1) < cooldown) continue;
      const { bodyA: a, bodyB: b } = h.contact;
      const part = !b.isDynamic || (a.isDynamic && a.mass >= b.mass) ? a : b;
      const isLight = part.mass < MASS_CLASSES[0][1];
      if (isLight && (light++ > 0 || Math.random() >= this.options.light.chance)) continue;
      this.last.set(h.key, now);
      this._recent.push(now);
      this._hit(part, h.v, h.contact.worldPoint(point), isLight ? this.options.light.gain : 1);
    }
    if (this.last.size > 4096) this.last.clear();
  }

  /** One impact of `part` at `v` m/s, heard at `p`, scaled by `level`. */
  _hit(part, v, p, level = 1) {
    const gain = level * Math.min(1, 0.26 * v * Math.pow(part.mass, 0.25));
    const cutoff = clamp(1500 + 2000 * v, 2500, 12000);
    const voice = this.samples ? this._sample(part) : this.synth.voice(part);
    if (!voice) return;
    const mix = this.samples ? gain : 0.7 * gain; // synthesised strikes ring longer than recorded hits
    this._play(voice.buffer, mix, voice.rate * (0.98 + 0.04 * Math.random()), this._channel(p, cutoff));
  }

  /** A sample for `part`: its shape (sheet / solid), its mass class, nudged in pitch within the class. */
  _sample(part) {
    const shape = this.synth.kindOf(part);
    const size = MASS_CLASSES.find(([, upTo]) => part.mass < upTo)[0];
    for (const s of [shape, shape === 'sheet' ? 'solid' : 'sheet']) {
      for (const c of FALLBACK[size]) {
        const list = this.samples[s][c];
        if (!list.length) continue;
        const rate = clamp(Math.pow(CLASS_MASS[c] / part.mass, 1 / 6), 0.85, 1.15);
        return { buffer: list[(Math.random() * list.length) | 0], rate };
      }
    }
    return null;
  }

  /** A low-pass at `cutoff` into a panner at `p`, into the mix. */
  _channel(p, cutoff, refDistance = 1.5) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.7;
    lp.connect(this._panner(p, refDistance)).connect(this.master);
    return lp;
  }

  _play(buffer, gain, rate, out) {
    if (this.voices >= this.options.maxVoices || gain < 0.01) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate * this.pitch;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    this.voices++;
    src.onended = () => { this.voices--; };
    src.start();
  }

  _panner(p, refDistance) {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.rolloffFactor = 0.6;
    if (panner.positionX) {
      panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z;
    } else panner.setPosition(p.x, p.y, p.z);
    return panner;
  }

  /** An explosion, louder and deeper with `strength` (0..1): a blast sample (if any) over a falling sub thump. */
  boom(p, strength = 1) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const out = this._channel(p, 8000, 4);
    const gain = Math.min(1, 0.5 + 0.5 * strength);
    if (this.booms.length) this._play(this.booms[(Math.random() * this.booms.length) | 0], gain, 1.05 - 0.3 * strength, out);
    const t = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(80, t);
    thump.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    thump.connect(g).connect(out);
    thump.start(t);
    thump.stop(t + 0.75);
  }
}
