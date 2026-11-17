import { Shape } from './Shape.js';
import { Aabb } from '../math/Aabb.js';
import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';

/** Evenly spread points on a unit sphere (Fibonacci lattice). */
function fibonacciSphere(count, radius) {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    out[i * 3] = Math.cos(a) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(a) * r * radius;
  }
  return out;
}

export class SphereShape extends Shape {
  constructor(radius, { sampleCount = 48 } = {}) {
    super({
      samples: fibonacciSphere(sampleCount, radius),
      localAabb: new Aabb(new Vec3(-radius, -radius, -radius), new Vec3(radius, radius, radius)),
    });
    this.radius = radius;
  }

  distance(x, y, z, grad) {
    const l = Math.sqrt(x * x + y * y + z * z);
    if (grad) {
      if (l > 1e-12) grad.set(x / l, y / l, z / l);
      else grad.set(0, 1, 0);
    }
    return l - this.radius;
  }

  massProperties(density) {
    const r = this.radius;
    const mass = (4 / 3) * Math.PI * r * r * r * density;
    const i = 0.4 * mass * r * r;
    return { mass, com: new Vec3(), inertia: Mat3.diagonal(i, i, i) };
  }
}

export class BoxShape extends Shape {
  constructor(halfExtents, { samplesPerEdge = 4 } = {}) {
    const h = Vec3.from(halfExtents);
    const pts = [];
    const n = samplesPerEdge;
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n; b++) {
        const u = -1 + (2 * a) / n;
        const v = -1 + (2 * b) / n;
        for (const s of [-1, 1]) {
          pts.push(s * h.x, u * h.y, v * h.z);
          pts.push(u * h.x, s * h.y, v * h.z);
          pts.push(u * h.x, v * h.y, s * h.z);
        }
      }
    }
    super({ samples: new Float32Array(pts), localAabb: new Aabb(h.clone().negate(), h.clone()) });
    this.halfExtents = h;
  }

  distance(x, y, z, grad) {
    const h = this.halfExtents;
    const qx = Math.abs(x) - h.x;
    const qy = Math.abs(y) - h.y;
    const qz = Math.abs(z) - h.z;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    const oz = Math.max(qz, 0);
    const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const inside = Math.min(Math.max(qx, qy, qz), 0);
    if (grad) {
      if (outside > 0) grad.set(Math.sign(x) * ox, Math.sign(y) * oy, Math.sign(z) * oz).normalize();
      else if (qx >= qy && qx >= qz) grad.set(Math.sign(x) || 1, 0, 0);
      else if (qy >= qz) grad.set(0, Math.sign(y) || 1, 0);
      else grad.set(0, 0, Math.sign(z) || 1);
    }
    return outside + inside;
  }

  massProperties(density) {
    const { x, y, z } = this.halfExtents;
    const mass = 8 * x * y * z * density;
    const k = mass / 3;
    return { mass, com: new Vec3(), inertia: Mat3.diagonal(k * (y * y + z * z), k * (x * x + z * z), k * (x * x + y * y)) };
  }
}

/** Half-space below a plane (normal points out of the solid). Static bodies only. */
export class PlaneShape extends Shape {
  constructor(normal = [0, 1, 0], offset = 0) {
    super({ infinite: true });
    this.normal = Vec3.from(normal).normalize();
    this.offset = offset;
  }

  distance(x, y, z, grad) {
    const n = this.normal;
    if (grad) grad.copy(n);
    return n.x * x + n.y * y + n.z * z - this.offset;
  }

  /** Can a world box touch this plane (placed at identity) within margin? */
  touchesAabb(aabb, margin) {
    const n = this.normal;
    const x = n.x > 0 ? aabb.min.x : aabb.max.x;
    const y = n.y > 0 ? aabb.min.y : aabb.max.y;
    const z = n.z > 0 ? aabb.min.z : aabb.max.z;
    return n.x * x + n.y * y + n.z * z - this.offset <= margin;
  }

  massProperties() {
    throw new Error('PlaneShape is static only');
  }
}
