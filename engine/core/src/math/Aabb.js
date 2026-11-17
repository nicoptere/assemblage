import { Vec3 } from './Vec3.js';

export class Aabb {
  constructor(min = new Vec3(Infinity, Infinity, Infinity), max = new Vec3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }

  copy(b) {
    this.min.copy(b.min);
    this.max.copy(b.max);
    return this;
  }

  overlaps(b) {
    return (
      this.min.x <= b.max.x && this.max.x >= b.min.x &&
      this.min.y <= b.max.y && this.max.y >= b.min.y &&
      this.min.z <= b.max.z && this.max.z >= b.min.z
    );
  }

  expand(m) {
    this.min.x -= m;
    this.min.y -= m;
    this.min.z -= m;
    this.max.x += m;
    this.max.y += m;
    this.max.z += m;
    return this;
  }

  /** Grows the box by a displacement (swept box). */
  sweep(d) {
    if (d.x < 0) this.min.x += d.x; else this.max.x += d.x;
    if (d.y < 0) this.min.y += d.y; else this.max.y += d.y;
    if (d.z < 0) this.min.z += d.z; else this.max.z += d.z;
    return this;
  }

  /**
   * World box of a local box under rotation matrix R (Mat3) and translation t, where the local
   * box is offset by -com (shape space -> body space).
   */
  setTransformed(local, R, t, com) {
    const e = R.e;
    const cx = 0.5 * (local.min.x + local.max.x) - com.x;
    const cy = 0.5 * (local.min.y + local.max.y) - com.y;
    const cz = 0.5 * (local.min.z + local.max.z) - com.z;
    const hx = 0.5 * (local.max.x - local.min.x);
    const hy = 0.5 * (local.max.y - local.min.y);
    const hz = 0.5 * (local.max.z - local.min.z);
    for (let i = 0; i < 3; i++) {
      const c = e[i * 3] * cx + e[i * 3 + 1] * cy + e[i * 3 + 2] * cz;
      const h = Math.abs(e[i * 3]) * hx + Math.abs(e[i * 3 + 1]) * hy + Math.abs(e[i * 3 + 2]) * hz;
      const ti = i === 0 ? t.x : i === 1 ? t.y : t.z;
      const lo = ti + c - h;
      const hi = ti + c + h;
      if (i === 0) { this.min.x = lo; this.max.x = hi; }
      else if (i === 1) { this.min.y = lo; this.max.y = hi; }
      else { this.min.z = lo; this.max.z = hi; }
    }
    return this;
  }

  /** Ray slab test; returns [tEnter, tExit] or null. */
  intersectRay(o, d, tMax = Infinity) {
    let t0 = 0;
    let t1 = tMax;
    for (const k of ['x', 'y', 'z']) {
      const inv = 1 / d[k];
      let a = (this.min[k] - o[k]) * inv;
      let b = (this.max[k] - o[k]) * inv;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }
}
