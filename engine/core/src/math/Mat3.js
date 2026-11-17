const _T = new Float64Array(9);
let _R; // created after the class definition

/** Row-major 3x3 matrix, used for inertia tensors and rotations. */
export class Mat3 {
  constructor(e) {
    this.e = new Float64Array(9);
    if (e) this.e.set(e);
  }

  static diagonal(a, b, c) {
    return new Mat3([a, 0, 0, 0, b, 0, 0, 0, c]);
  }

  copy(m) {
    this.e.set(m.e);
    return this;
  }

  zero() {
    this.e.fill(0);
    return this;
  }

  addDiagonal(s) {
    this.e[0] += s;
    this.e[4] += s;
    this.e[8] += s;
    return this;
  }

  add(m) {
    for (let i = 0; i < 9; i++) this.e[i] += m.e[i];
    return this;
  }

  /** this += S^T M S for skew(r) = S, i.e. the inverse mass a point at arm r sees from inertia M. */
  addArmInertia(M, r) {
    const m = M.e;
    const { x, y, z } = r;
    // A = M S, with S v = r x v
    const a00 = m[1] * z - m[2] * y, a01 = m[2] * x - m[0] * z, a02 = m[0] * y - m[1] * x;
    const a10 = m[4] * z - m[5] * y, a11 = m[5] * x - m[3] * z, a12 = m[3] * y - m[4] * x;
    const a20 = m[7] * z - m[8] * y, a21 = m[8] * x - m[6] * z, a22 = m[6] * y - m[7] * x;
    // this += -S A  (S^T = -S)
    const e = this.e;
    e[0] -= -z * a10 + y * a20; e[1] -= -z * a11 + y * a21; e[2] -= -z * a12 + y * a22;
    e[3] -= z * a00 - x * a20; e[4] -= z * a01 - x * a21; e[5] -= z * a02 - x * a22;
    e[6] -= -y * a00 + x * a10; e[7] -= -y * a01 + x * a11; e[8] -= -y * a02 + x * a12;
    return this;
  }

  /** this = R L R^T for rotation R given by quaternion q (world tensor from a local one). */
  setRotated(L, q) {
    const R = _R.setFromQuat(q).e;
    const l = L.e;
    const t = _T;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      t[i * 3 + j] = R[i * 3] * l[j] + R[i * 3 + 1] * l[3 + j] + R[i * 3 + 2] * l[6 + j];
    }
    const e = this.e;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      e[i * 3 + j] = t[i * 3] * R[j * 3] + t[i * 3 + 1] * R[j * 3 + 1] + t[i * 3 + 2] * R[j * 3 + 2];
    }
    return this;
  }

  /** Solves this x = b for symmetric positive definite matrices; returns false if singular. */
  solve(b, out) {
    const [a, b1, c, d, e, f, g, h, i] = this.e;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b1 * B + c * C;
    if (Math.abs(det) < 1e-300) return false;
    const s = 1 / det;
    const { x, y, z } = b;
    out.set(
      (A * x + -(b1 * i - c * h) * y + (b1 * f - c * e) * z) * s,
      (B * x + (a * i - c * g) * y + -(a * f - c * d) * z) * s,
      (C * x + -(a * h - b1 * g) * y + (a * e - b1 * d) * z) * s,
    );
    return true;
  }

  clone() {
    return new Mat3(this.e);
  }

  /** out = M v */
  mulVec(v, out) {
    const e = this.e;
    const { x, y, z } = v;
    return out.set(e[0] * x + e[1] * y + e[2] * z, e[3] * x + e[4] * y + e[5] * z, e[6] * x + e[7] * y + e[8] * z);
  }

  invert() {
    const [a, b, c, d, e, f, g, h, i] = this.e;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-30) throw new Error('Mat3.invert: singular matrix');
    const s = 1 / det;
    this.e.set([
      A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
      B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
      C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
    ]);
    return this;
  }

  setFromQuat(q) {
    const { x, y, z, w } = q;
    this.e.set([
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ]);
    return this;
  }

  /** this = A^T B (both rotations): maps B-frame vectors into A's frame. */
  setTransposeMul(A, B) {
    const a = A.e;
    const b = B.e;
    const r = this.e;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = a[i] * b[j] + a[3 + i] * b[3 + j] + a[6 + i] * b[6 + j];
      }
    }
    return this;
  }
}

_R = new Mat3();
