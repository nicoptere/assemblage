/**
 * A body's surface samples in a bounding-sphere tree (median splits on the longest axis, leaves
 * of at most `leafSize` samples). The narrowphase tests a node's sphere against the other body's
 * grid box and distance field and skips the whole subtree when the sphere is clear of the
 * surface: in a pile most candidate pairs have no sample near the other body, and a few node
 * tests replace hundreds of sample tests.
 *
 * Nodes are stored in depth-first order, so a subtree is a contiguous range and traversal is a
 * loop without a stack: from node i go to i + 1 to descend, or to skip[i] to pass its subtree.
 *   members   sample indices, ordered so every node owns members[from[i] .. to[i])
 *   centres   sphere centres, xyz per node, in the samples' frame
 *   radii     sphere radii
 *   skip      index of the node after i's subtree (skip[i] === i + 1 for a leaf)
 */
export class SampleTree {
  constructor(samples, leafSize = 12) {
    const count = samples.length / 3;
    const cap = 4 * Math.ceil(count / Math.max(1, leafSize)) + 1; // leaves hold > leafSize / 2
    this.members = Int32Array.from({ length: count }, (_, i) => i);
    this.from = new Int32Array(cap);
    this.to = new Int32Array(cap);
    this.skip = new Int32Array(cap);
    this.centres = new Float64Array(cap * 3);
    this.radii = new Float64Array(cap);
    this.count = 0;
    if (count > 0) this._build(samples, 0, count, Math.max(1, leafSize));
  }

  isLeaf(i) {
    return this.skip[i] === i + 1;
  }

  _build(samples, from, to, leafSize) {
    const i = this.count++;
    const { members } = this;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let m = from; m < to; m++) {
      for (let a = 0; a < 3; a++) {
        const v = samples[members[m] * 3 + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
    let r2 = 0;
    for (let m = from; m < to; m++) {
      const k = members[m] * 3;
      const dx = samples[k] - c[0], dy = samples[k + 1] - c[1], dz = samples[k + 2] - c[2];
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    this.centres.set(c, i * 3);
    this.radii[i] = Math.sqrt(r2);
    this.from[i] = from;
    this.to[i] = to;
    if (to - from > leafSize) {
      const extent = [0, 1, 2].map((a) => hi[a] - lo[a]);
      const axis = extent.indexOf(Math.max(...extent));
      members.subarray(from, to).sort((p, q) => samples[p * 3 + axis] - samples[q * 3 + axis]);
      const mid = (from + to) >> 1;
      this._build(samples, from, mid, leafSize);
      this._build(samples, mid, to, leafSize);
    }
    this.skip[i] = this.count;
  }
}
