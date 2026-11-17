import { edt2 } from '../fit/brickpack/field.js';

/**
 * The signed distance of a closed triangle surface on a regular grid of spacing `voxel`, as the
 * engine's SdfGridShape reads it (node (i, j, k) at origin + (i, j, k) * voxel, index
 * i + nx * (j + ny * k), x fastest), robust to faces wound either way and to self-intersections:
 *   distance  exact (closest point on the nearest triangle) within `band` voxels of the surface;
 *             farther, a lower bound from the distance transform of the nodes nearest it
 *   sign      outside is what the grid border reaches without coming within half a voxel of the
 *             surface (a flood fill: no edge between two nodes crosses the surface unseen);
 *             the rest is inside, nodes in that half-voxel wall on the side they touch
 *   solid     grown by `grow` (default half a voxel), so that a plate thinner than a voxel
 *             still has some thickness
 * `tris`: 9 coordinates per triangle. Returns { origin, dims, voxel, phi (Float32Array, metres) }.
 */
export function bakeSdf(tris, { voxel, pad = 3, band = 2, grow = 0.5 * voxel } = {}) {
  const h = voxel;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], tris[i]);
    hi[i % 3] = Math.max(hi[i % 3], tris[i]);
  }
  const origin = lo.map((l) => l - pad * h);
  const dims = lo.map((l, a) => Math.ceil((hi[a] - l) / h) + 1 + 2 * pad);
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const d2 = new Float32Array(N).fill(Infinity);
  const reach = band * h;
  for (let t = 0; t < tris.length; t += 9) {
    const i0 = Math.max(0, Math.floor((Math.min(tris[t], tris[t + 3], tris[t + 6]) - reach - origin[0]) / h));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(tris[t], tris[t + 3], tris[t + 6]) + reach - origin[0]) / h));
    const j0 = Math.max(0, Math.floor((Math.min(tris[t + 1], tris[t + 4], tris[t + 7]) - reach - origin[1]) / h));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(tris[t + 1], tris[t + 4], tris[t + 7]) + reach - origin[1]) / h));
    const k0 = Math.max(0, Math.floor((Math.min(tris[t + 2], tris[t + 5], tris[t + 8]) - reach - origin[2]) / h));
    const k1 = Math.min(nz - 1, Math.ceil((Math.max(tris[t + 2], tris[t + 5], tris[t + 8]) + reach - origin[2]) / h));
    const tri = new Triangle(tris, t);
    for (let k = k0; k <= k1; k++) {
      const z = origin[2] + k * h;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + j * h;
        let n = i0 + nx * (j + ny * k);
        for (let i = i0; i <= i1; i++, n++) {
          const q = tri.distance2(origin[0] + i * h, y, z);
          if (q < d2[n]) d2[n] = q;
        }
      }
    }
  }
  const d = new Float32Array(N);
  let far = false;
  for (let n = 0; n < N; n++) {
    d[n] = Math.sqrt(d2[n]);
    if (d2[n] > reach * reach) far = true;
  }
  if (far) {
    // every surface point is within sqrt(3)/2 voxel of a node nearer than that: from those nodes, the
    // distance transform less that much is a lower bound of the true distance
    const corner = 0.8661 * h;
    const seed = new Uint8Array(N);
    for (let n = 0; n < N; n++) seed[n] = d[n] <= corner ? 1 : 0;
    const e2 = edt2(seed, nx, nz, ny); // edt2 indexes (y * nz + z) * nx + x: ours with y and z swapped
    for (let n = 0; n < N; n++) if (!(d[n] <= reach)) d[n] = Math.max(reach, Math.sqrt(e2[n]) * h - corner);
  }
  const side = outside(d, dims, 0.5 * h);
  const phi = new Float32Array(N);
  for (let n = 0; n < N; n++) phi[n] = (side[n] === OUT ? d[n] : -d[n]) - grow;
  return { origin, dims, voxel: h, phi };
}

const IN = 0, OUT = 1, WALL = 2;

/**
 * Which side of the surface every node is on: OUT where a 6-connected flood from the grid border
 * gets without entering the wall (nodes within `wall` of the surface), IN where it does not; a
 * wall node goes with the side its non-wall neighbours are on (OUT if they are on both, or none).
 */
function outside(d, [nx, ny, nz], wall) {
  const N = nx * ny * nz;
  const side = new Uint8Array(N).fill(IN);
  for (let n = 0; n < N; n++) if (d[n] <= wall) side[n] = WALL;
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  const sy = nx, sz = nx * ny;
  const push = (n) => {
    if (side[n] === IN) {
      side[n] = OUT;
      queue[tail++] = n;
    }
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + sy * j + sz * k);
  }
  while (head < tail) {
    const n = queue[head++];
    const i = n % nx, j = ((n / sy) | 0) % ny, k = (n / sz) | 0;
    if (i > 0) push(n - 1);
    if (i < nx - 1) push(n + 1);
    if (j > 0) push(n - sy);
    if (j < ny - 1) push(n + sy);
    if (k > 0) push(n - sz);
    if (k < nz - 1) push(n + sz);
  }
  const out = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    if (side[n] !== WALL) {
      out[n] = side[n];
      continue;
    }
    const i = n % nx, j = ((n / sy) | 0) % ny, k = (n / sz) | 0;
    let ins = false, outs = false;
    const look = (m) => {
      if (side[m] === IN) ins = true;
      else if (side[m] === OUT) outs = true;
    };
    if (i > 0) look(n - 1);
    if (i < nx - 1) look(n + 1);
    if (j > 0) look(n - sy);
    if (j < ny - 1) look(n + sy);
    if (k > 0) look(n - sz);
    if (k < nz - 1) look(n + sz);
    out[n] = ins && !outs ? IN : OUT;
  }
  return out;
}

/** A triangle set up for many closest-point queries (Ericson, Real-Time Collision Detection 5.1.5). */
class Triangle {
  constructor(T, t) {
    this.ax = T[t]; this.ay = T[t + 1]; this.az = T[t + 2];
    this.bx = T[t + 3] - this.ax; this.by = T[t + 4] - this.ay; this.bz = T[t + 5] - this.az; // ab
    this.cx = T[t + 6] - this.ax; this.cy = T[t + 7] - this.ay; this.cz = T[t + 8] - this.az; // ac
    this.abab = this.bx * this.bx + this.by * this.by + this.bz * this.bz;
    this.abac = this.bx * this.cx + this.by * this.cy + this.bz * this.cz;
    this.acac = this.cx * this.cx + this.cy * this.cy + this.cz * this.cz;
  }

  /** Squared distance from (x, y, z) to the triangle. */
  distance2(x, y, z) {
    const px = x - this.ax, py = y - this.ay, pz = z - this.az;
    const d1 = this.bx * px + this.by * py + this.bz * pz;
    const d2 = this.cx * px + this.cy * py + this.cz * pz;
    let v, w;
    if (d1 <= 0 && d2 <= 0) { v = 0; w = 0; } else {
      const d3 = d1 - this.abab, d4 = d2 - this.abac;
      const d5 = d1 - this.abac, d6 = d2 - this.acac;
      const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) { v = 1; w = 0; }
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3); w = 0; }
      else if (d6 >= 0 && d5 <= d6) { v = 0; w = 1; }
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6); }
      else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + (d5 - d6)); v = 1 - w; }
      else {
        const s = va + vb + vc;
        if (!(s > 0)) { v = 0; w = 0; } else { v = vb / s; w = vc / s; } // degenerate: its first corner
      }
    }
    const ex = px - v * this.bx - w * this.cx, ey = py - v * this.by - w * this.cy, ez = pz - v * this.bz - w * this.cz;
    return ex * ex + ey * ey + ez * ez;
  }
}
