import { MinHeap } from './MinHeap.js';

/**
 * A triangle soup as a surface the segmentation can walk: coincident vertices welded, faces
 * oriented consistently across their shared edges (each connected shell then turned outwards,
 * by its signed volume), and per face its neighbours, normal, centroid and area, and per edge
 * the dihedral angle between the two faces' normals and whether the fold is concave.
 *   positions  xyz per vertex (any array), in the mesh's units
 *   indices    3 vertex indices per triangle
 * Face f keeps its index. Its edge k runs from F[3f + k] to F[3f + (k + 1) % 3]; nbr[3f + k] is
 * the face across it, or -1 where it is a border or is shared by more than two faces.
 */
export class MeshTopology {
  constructor(positions, indices, { epsilon = 1e-6 } = {}) {
    const nf = Math.floor(indices.length / 3);
    this.faceCount = nf;
    const { V, remap } = MeshTopology.weld(positions, epsilon);
    this.V = V;
    this.vertexCount = V.length / 3;
    const F = new Int32Array(3 * nf);
    for (let i = 0; i < 3 * nf; i++) F[i] = remap[indices[i]];
    this.F = F;
    this._geometry();
    this.nbr = this._pair(); // whichever way the faces are wound
    this.flipped = this._orient();
    this.shell = new Int32Array(nf);
    this.shells = MeshTopology.flood(nf, this.nbr, this.shell);
    this._outwards();
    this._angles();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], V[i]);
      hi[i % 3] = Math.max(hi[i % 3], V[i]);
    }
    this.bounds = { lo, hi };
    this.size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  }

  /**
   * Vertices closer than `epsilon` (relative to the mesh's size) become one: sorted on a grid of
   * that step. Returns { V: the welded positions, remap: welded index per input vertex }.
   */
  static weld(P, epsilon = 1e-6) {
    const n = Math.floor(P.length / 3);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 3 * n; i++) {
      lo = Math.min(lo, P[i]);
      hi = Math.max(hi, P[i]);
    }
    const step = Math.max(epsilon * (hi - lo), 1e-30);
    const key = new Float64Array(3 * n);
    for (let i = 0; i < 3 * n; i++) key[i] = Math.round((P[i] - lo) / step);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => key[3 * a] - key[3 * b] || key[3 * a + 1] - key[3 * b + 1] || key[3 * a + 2] - key[3 * b + 2]);
    const remap = new Int32Array(n);
    const out = [];
    for (let r = 0; r < n; r++) {
      const v = order[r];
      const u = r > 0 ? order[r - 1] : -1;
      if (u >= 0 && key[3 * u] === key[3 * v] && key[3 * u + 1] === key[3 * v + 1] && key[3 * u + 2] === key[3 * v + 2]) {
        remap[v] = remap[u];
        continue;
      }
      remap[v] = out.length / 3;
      out.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    }
    return { V: Float64Array.from(out), remap };
  }

  /** Normals, centroids and areas of the faces (degenerate faces: zero area, normal +Y). */
  _geometry() {
    const { V, F, faceCount: nf } = this;
    this.normal = new Float64Array(3 * nf);
    this.centroid = new Float64Array(3 * nf);
    this.area = new Float64Array(nf);
    for (let f = 0; f < nf; f++) {
      const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      this.area[f] = l / 2;
      if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
      this.normal.set([nx, ny, nz], 3 * f);
      this.centroid.set([(V[a] + V[b] + V[c]) / 3, (V[a + 1] + V[b + 1] + V[c + 1]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3], 3 * f);
    }
  }

  /** The face across every edge: edges shared by exactly two faces (whichever way they run), else -1. */
  _pair() {
    const { F, faceCount: nf, vertexCount: nv } = this;
    const nbr = new Int32Array(3 * nf).fill(-1);
    const first = new Map(); // edge key -> first half-edge, or -1 once shared by more than two
    for (let h = 0; h < 3 * nf; h++) {
      const f = (h / 3) | 0;
      const a = F[h], b = F[3 * f + ((h % 3) + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      const g = first.get(key);
      if (g === undefined) first.set(key, h);
      else if (g >= 0 && nbr[g] < 0) {
        const fg = (g / 3) | 0;
        if (fg === f) continue;
        nbr[g] = f;
        nbr[h] = fg;
      } else if (g >= 0) {
        // a third face on that edge: none of them are neighbours there
        nbr[nbr[g] * 3 + this._edgeOf(nbr[g], a, b)] = -1;
        nbr[g] = -1;
        first.set(key, -1);
      }
    }
    return nbr;
  }

  /** Which edge of face f joins vertices a and b (either way). */
  _edgeOf(f, a, b) {
    const F = this.F;
    for (let k = 0; k < 3; k++) {
      const p = F[3 * f + k], q = F[3 * f + ((k + 1) % 3)];
      if ((p === a && q === b) || (p === b && q === a)) return k;
    }
    return 0;
  }

  /**
   * Flips faces so that neighbours run their shared edge opposite ways (breadth first from each
   * shell's first face; a shell that cannot be oriented keeps its first choice). Returns the flips.
   */
  _orient() {
    const { F, nbr, faceCount: nf } = this;
    const flipped = new Uint8Array(nf);
    const seen = new Uint8Array(nf);
    const queue = new Int32Array(nf);
    for (let s = 0; s < nf; s++) {
      if (seen[s]) continue;
      seen[s] = 1;
      let head = 0, tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const f = queue[head++];
        for (let k = 0; k < 3; k++) {
          const g = nbr[3 * f + k];
          if (g < 0 || seen[g]) continue;
          const a = F[3 * f + k], b = F[3 * f + ((k + 1) % 3)];
          const j = this._edgeOf(g, a, b);
          if (F[3 * g + j] === a) MeshTopology._flip(this, g, flipped); // runs the same way: turn it
          seen[g] = 1;
          queue[tail++] = g;
        }
      }
    }
    return flipped;
  }

  /** Turns face f over: its last two corners swapped, so edges 0 and 2 trade places (and their neighbours with them). */
  static _flip(topo, f, flipped) {
    const { F, nbr } = topo;
    const t = F[3 * f + 1];
    F[3 * f + 1] = F[3 * f + 2];
    F[3 * f + 2] = t;
    const n = nbr[3 * f];
    nbr[3 * f] = nbr[3 * f + 2];
    nbr[3 * f + 2] = n;
    for (let i = 0; i < 3; i++) topo.normal[3 * f + i] = -topo.normal[3 * f + i];
    flipped[f] ^= 1;
  }

  /** Turns every shell whose signed volume is negative inside out, so normals point away from the solid. */
  _outwards() {
    const { V, F, faceCount: nf } = this;
    const volume = new Float64Array(this.shells);
    for (let f = 0; f < nf; f++) {
      const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
      volume[this.shell[f]] += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
    }
    for (let f = 0; f < nf; f++) if (volume[this.shell[f]] < 0) MeshTopology._flip(this, f, this.flipped);
  }

  /** Dihedral angle (radians, 0 where there is no neighbour) and concavity of every edge. */
  _angles() {
    const { nbr, normal: N, centroid: C, faceCount: nf } = this;
    this.angle = new Float32Array(3 * nf);
    this.concave = new Uint8Array(3 * nf);
    for (let h = 0; h < 3 * nf; h++) {
      const g = nbr[h];
      if (g < 0) continue;
      const f = (h / 3) | 0;
      const d = N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2];
      this.angle[h] = Math.acos(Math.max(-1, Math.min(1, d)));
      // concave: the other face rises above this one's plane (the surface folds towards its normal)
      const up = (C[3 * g] - C[3 * f]) * N[3 * f] + (C[3 * g + 1] - C[3 * f + 1]) * N[3 * f + 1] + (C[3 * g + 2] - C[3 * f + 2]) * N[3 * f + 2];
      this.concave[h] = up > 0 ? 1 : 0;
    }
  }

  /**
   * Connected sets of faces, crossing only the edges `open(h)` allows (default: every edge with a
   * neighbour), among the faces `member(f)` accepts; writes each face's set into `out` (-1 for the
   * others) and returns how many there are.
   */
  static flood(nf, nbr, out, { open = null, member = null } = {}) {
    out.fill(-1);
    const queue = new Int32Array(nf);
    let count = 0;
    for (let s = 0; s < nf; s++) {
      if (out[s] >= 0 || (member && !member(s))) continue;
      out[s] = count;
      let head = 0, tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const f = queue[head++];
        for (let k = 0; k < 3; k++) {
          const h = 3 * f + k;
          const g = nbr[h];
          if (g < 0 || out[g] >= 0 || (open && !open(h)) || (member && !member(g))) continue;
          out[g] = count;
          queue[tail++] = g;
        }
      }
      count++;
    }
    return count;
  }

  /**
   * Faces taken by their nearest seed along the surface (multi-source Dijkstra over the face
   * graph), crossing a fold costing more the sharper it is (concave twice as much): fronts slow
   * down at creases, so the borders between the seeds' regions settle in them.
   *   seeds   [face, label] pairs
   *   out     label per face, written for the faces reached (the others -1)
   *   member  which faces may be taken (default: all)
   */
  grow(seeds, out, member = () => true) {
    const { nbr, centroid: C, angle, concave, faceCount: nf } = this;
    const dist = new Float64Array(nf).fill(Infinity);
    out.fill(-1);
    const heap = new MinHeap();
    for (const [f, label] of seeds) {
      dist[f] = 0;
      out[f] = label;
      heap.push(0, f);
    }
    while (heap.size) {
      const key = heap.top;
      const f = heap.pop();
      if (key > dist[f]) continue;
      for (let e = 0; e < 3; e++) {
        const h = 3 * f + e;
        const g = nbr[h];
        if (g < 0 || !member(g)) continue;
        const fold = 1 + ((8 * angle[h]) / Math.PI) * (concave[h] ? 1 : 0.5);
        const d = key + Math.hypot(C[3 * f] - C[3 * g], C[3 * f + 1] - C[3 * g + 1], C[3 * f + 2] - C[3 * g + 2]) * fold;
        if (d < dist[g]) {
          dist[g] = d;
          out[g] = out[f];
          heap.push(d, g);
        }
      }
    }
    return out;
  }

  /** Length of edge h. */
  edgeLength(h) {
    const f = (h / 3) | 0;
    const a = 3 * this.F[h], b = 3 * this.F[3 * f + ((h % 3) + 1) % 3];
    const V = this.V;
    return Math.hypot(V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]);
  }
}
