import { MeshTopology } from './MeshTopology.js';
import { pocketOf } from './Pocket.js';
import { principalAxes } from './Pca.js';
import { PointGrid } from './PointGrid.js';

export const TRAP_DEFAULTS = Object.freeze({
  size: 0.25, // share of the mesh's size: only parts at least this long can be traps (small cups are left alone)...
  radius: 0.035, // ...a part that can hold a ball this big (share of the mesh's size) inside its hull...
  wrap: 0.33, // ...and surrounds it this much (share of the directions from its centre that meet the part) is a trap
  cells: 32, // its room is measured on a grid of this many cells across the part (and no finer than 1/200 of the mesh)
  pieces: 6, // a trap is split into at most this many pieces
  band: 0.15, // share of the part's span across the cut: the band in which the seam is free to follow a crease
  smooth: 6, // passes of majority smoothing along the seam
});

/**
 * Splits the parts that could trap others (a bowl, a shell with a hole in it, a gutter, a cup:
 * see pocketOf): parts at least `size` long that can hold a ball of `radius` they surround by
 * `wrap`, until none of their pieces can, or a trap is in `pieces` pieces. Each cut is a plane through the centre of the part's room, the one
 * of nine orientations (the part's principal axes and their diagonals) that leaves the smallest
 * room in its pieces (approximate convex decomposition's cuts, one level of look-ahead), then the
 * seam is let settle in the creases near the plane (MeshTopology.grow from the faces beyond a
 * band around it). Pieces under `minFaces` go back to the neighbour they share the most edges with.
 *   topo      MeshTopology; minFaces: the smallest piece a cut may leave
 */
export class TrapSplitter {
  constructor(topo, options = {}, minFaces = 24) {
    this.topo = topo;
    this.o = { ...TRAP_DEFAULTS, ...options };
    this.minFaces = minFaces;
    this.limit = this.o.radius * topo.size;
  }

  /** Splits the traps among the parts in `labels` (in place, new parts numbered after the others). Returns what it did. */
  run(labels) {
    const t0 = Date.now();
    const stats = { traps: 0, cuts: 0, left: 0 };
    let count = labels.reduce((m, l) => Math.max(m, l + 1), 0);
    const members = Array.from({ length: count }, () => []);
    labels.forEach((l, f) => { if (l >= 0) members[l].push(f); });
    const pocket = (faces, label) => this.pocket(faces, (g) => labels[g] === label);
    for (let l = 0; l < members.length; l++) {
      if (!members[l].length || this.shape(members[l]).extents[0] < this.o.size * this.topo.size) continue;
      const first = pocket(members[l], l);
      if (!this.traps(first)) continue;
      stats.traps++;
      // cut the piece with the most room, until none is a trap or there are enough pieces
      const pieces = [{ label: l, faces: members[l], pocket: first }];
      while (pieces.length < this.o.pieces) {
        const worst = pieces.filter((p) => this.traps(p.pocket)).sort((a, b) => b.pocket.radius - a.pocket.radius)[0];
        if (!worst) break;
        const parts = this.cut(worst);
        if (!parts) { // no cut leaves less room: left as it is
          worst.pocket = { radius: 0, wrap: 0, centre: null };
          stats.left++;
          continue;
        }
        stats.cuts++;
        pieces.splice(pieces.indexOf(worst), 1);
        parts.forEach((p, i) => {
          const label = i === 0 ? worst.label : count++;
          for (const f of p.faces) labels[f] = label;
          pieces.push({ ...p, label });
        });
      }
      if (pieces.some((p) => this.traps(p.pocket))) stats.left++;
    }
    stats.ms = Date.now() - t0;
    return stats;
  }

  traps(pocket) {
    return pocket.radius >= this.limit && pocket.wrap >= this.o.wrap;
  }

  /** The room in the part made of `faces` (inPart(g): whether face g is one of them), on a grid of `cells` across it; none when it is too thin to hold the ball anyway. */
  pocket(faces, inPart, cells = this.o.cells) {
    const { extents } = this.shape(faces);
    if (extents[2] < 2 * this.limit) return { radius: 0, wrap: 0, centre: null };
    const voxel = Math.max(extents[0] / cells, this.topo.size / 200);
    return pocketOf(this.topo, faces, inPart, voxel);
  }

  /** Principal axes of the faces' vertices and their extents along them. */
  shape(faces) {
    const { V, F } = this.topo;
    const pts = new Float64Array(9 * faces.length);
    faces.forEach((f, i) => {
      for (let c = 0; c < 3; c++) pts.set(V.subarray(3 * F[3 * f + c], 3 * F[3 * f + c] + 3), 9 * i + 3 * c);
    });
    const { axes } = principalAxes(pts);
    const extents = axes.map((a) => span(pts, a));
    return { axes, extents };
  }

  /**
   * The best plane cut of a piece through the centre of its room, its seam settled in the creases:
   * its pieces ({ faces, pocket }, biggest first), or null when no cut leaves less room in two
   * pieces or more.
   */
  cut({ faces, pocket }) {
    const { topo } = this;
    const { axes } = this.shape(faces);
    const C = topo.centroid;
    const at = pocket.centre;
    const side = (n) => (f) => n[0] * (C[3 * f] - at[0]) + n[1] * (C[3 * f + 1] - at[1]) + n[2] * (C[3 * f + 2] - at[2]);
    const candidates = [];
    for (const n of orientations(axes)) {
      const s = side(n);
      const halves = [faces.filter((f) => s(f) < 0), faces.filter((f) => s(f) >= 0)];
      const pieces = halves.flatMap((h) => this.components(h)).filter((p) => p.length >= this.minFaces);
      if (pieces.length < 2) continue; // crumbs off one piece: no cut
      // the room left: the most a piece that is still a trap keeps (on a coarser grid: only to rank the cuts)
      let room = 0;
      for (const p of pieces) {
        const mark = new Set(p);
        const left = this.pocket(p, (g) => mark.has(g), (3 * this.o.cells) / 4);
        if (this.traps(left)) room = Math.max(room, left.radius);
      }
      if (room < 0.95 * pocket.radius) candidates.push({ s, room, balance: Math.min(halves[0].length, halves[1].length) });
    }
    candidates.sort((a, b) => a.room - b.room || b.balance - a.balance);
    // the best that still makes pieces with less room once its seam has settled
    for (const { s } of candidates) {
      const parts = this.settle(faces, s);
      if (parts.length < 2) continue;
      const pieces = parts.sort((a, b) => b.length - a.length).map((p) => {
        const mark = new Set(p);
        return { faces: p, pocket: this.pocket(p, (g) => mark.has(g)) };
      });
      if (Math.max(...pieces.map((p) => (this.traps(p.pocket) ? p.pocket.radius : 0))) < 0.95 * pocket.radius) return pieces;
    }
    return null;
  }

  /**
   * The faces split by `s(f)` (signed distance to the cut): those beyond a band around the cut keep
   * their side, the band goes to whichever side grows into it first (along the surface, slowed by
   * creases), the seam smoothed; then pieces under `minFaces` go to a neighbour.
   */
  settle(faces, s) {
    const { topo } = this;
    let lo = Infinity, hi = -Infinity;
    for (const f of faces) {
      lo = Math.min(lo, s(f));
      hi = Math.max(hi, s(f));
    }
    const band = this.o.band * (hi - lo);
    const member = new Set(faces);
    const seeds = faces.filter((f) => Math.abs(s(f)) > band).map((f) => [f, s(f) < 0 ? 0 : 1]);
    const out = new Int32Array(topo.faceCount).fill(-1);
    if (seeds.some(([, l]) => l === 0) && seeds.some(([, l]) => l === 1)) topo.grow(seeds, out, (g) => member.has(g));
    for (const f of faces) if (out[f] < 0) out[f] = s(f) < 0 ? 0 : 1;
    this.smooth(faces, out);
    const halves = [faces.filter((f) => out[f] === 0), faces.filter((f) => out[f] === 1)];
    return this.absorbSmall(halves.flatMap((h) => this.components(h)));
  }

  /** Majority passes over the seam (as stage 3 of the segmentation): a face whose neighbours in the part agree on the other side goes there. */
  smooth(faces, out) {
    const { nbr } = this.topo;
    const member = new Set(faces);
    for (let pass = 0; pass < this.o.smooth; pass++) {
      let changed = 0;
      for (const f of faces) {
        let other = 0, total = 0;
        for (let k = 0; k < 3; k++) {
          const g = nbr[3 * f + k];
          if (g < 0 || !member.has(g)) continue;
          total++;
          if (out[g] !== out[f]) other++;
        }
        if (other >= 2 && other * 3 >= total * 2) {
          out[f] ^= 1;
          changed++;
        }
      }
      if (!changed) break;
    }
  }

  /** The connected pieces of `faces` (across edges, within the set). */
  components(faces) {
    const { topo } = this;
    const member = new Set(faces);
    const out = new Int32Array(topo.faceCount);
    const n = MeshTopology.flood(topo.faceCount, topo.nbr, out, { member: (f) => member.has(f) });
    const pieces = Array.from({ length: n }, () => []);
    for (const f of faces) pieces[out[f]].push(f);
    return pieces;
  }

  /**
   * Pieces under `minFaces` (bits that floated onto the part, or a cut's crumbs) joined to the
   * piece they share the most edges with, or else to the piece with the face nearest to them.
   */
  absorbSmall(pieces) {
    const { nbr, centroid: C } = this.topo;
    const big = pieces.filter((p) => p.length >= this.minFaces);
    if (!big.length) return [pieces.flat()];
    const owner = new Map();
    big.forEach((p, i) => { for (const f of p) owner.set(f, i); });
    const near = big.flat();
    const grid = new PointGrid(Float64Array.from(near.flatMap((f) => [C[3 * f], C[3 * f + 1], C[3 * f + 2]])), this.topo.size / 64);
    const out = big.map((p) => p.slice());
    for (const p of pieces.filter((q) => q.length < this.minFaces).sort((a, b) => a.length - b.length)) {
      const shared = new Map();
      for (const f of p) {
        for (let k = 0; k < 3; k++) {
          const j = owner.get(nbr[3 * f + k]);
          if (j !== undefined) shared.set(j, (shared.get(j) ?? 0) + 1);
        }
      }
      let into = [...shared].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (into === undefined) {
        const f = p[0];
        into = owner.get(near[grid.nearest(C[3 * f], C[3 * f + 1], C[3 * f + 2]).index]);
      }
      out[into].push(...p);
    }
    return out;
  }
}

/** The extent of points (xyz, flat) along unit direction `a`. */
function span(points, a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const d = a[0] * points[i] + a[1] * points[i + 1] + a[2] * points[i + 2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return hi - lo;
}

/** Nine cut orientations: the principal axes and the diagonals between each two. */
function orientations([a, b, c]) {
  const mix = (u, v, s) => u.map((x, k) => (x + s * v[k]) / Math.SQRT2);
  return [a, b, c, mix(a, b, 1), mix(a, b, -1), mix(a, c, 1), mix(a, c, -1), mix(b, c, 1), mix(b, c, -1)];
}
