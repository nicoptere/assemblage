import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';
import { Contact } from './Contact.js';
import { SampleTree } from './SampleTree.js';

const M = new Mat3();
const trees = new WeakMap(); // body.localSamples -> SampleTree (a body gets a new array when its samples change)

function treeOf(body) {
  let tree = trees.get(body.localSamples);
  if (!tree) trees.set(body.localSamples, (tree = new SampleTree(body.localSamples)));
  return tree;
}
const t = new Vec3();
const g = new Vec3();

/**
 * True when no point within `reach` of tree node c's centre (moved into D's space by M, t) can be
 * closer than `reach` to D's surface, i.e. none of the node's samples can be a candidate:
 * either the centre is farther than `reach` from D's grid box, or a lower bound of D's distance
 * at the centre exceeds `reach` (a distance field changes by at most the distance moved).
 * Outside the grid, the distance is extended by the distance to the box, which can overestimate;
 * subtracting that extension twice gives a lower bound (the clamped point's value minus the gap).
 */
function nodeClear(shape, box, centres, c, reach) {
  const e = M.e;
  const x = centres[c * 3], y = centres[c * 3 + 1], z = centres[c * 3 + 2];
  const px = e[0] * x + e[1] * y + e[2] * z + t.x;
  const py = e[3] * x + e[4] * y + e[5] * z + t.y;
  const pz = e[6] * x + e[7] * y + e[8] * z + t.z;
  let gap = 0;
  if (box) {
    const dx = Math.max(box.min.x - px, 0, px - box.max.x);
    const dy = Math.max(box.min.y - py, 0, py - box.max.y);
    const dz = Math.max(box.min.z - pz, 0, pz - box.max.z);
    gap = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (gap > reach && reach > 0) return true;
  }
  return shape.distance(px, py, pz) - 2 * gap > reach;
}

/**
 * Sample-vs-SDF contact generation, the only collision routine in the engine:
 * the surface samples of each body are moved into the other body's shape space and tested
 * against its distance function, in both directions.
 *
 * The candidates of both directions are pooled per pair, then split in two:
 *   touching    (phi < margin):  reduced to `maxContacts` by farthest-point sampling seeded at
 *                                the deepest point, so resting patches stay well supported;
 *   speculative (phi < margin + relative speed * dt):  only the `maxSpeculative` closest, which
 *                                is enough to stop fast bodies tunnelling without flooding the
 *                                solver when a ball's swept margin covers half the scene.
 * Pooling matters on face-to-face contacts, where both directions find the same patch: capped
 * separately they would solve it twice.
 * The speculative sweep is capped at `maxSweep` unless one body is flagged `ccd` (bullets) or is
 * a half-space (ground, walls), which nothing may pass: fast debris may then sink into other
 * debris for a frame, but collision cost stays bounded.
 * Samples are visited through a bounding-sphere tree (see SampleTree): a subtree whose sphere is
 * clear of the other surface is skipped with one box test or one distance lookup.
 * Contacts are pooled and reused every step.
 */
export class Narrowphase {
  constructor({ maxContacts = 32, maxSpeculative = 4, margin = 0.004, maxSweep = 0.05 } = {}) {
    this.maxContacts = maxContacts;
    this.maxSpeculative = maxSpeculative;
    this.margin = margin;
    this.maxSweep = maxSweep;
    this.pool = [];
    this.used = 0;
    this._grow(1024);
  }

  /** Candidate buffers for one pair (both directions): slot n holds one sample near the other body. */
  _grow(n) {
    this._cap = n;
    this._side = new Uint8Array(n); // 0: a sample of a against b, 1: of b against a
    this._idx = new Int32Array(n); // sample index
    this._phi = new Float64Array(n); // distance to the other surface
    this._pos = new Float64Array(n * 3); // in the other body's shape space
    this._world = new Float64Array(n * 3); // in world space (for spreading the selection)
    this._minD = new Float64Array(n);
    this._touch = new Int32Array(n);
    this._spec = new Int32Array(n);
  }

  /** Recycles the contacts of the previous step. */
  begin() {
    this.used = 0;
  }

  collide(a, b, dt, out) {
    const margin = this.pairMargin(a, b, dt);
    this.beginPair(a, b);
    this._gather(a, b, margin, 0);
    this._gather(b, a, margin, 1);
    this.endPair(a, b, out);
  }

  /**
   * How close a sample must come to the other surface to be a candidate this step: the contact
   * margin plus how far the pair can close. Half-spaces are cheap to test and nothing may pass
   * them: their sweep is uncapped and also covers how far a neighbour could shove the body.
   */
  pairMargin(a, b, dt) {
    const speed = t.subVectors(a.velocity, b.velocity).length() +
      a.angularVelocity.length() * a.boundingRadius +
      (b.shape.infinite ? 0 : b.angularVelocity.length() * b.boundingRadius);
    const sweep = speed * dt;
    const half = a.shape.infinite || b.shape.infinite;
    return this.margin + (half ? sweep + a.pushed + b.pushed : a.ccd || b.ccd ? sweep : Math.min(sweep, this.maxSweep));
  }

  /**
   * The three steps of `collide`, for a backend that finds candidates elsewhere (a GPU pass):
   * beginPair, then addCandidate for each sample within the pair's margin, then endPair.
   */
  beginPair(a, b) {
    this._half = a.shape.infinite || b.shape.infinite;
    const need = (a.localSamples.length + b.localSamples.length) / 3;
    if (need > this._cap) this._grow(need);
    this._n = this._nt = this._ns = 0;
  }

  /**
   * Sample `i` of S (`side` 0: S is the pair's a, 1: its b) at `d` from D's surface, at (px, py, pz)
   * in D's shape space. S.rotation must be current (bounds update sets it).
   */
  addCandidate(S, side, i, d, px, py, pz) {
    const n = this._n;
    const s = S.localSamples;
    const r = S.rotation.e;
    const P = S.position;
    const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
    this._side[n] = side;
    this._idx[n] = i;
    this._phi[n] = d;
    this._pos[n * 3] = px;
    this._pos[n * 3 + 1] = py;
    this._pos[n * 3 + 2] = pz;
    this._world[n * 3] = r[0] * x + r[1] * y + r[2] * z + P.x;
    this._world[n * 3 + 1] = r[3] * x + r[4] * y + r[5] * z + P.y;
    this._world[n * 3 + 2] = r[6] * x + r[7] * y + r[8] * z + P.z;
    if (d < this.margin) this._touch[this._nt++] = n;
    else this._spec[this._ns++] = n;
    this._n = n + 1;
  }

  endPair(a, b, out) {
    if (this._n > 0) this._reduce(a, b, out);
  }

  /**
   * Where body-local points of S land in D's shape space: p = M s + t, with M (row-major 3x3,
   * D's rotation transposed times S's) and t written into `out` as [m00, m01, m02, tx, m10, ..., tz].
   * S.rotation and D.rotation must be current.
   */
  frame(S, D, out) {
    this._frame(S, D);
    const e = M.e;
    out[0] = e[0]; out[1] = e[1]; out[2] = e[2]; out[3] = t.x;
    out[4] = e[3]; out[5] = e[4]; out[6] = e[5]; out[7] = t.y;
    out[8] = e[6]; out[9] = e[7]; out[10] = e[8]; out[11] = t.z;
    return out;
  }

  /** Deepest penetration between two bodies in their current pose (0 if apart). */
  penetration(a, b) {
    return Math.max(this._deepest(a, b), this._deepest(b, a));
  }

  /**
   * Where two bodies come closest in their current pose, if within `reach`: { gap, point }, gap
   * the smallest distance from a sample of one to the other's surface (negative where they
   * overlap), point that sample in world space. Null when they are farther apart than `reach`.
   */
  closest(a, b, reach) {
    const p = this._closest(a, b, reach);
    const q = this._closest(b, a, p ? p.gap : reach);
    return q ?? p;
  }

  _closest(S, D, reach) {
    const s = S.localSamples;
    if (s.length === 0) return null;
    S.rotation.setFromQuat(S.quaternion);
    D.rotation.setFromQuat(D.quaternion);
    this._frame(S, D);
    const e = M.e;
    const shape = D.shape;
    const box = shape.infinite ? null : shape.localAabb;
    const { members, from, to, centres, radii, skip, count } = treeOf(S);
    let best = reach;
    let at = -1;
    for (let c = 0; c < count; ) {
      if (nodeClear(shape, box, centres, c, radii[c] + best)) {
        c = skip[c];
        continue;
      }
      if (skip[c] !== c + 1) {
        c++;
        continue;
      }
      for (let m = from[c]; m < to[c]; m++) {
        const i = members[m] * 3;
        const x = s[i], y = s[i + 1], z = s[i + 2];
        const px = e[0] * x + e[1] * y + e[2] * z + t.x;
        const py = e[3] * x + e[4] * y + e[5] * z + t.y;
        const pz = e[6] * x + e[7] * y + e[8] * z + t.z;
        const m2 = Math.max(0, best);
        if (box && (px < box.min.x - m2 || px > box.max.x + m2 || py < box.min.y - m2 || py > box.max.y + m2 || pz < box.min.z - m2 || pz > box.max.z + m2)) continue;
        const phi = shape.distance(px, py, pz);
        if (phi < best) {
          best = phi;
          at = i;
        }
      }
      c++;
    }
    if (at < 0) return null;
    const point = new Vec3(s[at], s[at + 1], s[at + 2]).applyQuat(S.quaternion).add(S.position);
    return { gap: best, point };
  }

  _frame(S, D) {
    // shape-space point of D for a body-local point s of S:  M s + t
    M.setTransposeMul(D.rotation, S.rotation);
    t.subVectors(S.position, D.position).applyQuatInverse(D.quaternion).add(D.com);
  }

  _deepest(S, D) {
    const s = S.localSamples;
    if (s.length === 0) return 0;
    S.rotation.setFromQuat(S.quaternion);
    D.rotation.setFromQuat(D.quaternion);
    this._frame(S, D);
    const e = M.e;
    const shape = D.shape;
    const box = shape.infinite ? null : shape.localAabb;
    const { members, from, to, centres, radii, skip, count } = treeOf(S);
    let deepest = 0;
    for (let c = 0; c < count; ) {
      if (nodeClear(shape, box, centres, c, radii[c] - deepest)) {
        c = skip[c];
        continue;
      }
      if (skip[c] !== c + 1) {
        c++;
        continue;
      }
      for (let m = from[c]; m < to[c]; m++) {
        const i = members[m] * 3;
        const x = s[i], y = s[i + 1], z = s[i + 2];
        const px = e[0] * x + e[1] * y + e[2] * z + t.x;
        const py = e[3] * x + e[4] * y + e[5] * z + t.y;
        const pz = e[6] * x + e[7] * y + e[8] * z + t.z;
        if (box && (px < box.min.x || px > box.max.x || py < box.min.y || py > box.max.y || pz < box.min.z || pz > box.max.z)) continue;
        const phi = shape.distance(px, py, pz);
        if (-phi > deepest) deepest = -phi;
      }
      c++;
    }
    return deepest;
  }

  /** Appends the samples of S within `margin` of D's surface to the pair's candidates. */
  _gather(S, D, margin, side) {
    const s = S.localSamples;
    if (s.length === 0) return;
    this._frame(S, D);
    const e = M.e;
    const r = S.rotation.e;
    const P = S.position;
    const shape = D.shape;
    const box = shape.infinite ? null : shape.localAabb;
    const { _side: sides, _idx: idx, _phi: phi, _pos: pos, _world: world, _touch: touch, _spec: spec } = this;
    const touching = this.margin;
    let { _n: n, _nt: nt, _ns: ns } = this;

    const { members, from, to, centres, radii, skip, count: nodes } = treeOf(S);
    for (let c = 0; c < nodes; ) {
      if (nodeClear(shape, box, centres, c, radii[c] + margin)) {
        c = skip[c];
        continue;
      }
      if (skip[c] !== c + 1) {
        c++;
        continue;
      }
      for (let m = from[c]; m < to[c]; m++) {
        const i = members[m];
        const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
        const px = e[0] * x + e[1] * y + e[2] * z + t.x;
        const py = e[3] * x + e[4] * y + e[5] * z + t.y;
        const pz = e[6] * x + e[7] * y + e[8] * z + t.z;
        if (box && (
          px < box.min.x - margin || px > box.max.x + margin ||
          py < box.min.y - margin || py > box.max.y + margin ||
          pz < box.min.z - margin || pz > box.max.z + margin
        )) continue;
        const d = shape.distance(px, py, pz);
        if (d >= margin) continue;
        sides[n] = side;
        idx[n] = i;
        phi[n] = d;
        pos[n * 3] = px;
        pos[n * 3 + 1] = py;
        pos[n * 3 + 2] = pz;
        world[n * 3] = r[0] * x + r[1] * y + r[2] * z + P.x;
        world[n * 3 + 1] = r[3] * x + r[4] * y + r[5] * z + P.y;
        world[n * 3 + 2] = r[6] * x + r[7] * y + r[8] * z + P.z;
        if (d < touching) touch[nt++] = n;
        else spec[ns++] = n;
        n++;
      }
      c++;
    }
    Object.assign(this, { _n: n, _nt: nt, _ns: ns });
  }

  /**
   * Reduces the pair's candidates and emits them as contacts. Against a half-space every
   * candidate is spread, speculative ones included: a few closest points would all sit on one
   * corner of a tumbling part, and the rest of it would swing through.
   */
  _reduce(a, b, out) {
    const { _side: sides, _idx: idx, _phi: phi, _touch: touch, _spec: spec } = this;
    let { _nt: nt, _ns: ns } = this;
    if (this._half && ns > 0) {
      touch.set(spec.subarray(0, ns), nt);
      nt += ns;
      ns = 0;
    }
    // sample order, so results do not depend on how the trees split the samples
    const bySample = (p, q) => sides[p] - sides[q] || idx[p] - idx[q];
    touch.subarray(0, nt).sort(bySample);
    for (const k of this._spread(touch, nt)) this._emit(a, b, k, out);
    if (ns > 0) {
      const closest = Array.from(spec.subarray(0, ns)).sort((p, q) => phi[p] - phi[q] || bySample(p, q));
      for (const k of closest.slice(0, this.maxSpeculative)) this._emit(a, b, k, out);
    }
  }

  _emit(a, b, k, out) {
    const [S, D] = this._side[k] ? [b, a] : [a, b];
    const pos = this._pos;
    const px = pos[k * 3], py = pos[k * 3 + 1], pz = pos[k * 3 + 2];
    const d = D.shape.distance(px, py, pz, g);
    const i = this._idx[k] * 3;
    const s = S.localSamples;
    const c = this.used < this.pool.length ? this.pool[this.used] : (this.pool[this.used] = new Contact());
    this.used++;
    c.init(S, D, s[i], s[i + 1], s[i + 2], px - d * g.x - D.com.x, py - d * g.y - D.com.y, pz - d * g.z - D.com.z, g, -d);
    out.push(c);
  }

  /**
   * Farthest-point reduction of `list[0..n)` (world positions) seeded at the deepest candidate,
   * penetrating candidates first: plain spreading favours a patch's rim, which barely touches,
   * over its middle, which sinks in. Candidates still within the margin only fill what is left.
   */
  _spread(list, n) {
    const K = this.maxContacts;
    const sel = Array.from(list.subarray(0, n));
    if (n <= K) return sel;
    const phi = this._phi;
    const pos = this._world;
    const minD = this._minD;
    let first = sel[0];
    for (const k of sel) if (phi[k] < phi[first]) first = k;
    const keep = [first];
    for (const k of sel) minD[k] = Infinity;
    let last = first;
    while (keep.length < K) {
      let best = -1, bestD = 0; // penetrating
      let fill = -1, fillD = 0; // within the margin
      const lx = pos[last * 3], ly = pos[last * 3 + 1], lz = pos[last * 3 + 2];
      for (const k of sel) {
        const dx = pos[k * 3] - lx, dy = pos[k * 3 + 1] - ly, dz = pos[k * 3 + 2] - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < minD[k]) minD[k] = d2;
        if (phi[k] < 0) {
          if (minD[k] > bestD) {
            bestD = minD[k];
            best = k;
          }
        } else if (minD[k] > fillD) {
          fillD = minD[k];
          fill = k;
        }
      }
      if (best < 0) best = fill;
      if (best < 0) break;
      keep.push(best);
      last = best;
    }
    return keep;
  }
}
