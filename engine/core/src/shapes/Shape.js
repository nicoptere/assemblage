import { Aabb } from '../math/Aabb.js';
import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';

/**
 * A collision shape is anything that answers three questions, in its own (shape) space:
 *   distance(x, y, z, grad?)  signed distance, and optionally its unit gradient (outward normal)
 *   samples                   surface points used to probe other shapes (Float32Array xyz)
 *   massProperties(density)   { mass, com, inertia } with inertia about the centre of mass
 * Collision between any two shapes is "samples of one against the distance of the other",
 * so adding a shape never needs a new pairwise routine.
 */
export class Shape {
  constructor({ samples = new Float32Array(0), localAabb = new Aabb(), infinite = false } = {}) {
    this.samples = Shape.spread(samples);
    this.localAabb = localAabb;
    this.infinite = infinite;
  }

  get sampleCount() {
    return this.samples.length / 3;
  }

  /** The first `fraction` of the samples (at least MIN_SAMPLES): an evenly spread subset. */
  samplesFor(fraction = 1) {
    const n = this.sampleCount;
    const k = fraction >= 1 ? n : Math.min(n, Math.max(Shape.MIN_SAMPLES, Math.ceil(fraction * n)));
    return this.samples.subarray(0, k * 3);
  }

  /**
   * The same points in farthest-point order: each is the farthest from all points before it,
   * starting from the one farthest from the centroid. Every prefix is then evenly spread and
   * holds the extremes first, so a precision setting is just a prefix length.
   */
  static spread(points) {
    const n = points.length / 3;
    if (n <= 2) return points;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += points[i * 3] / n;
      cy += points[i * 3 + 1] / n;
      cz += points[i * 3 + 2] / n;
    }
    const minD = new Float64Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) {
      minD[i] = (points[i * 3] - cx) ** 2 + (points[i * 3 + 1] - cy) ** 2 + (points[i * 3 + 2] - cz) ** 2;
      if (minD[i] > minD[last]) last = i;
    }
    minD.fill(Infinity);
    const out = new Float32Array(points.length);
    for (let k = 0; k < n; k++) {
      out.set(points.subarray(last * 3, last * 3 + 3), k * 3);
      minD[last] = -1; // taken
      const lx = points[last * 3], ly = points[last * 3 + 1], lz = points[last * 3 + 2];
      let next = -1;
      for (let i = 0; i < n; i++) {
        if (minD[i] < 0) continue;
        const d = (points[i * 3] - lx) ** 2 + (points[i * 3 + 1] - ly) ** 2 + (points[i * 3 + 2] - lz) ** 2;
        if (d < minD[i]) minD[i] = d;
        if (next < 0 || minD[i] > minD[next]) next = i;
      }
      last = next;
    }
    return out;
  }

  // eslint-disable-next-line no-unused-vars
  distance(x, y, z, grad) {
    throw new Error(`${this.constructor.name}.distance not implemented`);
  }

  // eslint-disable-next-line no-unused-vars
  massProperties(density) {
    throw new Error(`${this.constructor.name}.massProperties not implemented`);
  }

  /** Numerical gradient fallback for shapes without an analytic one. */
  numericGradient(x, y, z, grad, eps = 1e-4) {
    grad.set(
      this.distance(x + eps, y, z) - this.distance(x - eps, y, z),
      this.distance(x, y + eps, z) - this.distance(x, y - eps, z),
      this.distance(x, y, z + eps) - this.distance(x, y, z - eps),
    );
    if (grad.lengthSq() < 1e-20) grad.set(0, 1, 0);
    return grad.normalize();
  }
}

Shape.MIN_SAMPLES = 4;

/** Mass properties of a solid made of point masses (used by grids and for testing). */
export class MassAccumulator {
  constructor() {
    this.m = 0;
    this.sx = 0;
    this.sy = 0;
    this.sz = 0;
    this.xx = 0;
    this.yy = 0;
    this.zz = 0;
    this.xy = 0;
    this.xz = 0;
    this.yz = 0;
    this.self = 0; // sum of each cell's own inertia (cube: dm * h^2 / 6 per axis)
  }

  add(x, y, z, dm, selfInertia = 0) {
    this.m += dm;
    this.sx += dm * x;
    this.sy += dm * y;
    this.sz += dm * z;
    this.xx += dm * x * x;
    this.yy += dm * y * y;
    this.zz += dm * z * z;
    this.xy += dm * x * y;
    this.xz += dm * x * z;
    this.yz += dm * y * z;
    this.self += selfInertia;
  }

  result() {
    const m = this.m;
    if (m <= 0) throw new Error('MassAccumulator: empty solid');
    const c = new Vec3(this.sx / m, this.sy / m, this.sz / m);
    // second moments about the centre of mass
    const xx = this.xx - m * c.x * c.x;
    const yy = this.yy - m * c.y * c.y;
    const zz = this.zz - m * c.z * c.z;
    const xy = this.xy - m * c.x * c.y;
    const xz = this.xz - m * c.x * c.z;
    const yz = this.yz - m * c.y * c.z;
    const s = this.self;
    const inertia = new Mat3([yy + zz + s, -xy, -xz, -xy, xx + zz + s, -yz, -xz, -yz, xx + yy + s]);
    return { mass: m, com: c, inertia };
  }
}
