import { Shape, MassAccumulator } from './Shape.js';
import { Aabb } from '../math/Aabb.js';
import { Vec3 } from '../math/Vec3.js';

/**
 * Signed distance sampled on a regular, isotropic grid (vertex-centred, x fastest).
 * Values can be Float32 (metres) or Int16 with a metre-per-unit `scale` (the baked format).
 * Outside the grid the distance is extended by the distance to the grid box, which keeps it a
 * valid lower bound for sphere tracing.
 */
export class SdfGridShape extends Shape {
  constructor({ origin, dims, voxel, data, scale = 1, samples }) {
    const [nx, ny, nz] = dims;
    const min = Vec3.from(origin);
    const max = new Vec3(min.x + (nx - 1) * voxel, min.y + (ny - 1) * voxel, min.z + (nz - 1) * voxel);
    super({ samples, localAabb: new Aabb(min, max) });
    this.ox = min.x;
    this.oy = min.y;
    this.oz = min.z;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.voxel = voxel;
    this.inv = 1 / voxel;
    this.data = data;
    this.scale = scale;
  }

  /** Builds a shape from a baked manifest part and the shared shapes.bin buffer. */
  static fromBaked(part, buffer) {
    const { origin, dims, voxel, offset } = part.sdf;
    const count = dims[0] * dims[1] * dims[2];
    const data = new Int16Array(buffer, offset, count);
    const samples = new Float32Array(buffer, part.samples.offset, part.samples.count * 3);
    return new SdfGridShape({ origin, dims, voxel, data, scale: voxel / 256, samples });
  }

  value(i, j, k) {
    return this.data[i + this.nx * (j + this.ny * k)] * this.scale;
  }

  distance(x, y, z, grad) {
    const { nx, ny, nz, inv, data, scale } = this;
    const u = (x - this.ox) * inv;
    const v = (y - this.oy) * inv;
    const w = (z - this.oz) * inv;
    const cu = u < 0 ? 0 : u > nx - 1.000001 ? nx - 1.000001 : u;
    const cv = v < 0 ? 0 : v > ny - 1.000001 ? ny - 1.000001 : v;
    const cw = w < 0 ? 0 : w > nz - 1.000001 ? nz - 1.000001 : w;
    const du = u - cu;
    const dv = v - cv;
    const dw = w - cw;
    const outside = Math.sqrt(du * du + dv * dv + dw * dw) * this.voxel;

    const i = cu | 0;
    const j = cv | 0;
    const k = cw | 0;
    const fx = cu - i;
    const fy = cv - j;
    const fz = cw - k;
    const sx = nx;
    const sxy = nx * ny;
    const base = i + sx * j + sxy * k;
    const c000 = data[base];
    const c100 = data[base + 1];
    const c010 = data[base + sx];
    const c110 = data[base + sx + 1];
    const c001 = data[base + sxy];
    const c101 = data[base + sxy + 1];
    const c011 = data[base + sxy + sx];
    const c111 = data[base + sxy + sx + 1];

    const c00 = c000 + (c100 - c000) * fx;
    const c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx;
    const c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    const d = (c0 + (c1 - c0) * fz) * scale + outside;

    if (grad) {
      if (outside > 0) {
        grad.set(du, dv, dw).normalize();
      } else {
        const gx = (c100 - c000) * (1 - fy) * (1 - fz) + (c110 - c010) * fy * (1 - fz) + (c101 - c001) * (1 - fy) * fz + (c111 - c011) * fy * fz;
        const gy = (c10 - c00) * (1 - fz) + (c11 - c01) * fz;
        const gz = c1 - c0;
        grad.set(gx, gy, gz);
        if (grad.lengthSq() < 1e-20) grad.set(0, 1, 0);
        grad.normalize();
      }
    }
    return d;
  }

  /** Integrates a fractional occupancy (0.5 - phi / h, clamped) over the grid nodes. */
  massProperties(density) {
    const { nx, ny, nz, voxel } = this;
    const cell = voxel * voxel * voxel * density;
    const selfI = (voxel * voxel) / 6;
    const acc = new MassAccumulator();
    let n = 0;
    for (let k = 0; k < nz; k++) {
      const z = this.oz + k * voxel;
      for (let j = 0; j < ny; j++) {
        const y = this.oy + j * voxel;
        for (let i = 0; i < nx; i++, n++) {
          const occ = 0.5 - (this.data[n] * this.scale) / voxel;
          if (occ <= 0) continue;
          const dm = cell * (occ > 1 ? 1 : occ);
          acc.add(this.ox + i * voxel, y, z, dm, dm * selfI);
        }
      }
    }
    return acc.result();
  }
}
