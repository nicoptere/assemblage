import { Quat } from '../math/Quat.js';
import { Mat3 } from '../math/Mat3.js';
import { Vec3 } from '../math/Vec3.js';
import { edt2 } from './brickpack/field.js';

export const FIT_DEFAULTS = Object.freeze({
  outside: 1, // penalty per unit of part volume outside the target
  overlap: 0.5, // penalty per unit of part volume on target already filled
  minGain: 0.4, // a part is placed if (useful - penalties) / its volume reaches this
  orientations: 32, // rotations tried per candidate position (24 axis-aligned + random)
  positions: 24, // candidate positions per part
  refine: 4, // hill-climbing rounds on the best candidates
  keep: 3, // candidates refined per part
  depthEvery: 4, // parts between updates of the depth map, at least,
  depthShare: 0.01, // and share of the target filled since the last update, at least
  seed: 1,
});

/** Small seeded generator (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 24 rotations of the cube, then uniform random ones (Shoemake), up to `n`. */
function rotationSet(n, rand) {
  const out = [];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])
    for (const s of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]) {
      const cols = p.map((a, c) => axes[a].map((v) => v * s[c]));
      const e = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
      const det = e[0] * (e[4] * e[8] - e[5] * e[7]) - e[1] * (e[3] * e[8] - e[5] * e[6]) + e[2] * (e[3] * e[7] - e[4] * e[6]);
      if (det > 0) out.push(quatFromMatrix(e));
    }
  while (out.length < n) {
    const [u1, u2, u3] = [rand(), rand(), rand()];
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    out.push(new Quat(s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3)));
  }
  return out.slice(0, Math.max(1, n));
}

function quatFromMatrix(e) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = e;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return new Quat(x, y, z, w).normalize();
}

/**
 * Greedy volumetric fit of rigid parts into a target volume (TargetVolume), largest parts first.
 * For each part, candidate positions are drawn deep inside the part of the target still empty
 * (distance transform of the unfilled region, preferring a depth that matches the part's size),
 * each tried at `orientations` rotations; the best few are refined by hill climbing (smaller and
 * smaller moves and turns). A pose scores, per unit of the part's volume,
 *   (volume filling empty target) - overlap x (volume on filled target) - outside x (volume outside)
 * and the part is placed if that reaches `minGain`. Parts that fit nowhere are left out.
 * `run(stencils)` is a generator (one step per part, yielding progress and the part's placement,
 * if it got one), so a build can start before the fit ends; `fit(stencils)` runs it to the end.
 * Stencils come from partStencil.
 */
export class ShapeFit {
  constructor(target, options = {}) {
    this.target = target;
    this.options = { ...FIT_DEFAULTS, ...options };
    this.rand = random(this.options.seed);
    this.rotations = rotationSet(this.options.orientations, this.rand);
    this.filled = new Float32Array(target.inside.length);
    this.placements = [];
    this._m = new Mat3();
  }

  fit(stencils) {
    const it = this.run(stencils);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }

  *run(stencils) {
    const t0 = Date.now();
    const order = stencils.map((s, i) => i).sort((a, b) => stencils[b].weight - stencils[a].weight);
    // the depth map costs ~0.15 us per grid node: refresh it once enough has been placed since
    let sinceDepth = Infinity;
    let sinceWeight = Infinity;
    for (let k = 0; k < order.length; k++) {
      if (sinceDepth >= this.options.depthEvery && sinceWeight >= this.options.depthShare * this.target.count) {
        this._updateDepth();
        sinceDepth = 0;
        sinceWeight = 0;
      }
      const index = order[k];
      const best = this._bestPose(stencils[index]);
      let placement = null;
      if (best && best.gain >= this.options.minGain) {
        this._apply(stencils[index], best);
        placement = { index, position: best.p.toArray(), quaternion: best.q.toArray(), gain: best.gain };
        this.placements.push(placement);
        sinceDepth++;
        sinceWeight += stencils[index].weight;
      }
      yield { done: k + 1, total: order.length, placed: this.placements.length, placement };
    }
    return { placements: this.placements, stats: { ...this.stats(), ms: Date.now() - t0 } };
  }

  /** Overlap of the placed parts and the target: soft IoU, share of the target filled. */
  stats() {
    const { inside } = this.target;
    let inter = 0, union = 0, filled = 0;
    for (let n = 0; n < inside.length; n++) {
      const t = inside[n], o = Math.min(1, this.filled[n]);
      inter += Math.min(t, o);
      union += Math.max(t, o);
      if (t && o >= 0.5) filled++;
    }
    return { iou: union ? inter / union : 0, coverage: this.target.count ? filled / this.target.count : 0, placed: this.placements.length };
  }

  /** Squared distance (voxels) of every unfilled target voxel to the nearest filled or outside one. */
  _updateDepth() {
    const { inside, nx, ny, nz } = this.target;
    const seed = new Uint8Array(inside.length);
    for (let n = 0; n < inside.length; n++) seed[n] = inside[n] && this.filled[n] < 0.5 ? 0 : 1;
    // edt2 indexes (y * nz + z) * nx + x; our (k * ny + j) * nx + i is that with y and z swapped
    this.depth = edt2(seed, nx, nz, ny);
    this.empty = [];
    for (let n = 0; n < inside.length; n++) if (!seed[n]) this.empty.push(n);
  }

  /** Candidate positions: unfilled voxels, drawn with weight min(depth, part radius)^2. */
  _candidates(stencil) {
    const { empty, depth } = this;
    if (!empty.length) return [];
    const r = 0.5 * Math.cbrt(stencil.weight); // radius-ish, in voxels
    const cum = new Float64Array(empty.length);
    let total = 0;
    for (let i = 0; i < empty.length; i++) {
      const d = Math.min(Math.sqrt(depth[empty[i]]), r);
      total += d * d + 1e-3;
      cum[i] = total;
    }
    const out = [];
    for (let c = 0; c < this.options.positions; c++) {
      const u = this.rand() * total;
      let lo = 0, hi = empty.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      out.push(this.target.position(empty[lo]));
    }
    return out;
  }

  _bestPose(stencil) {
    const candidates = this._candidates(stencil);
    if (!candidates.length) return null;
    const top = [];
    for (const [x, y, z] of candidates) {
      for (const q of this.rotations) {
        const gain = this._score(stencil, q, x, y, z);
        if (top.length < this.options.keep || gain > top[top.length - 1].gain) {
          top.push({ gain, q, p: new Vec3(x, y, z) });
          top.sort((a, b) => b.gain - a.gain);
          if (top.length > this.options.keep) top.pop();
        }
      }
    }
    let best = null;
    for (const t of top) {
      const r = this._refine(stencil, { gain: t.gain, q: t.q.clone(), p: t.p.clone() });
      if (!best || r.gain > best.gain) best = r;
    }
    return best;
  }

  /** Hill climbing: moves of `step` along the axes and turns of `angle` about them, halving both. */
  _refine(stencil, pose) {
    const h = this.target.voxel;
    let step = 2 * h;
    let angle = 0.3;
    const dq = new Quat();
    const q = new Quat();
    const axis = new Vec3();
    for (let round = 0; round < this.options.refine; round++) {
      let improved = true;
      while (improved) {
        improved = false;
        for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
          axis.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
          const p = pose.p.clone().addScaled(axis, s * step);
          const g = this._score(stencil, pose.q, p.x, p.y, p.z);
          if (g > pose.gain + 1e-9) { pose = { gain: g, q: pose.q, p }; improved = true; }
          dq.setFromAxisAngle(axis, s * angle);
          q.multiplyQuats(dq, pose.q).normalize();
          const g2 = this._score(stencil, q, pose.p.x, pose.p.y, pose.p.z);
          if (g2 > pose.gain + 1e-9) { pose = { gain: g2, q: q.clone(), p: pose.p }; improved = true; }
        }
      }
      step /= 2;
      angle /= 2;
    }
    return pose;
  }

  /** (useful - overlap x wasted - outside x out) / part volume, for the part at (q, x, y, z). */
  _score(stencil, q, px, py, pz) {
    const e = this._m.setFromQuat(q).e;
    const { points: s, weights: w } = stencil;
    const { lo, voxel, nx, ny, nz, inside } = this.target;
    const filled = this.filled;
    const inv = 1 / voxel;
    const { outside, overlap } = this.options;
    let gain = 0;
    for (let i = 0, n = w.length; i < n; i++) {
      const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
      const ix = Math.round((e[0] * x + e[1] * y + e[2] * z + px - lo[0]) * inv);
      const iy = Math.round((e[3] * x + e[4] * y + e[5] * z + py - lo[1]) * inv);
      const iz = Math.round((e[6] * x + e[7] * y + e[8] * z + pz - lo[2]) * inv);
      const wi = w[i];
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) {
        gain -= outside * wi;
        continue;
      }
      const v = (iz * ny + iy) * nx + ix;
      if (!inside[v]) {
        gain -= outside * wi;
        continue;
      }
      const useful = Math.min(wi, Math.max(0, 1 - filled[v]));
      gain += useful - overlap * (wi - useful);
    }
    return gain / stencil.weight;
  }

  _apply(stencil, { q, p }) {
    const e = this._m.setFromQuat(q).e;
    const { points: s, weights: w } = stencil;
    const { lo, voxel, nx, ny, nz } = this.target;
    const inv = 1 / voxel;
    for (let i = 0; i < w.length; i++) {
      const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
      const ix = Math.round((e[0] * x + e[1] * y + e[2] * z + p.x - lo[0]) * inv);
      const iy = Math.round((e[3] * x + e[4] * y + e[5] * z + p.y - lo[1]) * inv);
      const iz = Math.round((e[6] * x + e[7] * y + e[8] * z + p.z - lo[2]) * inv);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
      this.filled[(iz * ny + iy) * nx + ix] += w[i];
    }
  }
}
