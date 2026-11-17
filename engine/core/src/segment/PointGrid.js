/**
 * Points (xyz) hashed on a uniform grid of `cell`, for nearest-point and within-radius queries.
 * The grid covers the points' bounds; queries outside it clamp to its border cells.
 */
export class PointGrid {
  constructor(points, cell) {
    const n = Math.floor(points.length / 3);
    this.points = points;
    this.cell = cell;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 3 * n; i++) {
      lo[i % 3] = Math.min(lo[i % 3], points[i]);
      hi[i % 3] = Math.max(hi[i % 3], points[i]);
    }
    if (!n) lo.fill(0), hi.fill(0);
    this.lo = lo;
    this.dims = lo.map((l, a) => Math.max(1, Math.floor((hi[a] - l) / cell) + 1));
    const [nx, ny, nz] = this.dims;
    const cells = nx * ny * nz;
    // counting sort of the points by cell: start[c] .. start[c + 1] index `order`
    const of = new Int32Array(n);
    this.start = new Int32Array(cells + 1);
    for (let i = 0; i < n; i++) {
      of[i] = this._cell(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
      this.start[of[i] + 1]++;
    }
    for (let c = 0; c < cells; c++) this.start[c + 1] += this.start[c];
    this.order = new Int32Array(n);
    const fill = this.start.slice(0, cells);
    for (let i = 0; i < n; i++) this.order[fill[of[i]]++] = i;
    this.count = n;
  }

  _axis(v, a) {
    return Math.min(this.dims[a] - 1, Math.max(0, Math.floor((v - this.lo[a]) / this.cell)));
  }

  _cell(x, y, z) {
    return this._axis(x, 0) + this.dims[0] * (this._axis(y, 1) + this.dims[1] * this._axis(z, 2));
  }

  /** Calls `visit(i, d2)` for every point within `radius` of (x, y, z). */
  within(x, y, z, radius, visit) {
    const { points, order, start, dims } = this;
    const r2 = radius * radius;
    const i0 = this._axis(x - radius, 0), i1 = this._axis(x + radius, 0);
    const j0 = this._axis(y - radius, 1), j1 = this._axis(y + radius, 1);
    const k0 = this._axis(z - radius, 2), k1 = this._axis(z + radius, 2);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = i + dims[0] * (j + dims[1] * k);
      for (let s = start[c]; s < start[c + 1]; s++) {
        const p = order[s];
        const dx = points[3 * p] - x, dy = points[3 * p + 1] - y, dz = points[3 * p + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r2) visit(p, d2);
      }
    }
  }

  /**
   * The point nearest (x, y, z) among those `accept(index)` takes: { index, distance } (index -1
   * when there are none within `maxRadius`).
   */
  nearest(x, y, z, maxRadius = Infinity, accept = null) {
    let best = -1, bestD2 = Infinity;
    const span = Math.max(...this.dims.map((d) => d * this.cell));
    for (let r = this.cell; ; r *= 2) {
      this.within(x, y, z, Math.min(r, maxRadius), (i, d2) => {
        if (d2 < bestD2 && (!accept || accept(i))) { bestD2 = d2; best = i; }
      });
      if (best >= 0 || r >= maxRadius || r > 2 * span + this._outside(x, y, z)) break;
    }
    return { index: best, distance: Math.sqrt(bestD2) };
  }

  /** How far (x, y, z) is from the grid's box. */
  _outside(x, y, z) {
    let d2 = 0;
    [x, y, z].forEach((v, a) => {
      const hi = this.lo[a] + this.dims[a] * this.cell;
      const d = v < this.lo[a] ? this.lo[a] - v : v > hi ? v - hi : 0;
      d2 += d * d;
    });
    return Math.sqrt(d2);
  }
}
