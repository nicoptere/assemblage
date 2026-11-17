import { MeshTopology } from './MeshTopology.js';
import { MinHeap } from './MinHeap.js';
import { PointGrid } from './PointGrid.js';
import { eigen } from './Pca.js';
import { TrapSplitter } from './TrapSplitter.js';

const DEG = Math.PI / 180;

export const SEGMENT_DEFAULTS = Object.freeze({
  angle: 90, // deg: edges folded more than this split the surface (stage 1)
  maxShell: 0.085, // share of the faces: an island bigger is split further...
  refine: [45, 30, 20], // ...at the first of these angles that leaves no piece bigger...
  regions: 0.5, // ...else into crease-bounded regions of about this times maxShell
  minPart: 0.0032, // share of the faces: islands smaller are merged into a neighbour (stage 2)
  minFaces: 24, // and so are islands of fewer faces, whatever the share
  concave: 0.25, // weight of concave edges in the shared border that decides where they go
  probes: [0, 0.004, 0.01, 0.02], // share of the size: how deep a floating bit looks for the surface under it
  speckle: 15, // faces: a floating bit smaller...
  speckleGap: 0.06, // ...and farther than this share of the size from any part is dust, dropped (stage 3)
  smooth: 4, // passes of border majority smoothing (stage 3)
  maxParts: 96, // the smallest parts are merged into a neighbour until there are no more than this
  groups: null, // a group per face (a prior split, e.g. semantic parts): parts never cross or merge across groups
  traps: {}, // stage 4, TrapSplitter options (TRAP_DEFAULTS): parts that could trap others are cut; false: left whole
});

/**
 * Splits a mesh into parts along its creases: a half-edge dihedral pipeline, purely geometric,
 * in four stages:
 *   1. every edge folded more than `angle` is split and the faces are flood-filled into
 *      islands; an island holding more than `maxShell` of the mesh is split again at lower
 *      angles (`refine`), and if it is smooth all over (an organic shape), into regions grown
 *      from far-apart seeds whose borders settle in its creases;
 *   2. small islands (rivets, bolts, trims, bevels) join the big neighbour they share the most
 *      border with (concave grooves counting less); floating ones (separate shells) join the
 *      part under them: the nearest face of a big island to points probed inwards along their
 *      thinnest axis;
 *   3. floating dust is dropped, the borders are smoothed by majority (no one-face teeth), and
 *      the smallest parts merge until at most `maxParts` are left;
 *   4. parts that could trap others (bowls, shells with a hole, gutters, cups: a ball fits in
 *      their hull and they surround it) are cut until they cannot (TrapSplitter); this can leave
 *      more than `maxParts`.
 * Genuinely separate shells come out as their own islands from stage 1. With `groups` (a group
 * per face: semantic parts, say), a part never spans two groups: the groups' borders split like
 * creases, and islands merge, find the surface under them and smooth only within their group.
 * Returns labels per face (0 = the biggest part; -1 = dropped), the part count and what each
 * stage did.
 */
export class Segmenter {
  constructor(topology, options = {}) {
    this.topo = topology;
    this.o = { ...SEGMENT_DEFAULTS, ...options };
    const { groups } = this.o;
    // whether faces f and g may be in one part
    this.together = groups ? (f, g) => groups[f] === groups[g] : () => true;
  }

  run(report = () => {}) {
    const t0 = Date.now();
    const stats = {};
    const labels = this.split(stats);
    report(0.4);
    this.merge(labels, stats);
    report(0.7);
    this.heal(labels, stats);
    report(0.8);
    if (this.o.traps) {
      const min = Math.max(this.o.minFaces, this.o.minPart * this.topo.faceCount);
      stats.traps = new TrapSplitter(this.topo, this.o.traps, min).run(labels);
    }
    report(0.95);
    const count = Segmenter.compact(labels, this.topo.area);
    const sizes = new Int32Array(count);
    for (const l of labels) if (l >= 0) sizes[l]++;
    Object.assign(stats, { parts: count, largest: largest(sizes) / this.topo.faceCount, ms: Date.now() - t0 });
    report(1);
    return { labels, count, stats };
  }

  /** Stage 1: islands between the creases sharper than `angle`, the oversized ones split again. */
  split(stats) {
    const { topo, o } = this;
    const nf = topo.faceCount;
    const labels = new Int32Array(nf);
    // folds of exactly the angle (a CAD box's right angles at 90°) hold, whatever the rounding; groups' borders always split
    const below = (t) => (h) => topo.angle[h] <= (t + 0.5) * DEG && this.together((h / 3) | 0, topo.nbr[h]);
    let count = MeshTopology.flood(nf, topo.nbr, labels, { open: below(o.angle) });
    stats.islands = count;
    const limit = o.maxShell * nf;
    const sizes = Segmenter.sizes(labels, count);
    const sub = new Int32Array(nf);
    stats.refined = 0;
    stats.regions = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i] <= limit) continue;
      const member = (f) => labels[f] === i;
      let done = false;
      for (const t of o.refine) {
        const n = MeshTopology.flood(nf, topo.nbr, sub, { open: below(t), member });
        if (n < 2 || largest(Segmenter.sizes(sub, n)) > limit) continue;
        for (let f = 0; f < nf; f++) if (sub[f] > 0) labels[f] = count + sub[f] - 1; // piece 0 keeps the label
        count += n - 1;
        stats.refined++;
        done = true;
        break;
      }
      if (done) continue;
      const k = Math.ceil(sizes[i] / (o.regions * limit));
      const n = this.regions(labels, i, k, sub);
      for (let f = 0; f < nf; f++) if (labels[f] === i && sub[f] > 0) labels[f] = count + sub[f] - 1;
      count += n - 1;
      stats.regions += n;
    }
    return labels;
  }

  /**
   * Splits island `i` into `k` regions: seeds spread by farthest-point sampling, faces taken by
   * the nearest seed along the surface, crossing a fold costing more the sharper it is (concave
   * twice as much): fronts slow down at creases, so the borders settle in them. Writes the region
   * of each of its faces into `out` (0..k-1) and returns how many there are.
   */
  regions(labels, i, k, out) {
    const { centroid: C, faceCount: nf } = this.topo;
    const faces = [];
    for (let f = 0; f < nf; f++) if (labels[f] === i) faces.push(f);
    const d2 = (f, g) => (C[3 * f] - C[3 * g]) ** 2 + (C[3 * f + 1] - C[3 * g + 1]) ** 2 + (C[3 * f + 2] - C[3 * g + 2]) ** 2;
    // farthest-point seeds, from the face farthest from the island's first face
    const near = new Float64Array(faces.length).fill(Infinity);
    const seeds = [];
    let next = faces.reduce((best, f) => (d2(f, faces[0]) > d2(best, faces[0]) ? f : best), faces[0]);
    for (let s = 0; s < Math.min(k, faces.length); s++) {
      seeds.push(next);
      let far = -1;
      faces.forEach((f, j) => {
        near[j] = Math.min(near[j], d2(f, next));
        if (far < 0 || near[j] > near[far]) far = j;
      });
      next = faces[far];
    }
    this.topo.grow(seeds.map((f, s) => [f, s]), out, (g) => labels[g] === i);
    for (const f of faces) if (out[f] < 0) out[f] = 0; // unreachable from any seed (cannot happen in one island)
    return seeds.length;
  }

  /** Stage 2: small islands into the big neighbour they share the most border with; floating ones by probing. */
  merge(labels, stats) {
    const { topo, o } = this;
    const nf = topo.faceCount;
    const min = Math.max(o.minFaces, o.minPart * nf);
    const graph = new IslandGraph(topo, labels, o.concave, this.together);
    stats.merged = graph.absorb((a) => graph.size[a] < min, (b) => graph.size[b] >= min);
    // floating small islands: onto the face of a big island nearest to a probe going inwards
    const floating = graph.roots().filter((a) => graph.size[a] < min);
    const big = [];
    for (let f = 0; f < nf; f++) if (graph.size[graph.find(labels[f])] >= min) big.push(f);
    stats.floating = 0;
    stats.speckles = 0;
    if (big.length && floating.length) {
      const points = new Float64Array(3 * big.length);
      big.forEach((f, j) => points.set(topo.centroid.subarray(3 * f, 3 * f + 3), 3 * j));
      const grid = new PointGrid(points, topo.size / 64);
      const members = graph.members(labels);
      for (const a of floating) {
        const { centre, inward } = Segmenter.frame(topo, members.get(a));
        let best = { index: -1, distance: Infinity };
        const own = members.get(a)[0];
        const accept = (j) => this.together(own, big[j]);
        for (const t of o.probes) {
          const s = t * topo.size;
          const hit = grid.nearest(centre[0] + s * inward[0], centre[1] + s * inward[1], centre[2] + s * inward[2], Infinity, accept);
          if (hit.distance < best.distance) best = hit;
        }
        if (best.index < 0) continue;
        if (graph.size[a] < o.speckle && best.distance > o.speckleGap * topo.size) {
          graph.drop(a);
          stats.speckles++;
          continue;
        }
        graph.join(a, graph.find(labels[big[best.index]]));
        stats.floating++;
      }
    }
    graph.apply(labels);
  }

  /** Stage 3: one-face teeth smoothed away, then the smallest parts merged down to `maxParts`. */
  heal(labels, stats) {
    const { topo, o } = this;
    const { nbr, faceCount: nf } = topo;
    let changed = 0;
    const prev = new Int32Array(nf);
    for (let pass = 0; pass < o.smooth; pass++) {
      prev.set(labels);
      for (let f = 0; f < nf; f++) {
        if (prev[f] < 0) continue;
        const across = (k) => {
          const g = nbr[3 * f + k];
          return g >= 0 && this.together(f, g) ? prev[g] : -1;
        };
        const a = across(0), b = across(1), c = across(2);
        const l = a >= 0 && (a === b || a === c) ? a : b >= 0 && b === c ? b : -1;
        if (l >= 0 && l !== prev[f]) {
          labels[f] = l;
          changed++;
        }
      }
    }
    stats.smoothed = changed;
    const graph = new IslandGraph(topo, labels, o.concave, this.together);
    let count = graph.roots().length;
    stats.limited = 0;
    if (count > o.maxParts) {
      stats.limited = graph.absorb(() => true, () => true, () => graph.roots().length > o.maxParts, true);
      // what has no neighbour left joins the nearest part
      const centres = (a, members) => Segmenter.frame(topo, members.get(a)).centre;
      for (;;) {
        const roots = graph.roots();
        if (roots.length <= o.maxParts) break;
        const members = graph.members(labels);
        roots.sort((a, b) => graph.size[a] - graph.size[b]);
        const a = roots[0];
        const c = centres(a, members);
        let best = -1, bestD = Infinity;
        for (const b of roots.slice(1)) {
          if (!this.together(members.get(a)[0], members.get(b)[0])) continue;
          const d = Math.hypot(...centres(b, members).map((v, k) => v - c[k]));
          if (d < bestD) { bestD = d; best = b; }
        }
        if (best < 0) break; // alone in its group: more parts than asked
        graph.join(a, best);
        graph.apply(labels);
        stats.limited++;
      }
    }
    graph.apply(labels);
  }

  /**
   * Where a bit sits and which way is into the surface under it: its area-weighted centre, and
   * its thinnest axis (PCA of its face centres) turned against its mean normal (towards the
   * mesh's centre when the normals cancel out, as on a closed rivet).
   */
  static frame(topo, faces) {
    const { centroid: C, normal: N, area: A } = topo;
    let w = 0;
    const c = [0, 0, 0], n = [0, 0, 0];
    for (const f of faces) {
      const a = A[f] || 1e-12;
      w += a;
      for (let k = 0; k < 3; k++) {
        c[k] += a * C[3 * f + k];
        n[k] += a * N[3 * f + k];
      }
    }
    for (let k = 0; k < 3; k++) c[k] /= w;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const f of faces) {
      const a = A[f] || 1e-12;
      const d = [C[3 * f] - c[0], C[3 * f + 1] - c[1], C[3 * f + 2] - c[2]];
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[3 * r + s] += (a * d[r] * d[s]) / w;
    }
    const axis = eigen(cov).axes[2]; // the thinnest
    const nl = Math.hypot(...n);
    let toward = n.map((v) => v / (nl || 1));
    if (nl < 0.3 * w) {
      const { lo, hi } = topo.bounds;
      toward = c.map((v, k) => v - (lo[k] + hi[k]) / 2); // outwards from the mesh's centre
    }
    const s = axis[0] * toward[0] + axis[1] * toward[1] + axis[2] * toward[2] > 0 ? -1 : 1;
    return { centre: c, inward: axis.map((v) => s * v) };
  }

  static sizes(labels, count) {
    const sizes = new Int32Array(count);
    for (const l of labels) if (l >= 0) sizes[l]++;
    return sizes;
  }

  /** Renumbers the labels 0..n-1, the biggest part (by area) first; returns n. */
  static compact(labels, area) {
    const total = new Map();
    labels.forEach((l, f) => { if (l >= 0) total.set(l, (total.get(l) ?? 0) + area[f]); });
    const order = [...total.keys()].sort((a, b) => total.get(b) - total.get(a));
    const map = new Map(order.map((l, i) => [l, i]));
    for (let f = 0; f < labels.length; f++) if (labels[f] >= 0) labels[f] = map.get(labels[f]);
    return order.length;
  }
}

/**
 * Islands as a graph, merged with a union-find: their sizes (faces) and, per pair of
 * neighbours, the border they share (edge length; concave edges weighted by `concave`).
 */
class IslandGraph {
  constructor(topo, labels, concave = SEGMENT_DEFAULTS.concave, together = () => true) {
    const n = labels.reduce((m, l) => Math.max(m, l + 1), 0);
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.size = new Float64Array(n);
    this.dropped = new Uint8Array(n);
    this.adj = Array.from({ length: n }, () => new Map());
    const { nbr, concave: cv, faceCount: nf } = topo;
    for (let f = 0; f < nf; f++) {
      const a = labels[f];
      if (a < 0) continue;
      this.size[a]++;
      for (let k = 0; k < 3; k++) {
        const h = 3 * f + k;
        const g = nbr[h];
        if (g <= f) continue; // each edge once
        const b = labels[g];
        if (b < 0 || b === a || !together(f, g)) continue;
        const w = topo.edgeLength(h) * (cv[h] ? concave : 1);
        this.adj[a].set(b, (this.adj[a].get(b) ?? 0) + w);
        this.adj[b].set(a, (this.adj[b].get(a) ?? 0) + w);
      }
    }
    for (let a = 0; a < n; a++) if (!this.size[a]) this.dropped[a] = 1; // labels no face has
  }

  find(a) {
    while (this.parent[a] !== a) a = this.parent[a] = this.parent[this.parent[a]];
    return a;
  }

  roots() {
    const out = [];
    for (let a = 0; a < this.parent.length; a++) if (this.parent[a] === a && !this.dropped[a]) out.push(a);
    return out;
  }

  /** Merges `a` into `b`: sizes and borders summed. */
  join(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return;
    this.parent[a] = b;
    this.size[b] += this.size[a];
    for (const [n, w] of this.adj[a]) {
      this.adj[n].delete(a);
      if (n === b) continue;
      this.adj[b].set(n, (this.adj[b].get(n) ?? 0) + w);
      this.adj[n].set(b, (this.adj[n].get(b) ?? 0) + w);
    }
    this.adj[b].delete(a);
    this.adj[a] = new Map();
  }

  drop(a) {
    a = this.find(a);
    this.dropped[a] = 1;
    for (const n of this.adj[a].keys()) this.adj[n].delete(a);
    this.adj[a] = new Map();
  }

  /**
   * Smallest first, every island `small(a)` accepts joins the neighbour it shares the most
   * border with, among those `big(b)` accepts if any (else among all, unless `strict`), while
   * `more()` says to go on. Returns how many joined.
   */
  absorb(small, big, more = () => true, strict = false) {
    const heap = new MinHeap();
    for (const a of this.roots()) if (small(a)) heap.push(this.size[a], a);
    let joined = 0;
    while (heap.size && more()) {
      const key = heap.top;
      const a = heap.pop();
      if (this.find(a) !== a || this.dropped[a] || key !== this.size[a] || !small(a)) continue;
      let best = -1, bestW = -1, any = -1, anyW = -1;
      for (const [b, w] of this.adj[a]) {
        if (big(b) && w > bestW) { best = b; bestW = w; }
        if (w > anyW) { any = b; anyW = w; }
      }
      const into = best >= 0 ? best : strict ? -1 : any;
      if (into < 0) continue; // floating: left for the caller
      this.join(a, into);
      joined++;
      if (small(into)) heap.push(this.size[into], into);
    }
    return joined;
  }

  /** Face lists of the roots: root -> [faces]. */
  members(labels) {
    const out = new Map();
    labels.forEach((l, f) => {
      if (l < 0) return;
      const r = this.find(l);
      if (!out.has(r)) out.set(r, []);
      out.get(r).push(f);
    });
    return out;
  }

  /** Writes the merged labels back (dropped islands: -1). */
  apply(labels) {
    for (let f = 0; f < labels.length; f++) {
      if (labels[f] < 0) continue;
      const r = this.find(labels[f]);
      labels[f] = this.dropped[r] ? -1 : r;
    }
  }
}

const largest = (a) => a.reduce((m, v) => Math.max(m, v), 0);
