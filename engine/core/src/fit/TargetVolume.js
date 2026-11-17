import { edt2 } from './brickpack/field.js';

/**
 * The shape to rebuild, as the nodes of a regular grid (spacing `voxel`, metres) that a mesh
 * encloses, robust to the meshes image-to-3D tools produce (patch soups with mixed orientations,
 * open sheets, small gaps): the surface is rasterised, thickened to a shell `shell` thick, and the
 * outside is flood-filled from the grid border; everything the flood does not reach is inside.
 * Closed surfaces come out solid (grown outwards by half the shell), gaps narrower than the shell
 * are bridged, open sheets (leaves) become shells. The mesh is placed with
 *   x_world = Ry(yaw) (x - c) scale + centre        (c: the centre of the mesh's bounding box)
 * Grid layout: node (i, j, k) at lo + (i, j, k) * voxel, index (k * ny + j) * nx + i.
 */
export class TargetVolume {
  constructor(mesh, { scale = 1, voxel = 0.025, centre = [0, 0, 0], yaw = 0, shell = 2 * voxel } = {}) {
    const { V, F } = mesh;
    const c = TargetVolume.bounds(V).centre;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const W = new Float64Array(V.length);
    for (let i = 0; i < V.length; i += 3) {
      const x = (V[i] - c[0]) * scale, y = (V[i + 1] - c[1]) * scale, z = (V[i + 2] - c[2]) * scale;
      W[i] = cos * x + sin * z + centre[0];
      W[i + 1] = y + centre[1];
      W[i + 2] = -sin * x + cos * z + centre[2];
    }
    this.vertices = W; // the placed mesh, for drawing it
    this.transform = { c, scale, yaw, centre }; // x_world = Ry(yaw) (x - c) scale + centre
    this.voxel = voxel;
    const pad = shell / 2 + 2 * voxel;
    const b = TargetVolume.bounds(W);
    this.lo = b.lo.map((l) => l - pad);
    [this.nx, this.ny, this.nz] = b.size.map((s) => Math.ceil((s + 2 * pad) / voxel) + 1);

    const surface = this._rasterise(W, F);
    const { nx, ny, nz } = this;
    // edt2 indexes (y * nz + z) * nx + x; ours (k * ny + j) * nx + i is that with y and z swapped
    const d2 = edt2(surface, nx, nz, ny);
    const r = Math.max(0, shell / 2 / voxel);
    const band = new Uint8Array(d2.length);
    for (let n = 0; n < d2.length; n++) band[n] = d2[n] <= r * r ? 1 : 0;
    this.inside = TargetVolume._enclosed(band, nx, ny, nz);
    let count = 0;
    for (let n = 0; n < this.inside.length; n++) count += this.inside[n];
    this.count = count;
    this.volume = count * voxel ** 3;
  }

  /** Grid nodes the surface passes through: every triangle sampled at half the spacing. */
  _rasterise(W, F) {
    const { nx, ny, nz, lo, voxel } = this;
    const out = new Uint8Array(nx * ny * nz);
    const inv = 1 / voxel;
    for (let f = 0; f < F.length; f += 3) {
      const a = 3 * F[f], b = 3 * F[f + 1], c = 3 * F[f + 2];
      const edge = Math.max(
        Math.hypot(W[b] - W[a], W[b + 1] - W[a + 1], W[b + 2] - W[a + 2]),
        Math.hypot(W[c] - W[a], W[c + 1] - W[a + 1], W[c + 2] - W[a + 2]),
        Math.hypot(W[c] - W[b], W[c + 1] - W[b + 1], W[c + 2] - W[b + 2]),
      );
      const n = Math.max(1, Math.ceil((2 * edge) / voxel));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        const ix = Math.round((w * W[a] + u * W[b] + v * W[c] - lo[0]) * inv);
        const iy = Math.round((w * W[a + 1] + u * W[b + 1] + v * W[c + 1] - lo[1]) * inv);
        const iz = Math.round((w * W[a + 2] + u * W[b + 2] + v * W[c + 2] - lo[2]) * inv);
        out[(iz * ny + iy) * nx + ix] = 1;
      }
    }
    return out;
  }

  /** 1 where the grid border cannot be reached without crossing `wall` (6-connected flood fill). */
  static _enclosed(wall, nx, ny, nz) {
    const N = nx * ny * nz;
    const outside = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (n) => {
      if (!wall[n] && !outside[n]) {
        outside[n] = 1;
        queue[tail++] = n;
      }
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push((k * ny + j) * nx + i);
    }
    const sy = nx, sz = nx * ny;
    while (head < tail) {
      const n = queue[head++];
      const i = n % nx, j = Math.floor(n / sy) % ny, k = Math.floor(n / sz);
      if (i > 0) push(n - 1);
      if (i < nx - 1) push(n + 1);
      if (j > 0) push(n - sy);
      if (j < ny - 1) push(n + sy);
      if (k > 0) push(n - sz);
      if (k < nz - 1) push(n + sz);
    }
    const inside = new Uint8Array(N);
    for (let n = 0; n < N; n++) inside[n] = outside[n] ? 0 : 1;
    return inside;
  }

  /**
   * Keeps only the outer layer of the solid, in whole layers of voxels as thick as it takes to
   * hold at least `volume` (m^3), and at least `minThickness` (m): a target much bigger than the
   * parts becomes a shell they can cover, instead of a core they fill while the outline stays empty.
   */
  hollow(volume, minThickness = 0) {
    const { nx, ny, nz, inside, voxel } = this;
    const outside = new Uint8Array(inside.length);
    for (let n = 0; n < inside.length; n++) outside[n] = inside[n] ? 0 : 1;
    const d2 = edt2(outside, nx, nz, ny); // squared distance (voxels) to the outside; layout as in the constructor
    const depths = new Float32Array(this.count);
    for (let n = 0, k = 0; n < inside.length; n++) if (inside[n]) depths[k++] = d2[n];
    depths.sort();
    const keep = Math.min(depths.length, Math.ceil(volume / voxel ** 3));
    const limit = Math.max(keep ? depths[keep - 1] : 0, (minThickness / voxel) ** 2);
    let count = 0;
    for (let n = 0; n < inside.length; n++) {
      if (inside[n] && d2[n] > limit) inside[n] = 0;
      count += inside[n];
    }
    this.count = count;
    this.volume = count * voxel ** 3;
    return this;
  }

  /**
   * The target as a rebuild uses it: sized so it holds `size` x `volume` (m^3, the parts' volume),
   * turned by `yaw` and standing `floor` m high over the origin. The scale is solved at twice the
   * voxel (scaleForVolume); a target bigger than the parts (size > 1) is then hollowed to a shell
   * they can cover, at least `minThickness` thick. The same settings always give the same target.
   */
  static place(mesh, { volume, size = 1, voxel = 0.025, shell = 2 * voxel, yaw = 0, floor = 0, minThickness = 0 }) {
    const scale = TargetVolume.scaleForVolume(mesh, size * volume, { shell, voxel: 2 * voxel });
    const height = TargetVolume.bounds(mesh.V).size[1] * scale;
    const target = new TargetVolume(mesh, { scale, voxel, shell, yaw, centre: [0, floor + height / 2 + shell / 2, 0] });
    if (size > 1) target.hollow(volume, minThickness);
    return target;
  }

  /** Positions (xyz, Float32Array) of the inside nodes next to an outside one: the target's skin, for drawing. */
  surface() {
    const { nx, ny, nz, inside } = this;
    const sy = nx, sz = nx * ny;
    const out = [];
    const p = [0, 0, 0];
    for (let k = 0, n = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, n++) {
      if (!inside[n]) continue;
      const edge = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
      if (edge || !inside[n - 1] || !inside[n + 1] || !inside[n - sy] || !inside[n + sy] || !inside[n - sz] || !inside[n + sz]) out.push(...this.position(n, p));
    }
    return Float32Array.from(out);
  }

  static bounds(V) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], V[i + a]);
      hi[a] = Math.max(hi[a], V[i + a]);
    }
    return { lo, hi, centre: lo.map((l, a) => (l + hi[a]) / 2), size: lo.map((l, a) => hi[a] - l) };
  }

  /**
   * The scale (metres per mesh unit) at which the target's volume is `volume`, by a few
   * iterations at a coarse voxel (the shell does not scale with the mesh, so volume is not ~ s^3).
   */
  static scaleForVolume(mesh, volume, { shell = 0.1, voxel = 0.05, iterations = 4 } = {}) {
    let scale = Math.cbrt(volume) / Math.max(...TargetVolume.bounds(mesh.V).size);
    for (let it = 0; it < iterations; it++) {
      const t = new TargetVolume(mesh, { scale, voxel, shell });
      scale *= Math.cbrt(volume / Math.max(t.volume, 1e-9));
    }
    return scale;
  }

  position(n, out = [0, 0, 0]) {
    const i = n % this.nx, j = Math.floor(n / this.nx) % this.ny, k = Math.floor(n / (this.nx * this.ny));
    out[0] = this.lo[0] + i * this.voxel;
    out[1] = this.lo[1] + j * this.voxel;
    out[2] = this.lo[2] + k * this.voxel;
    return out;
  }
}
