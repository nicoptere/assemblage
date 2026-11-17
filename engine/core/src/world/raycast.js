import { Vec3 } from '../math/Vec3.js';

const o = new Vec3();
const d = new Vec3();
const g = new Vec3();

/**
 * Sphere tracing against every body's distance function (an SDF engine gets raycasts for free).
 * Returns the nearest hit { body, distance, point, normal } or null.
 */
export function raycast(bodies, origin, direction, { maxDistance = 1000, filter = null, epsilon = 2e-4, maxSteps = 160 } = {}) {
  const dir = Vec3.from(direction).normalize();
  const org = Vec3.from(origin);
  let best = null;

  for (const body of bodies) {
    if (filter && !filter(body)) continue;
    let t0 = 0;
    let t1 = best ? best.distance : maxDistance;
    if (!body.shape.infinite) {
      const span = body.aabb.intersectRay(org, dir, t1);
      if (!span) continue;
      [t0, t1] = span;
    }
    // ray in shape space
    o.subVectors(org, body.position).applyQuatInverse(body.quaternion).add(body.com);
    d.copy(dir).applyQuatInverse(body.quaternion);
    let tt = t0;
    for (let i = 0; i < maxSteps && tt <= t1; i++) {
      const phi = body.shape.distance(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt);
      if (phi < epsilon) {
        body.shape.distance(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt, g);
        best = {
          body,
          distance: tt,
          point: org.clone().addScaled(dir, tt),
          normal: g.clone().applyQuat(body.quaternion),
        };
        break;
      }
      tt += Math.max(phi, epsilon);
    }
  }
  return best;
}
