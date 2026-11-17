/**
 * The convex hull of a point set (quickhull: Barber, Dobkin & Huhdanpaa 1996), as outward planes
 * for inside tests. A set with no volume (every point on one plane, line or point, within
 * `tolerance`) has no faces and contains nothing: `flat`.
 *   points      xyz, flat
 *   tolerance   how far past a face a point must be to count as outside it (default: 1e-9 of the
 *               set's size)
 * `faces` holds the hull's triangles (point indices, wound outwards), `planes` per face its unit
 * normal and offset (n·p = d on it, n·p > d outside).
 */
export class ConvexHull {
  constructor(points, tolerance = null) {
    this.points = points;
    const n = Math.floor(points.length / 3);
    const extremes = this._extremes(n);
    this.tolerance = tolerance ?? 1e-9 * Math.max(1e-12, extremes.size);
    this.faces = [];
    this.planes = new Float64Array(0);
    this.flat = true;
    const tetra = n >= 4 ? this._tetrahedron(extremes) : null;
    if (!tetra) return;
    this.flat = false;
    this._build(n, tetra);
  }

  /** Whether (x, y, z) is within the hull, `margin` inside every face (a negative margin lets points past it count). */
  contains(x, y, z, margin = 0) {
    const P = this.planes;
    if (!P.length) return false;
    for (let i = 0; i < P.length; i += 4) if (P[i] * x + P[i + 1] * y + P[i + 2] * z - P[i + 3] > -margin) return false;
    return true;
  }

  /** The hull's volume. */
  get volume() {
    const p = this.points;
    let v = 0;
    for (const [a, b, c] of this.faces) {
      const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
      const bx = p[3 * b], by = p[3 * b + 1], bz = p[3 * b + 2];
      const cx = p[3 * c], cy = p[3 * c + 1], cz = p[3 * c + 2];
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return v / 6;
  }

  _extremes(n) {
    const p = this.points;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let i = 1; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        if (p[3 * i + a] < p[3 * lo[a] + a]) lo[a] = i;
        if (p[3 * i + a] > p[3 * hi[a] + a]) hi[a] = i;
      }
    }
    const size = n ? Math.max(...[0, 1, 2].map((a) => p[3 * hi[a] + a] - p[3 * lo[a] + a])) : 0;
    return { lo, hi, size };
  }

  /** Four points spanning a volume: the farthest pair of extremes, the farthest from their line, the farthest from their plane. */
  _tetrahedron({ lo, hi }) {
    const p = this.points;
    const tol = this.tolerance;
    let i0 = lo[0], i1 = hi[0], best = -1;
    for (let a = 0; a < 3; a++) {
      const d = this._d2(lo[a], hi[a]);
      if (d > best) { best = d; i0 = lo[a]; i1 = hi[a]; }
    }
    if (Math.sqrt(best) <= tol) return null;
    const n = p.length / 3;
    const ux = p[3 * i1] - p[3 * i0], uy = p[3 * i1 + 1] - p[3 * i0 + 1], uz = p[3 * i1 + 2] - p[3 * i0 + 2];
    const ul = Math.hypot(ux, uy, uz);
    let i2 = -1;
    best = tol;
    for (let i = 0; i < n; i++) {
      const vx = p[3 * i] - p[3 * i0], vy = p[3 * i + 1] - p[3 * i0 + 1], vz = p[3 * i + 2] - p[3 * i0 + 2];
      const d = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / ul;
      if (d > best) { best = d; i2 = i; }
    }
    if (i2 < 0) return null;
    const [nx, ny, nz, d0] = this._plane(i0, i1, i2);
    let i3 = -1;
    best = tol;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(nx * p[3 * i] + ny * p[3 * i + 1] + nz * p[3 * i + 2] - d0);
      if (d > best) { best = d; i3 = i; }
    }
    return i3 < 0 ? null : [i0, i1, i2, i3];
  }

  _d2(a, b) {
    const p = this.points;
    return (p[3 * a] - p[3 * b]) ** 2 + (p[3 * a + 1] - p[3 * b + 1]) ** 2 + (p[3 * a + 2] - p[3 * b + 2]) ** 2;
  }

  /** Unit normal and offset of the plane through points a, b, c (normal along ab x ac). */
  _plane(a, b, c) {
    const p = this.points;
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    return [nx, ny, nz, nx * p[3 * a] + ny * p[3 * a + 1] + nz * p[3 * a + 2]];
  }

  _build(n, [i0, i1, i2, i3]) {
    const p = this.points;
    const tol = this.tolerance;
    const faces = []; // { v: [a, b, c], plane, outside: [point], alive }
    const edges = new Map(); // directed edge a -> b: the face that has it
    const key = (a, b) => a * n + b;
    const height = (f, i) => f.plane[0] * p[3 * i] + f.plane[1] * p[3 * i + 1] + f.plane[2] * p[3 * i + 2] - f.plane[3];
    const make = (a, b, c) => {
      const f = { v: [a, b, c], plane: this._plane(a, b, c), outside: [], alive: true };
      faces.push(f);
      edges.set(key(a, b), f);
      edges.set(key(b, c), f);
      edges.set(key(c, a), f);
      return f;
    };
    // the tetrahedron, each face wound away from the fourth point
    const tet = [[i0, i1, i2, i3], [i0, i3, i1, i2], [i1, i3, i2, i0], [i2, i3, i0, i1]];
    const flip = height({ plane: this._plane(i0, i1, i2) }, i3) > 0;
    for (const [a, b, c] of tet) (flip ? make(a, c, b) : make(a, b, c));
    // every other point goes to the face it is farthest above
    const assign = (i, among) => {
      let best = null, bestH = tol;
      for (const f of among) {
        const h = height(f, i);
        if (h > bestH) { best = f; bestH = h; }
      }
      if (best) best.outside.push(i);
    };
    const corners = new Set([i0, i1, i2, i3]);
    const first = faces.slice();
    for (let i = 0; i < n; i++) if (!corners.has(i)) assign(i, first);
    // grow towards the farthest outside point of a face until no face has any
    const pending = first.slice();
    while (pending.length) {
      const face = pending.pop();
      if (!face.alive || !face.outside.length) continue;
      let eye = face.outside[0], eyeH = -Infinity;
      for (const i of face.outside) {
        const h = height(face, i);
        if (h > eyeH) { eyeH = h; eye = i; }
      }
      // the faces the eye sees, connected to this one, and the horizon around them
      const visible = new Set([face]);
      const stack = [face];
      while (stack.length) {
        const f = stack.pop();
        for (let e = 0; e < 3; e++) {
          const g = edges.get(key(f.v[(e + 1) % 3], f.v[e]));
          if (g && g.alive && !visible.has(g) && height(g, eye) > tol) {
            visible.add(g);
            stack.push(g);
          }
        }
      }
      const horizon = [];
      const orphans = [];
      for (const f of visible) {
        for (let e = 0; e < 3; e++) {
          const a = f.v[e], b = f.v[(e + 1) % 3];
          if (!visible.has(edges.get(key(b, a)))) horizon.push([a, b]);
        }
        for (const i of f.outside) if (i !== eye) orphans.push(i);
      }
      for (const f of visible) {
        f.alive = false;
        for (let e = 0; e < 3; e++) {
          const k = key(f.v[e], f.v[(e + 1) % 3]);
          if (edges.get(k) === f) edges.delete(k);
        }
      }
      const fresh = horizon.map(([a, b]) => make(a, b, eye));
      for (const i of orphans) assign(i, fresh);
      for (const f of fresh) if (f.outside.length) pending.push(f);
    }
    const live = faces.filter((f) => f.alive);
    this.faces = live.map((f) => f.v);
    this.planes = new Float64Array(4 * live.length);
    live.forEach((f, i) => this.planes.set(f.plane, 4 * i));
  }
}
