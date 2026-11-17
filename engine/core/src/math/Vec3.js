/** Mutable 3D vector. Methods write into `this` and return it, so hot loops can reuse scratch vectors. */
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static from(a) {
    return Array.isArray(a) ? new Vec3(a[0], a[1], a[2]) : new Vec3(a.x, a.y, a.z);
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone() {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  addScaled(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  scale(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  negate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  crossVectors(a, b) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length() {
    return Math.sqrt(this.lengthSq());
  }

  normalize() {
    const l = this.length();
    return l > 0 ? this.scale(1 / l) : this;
  }

  distanceTo(v) {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Rotates by unit quaternion q (v' = q v q*). */
  applyQuat(q) {
    const { x, y, z } = this;
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    this.x = x + q.w * tx + (q.y * tz - q.z * ty);
    this.y = y + q.w * ty + (q.z * tx - q.x * tz);
    this.z = z + q.w * tz + (q.x * ty - q.y * tx);
    return this;
  }

  /** Rotates by the inverse of unit quaternion q. */
  applyQuatInverse(q) {
    const { x, y, z } = this;
    const tx = 2 * (-q.y * z + q.z * y);
    const ty = 2 * (-q.z * x + q.x * z);
    const tz = 2 * (-q.x * y + q.y * x);
    this.x = x + q.w * tx + (-q.y * tz + q.z * ty);
    this.y = y + q.w * ty + (-q.z * tx + q.x * tz);
    this.z = z + q.w * tz + (-q.x * ty + q.y * tx);
    return this;
  }

  toArray() {
    return [this.x, this.y, this.z];
  }
}
