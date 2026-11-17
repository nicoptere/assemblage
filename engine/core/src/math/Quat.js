/** Mutable unit quaternion (x, y, z, w). */
export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  static from(a) {
    return Array.isArray(a) ? new Quat(a[0], a[1], a[2], a[3]) : new Quat(a.x, a.y, a.z, a.w);
  }

  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q) {
    return this.set(q.x, q.y, q.z, q.w);
  }

  clone() {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  identity() {
    return this.set(0, 0, 0, 1);
  }

  conjugate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /** this = a * b */
  multiplyQuats(a, b) {
    const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    return this.set(x, y, z, w);
  }

  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    return l > 0 ? this.set(this.x / l, this.y / l, this.z / l, this.w / l) : this.identity();
  }

  setFromAxisAngle(axis, angle) {
    const s = Math.sin(angle / 2);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2));
  }

  /** this = spherical interpolation from a (t = 0) to b (t = 1), along the shorter arc. */
  slerpQuats(a, b, t) {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let ka = 1 - t, kb = t;
    if (cos < 0.9995) {
      const angle = Math.acos(cos), sin = Math.sin(angle);
      ka = Math.sin((1 - t) * angle) / sin;
      kb = Math.sin(t * angle) / sin;
    }
    return this.set(ka * a.x + kb * bx, ka * a.y + kb * by, ka * a.z + kb * bz, ka * a.w + kb * bw).normalize();
  }

  /**
   * Applies a small world-space rotation vector: q += 0.5 * [v, 0] * q, then normalises.
   * This is the XPBD orientation update for both integration (v = h * omega) and corrections.
   */
  addRotation(v, scale = 1) {
    const vx = v.x * scale;
    const vy = v.y * scale;
    const vz = v.z * scale;
    const { x, y, z, w } = this;
    this.x += 0.5 * (vx * w + vy * z - vz * y);
    this.y += 0.5 * (vy * w + vz * x - vx * z);
    this.z += 0.5 * (vz * w + vx * y - vy * x);
    this.w += 0.5 * (-vx * x - vy * y - vz * z);
    return this.normalize();
  }

  /** Writes the rotation vector (axis * angle, shortest arc) into out. */
  toRotationVector(out) {
    let { x, y, z, w } = this;
    if (w < 0) {
      x = -x;
      y = -y;
      z = -z;
      w = -w;
    }
    const s = Math.sqrt(x * x + y * y + z * z);
    if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
    const k = (2 * Math.atan2(s, w)) / s;
    return out.set(x * k, y * k, z * k);
  }

  toArray() {
    return [this.x, this.y, this.z, this.w];
  }
}
