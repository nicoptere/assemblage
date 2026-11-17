import { Vec3 } from '../math/Vec3.js';
import { solvePoint, applyRelativeVelocityChange } from '../solver/xpbd.js';

const r = new Vec3();
const dx = new Vec3();
const v = new Vec3();

/**
 * Pulls a material point of a body towards a world target (mouse dragging, grabbing, anchoring).
 * `compliance` is in m/N (0 = rigid), `damping` in 1/s removes the point's velocity.
 */
export class PointConstraint {
  constructor(body, worldPoint, { compliance = 1e-4, damping = 8, maxForce = Infinity } = {}) {
    this.body = body;
    this.local = new Vec3().subVectors(Vec3.from(worldPoint), body.position).applyQuatInverse(body.quaternion);
    this.target = Vec3.from(worldPoint);
    this.compliance = compliance;
    this.damping = damping;
    this.maxForce = maxForce;
    this.lambda = new Vec3();
    this.force = 0;
  }

  worldPoint(out) {
    return out.copy(this.local).applyQuat(this.body.quaternion).add(this.body.position);
  }

  begin() {
    this.lambda.set(0, 0, 0);
  }

  solvePosition(h) {
    r.copy(this.local).applyQuat(this.body.quaternion);
    dx.copy(this.target).sub(this.body.position).sub(r);
    solvePoint(this.body, null, r, null, dx, this.compliance, h, this.lambda, this.maxForce);
  }

  solveVelocity(h) {
    if (this.damping <= 0) return;
    r.copy(this.local).applyQuat(this.body.quaternion);
    this.body.velocityAt(r, v).scale(-Math.min(this.damping * h, 1));
    applyRelativeVelocityChange(this.body, null, r, null, v);
  }

  end(h) {
    this.force = this.lambda.length() / (h * h);
    return false;
  }
}
