import { Vec3 } from '../math/Vec3.js';
import { positionalDelta, applyPositional, applyRelativeVelocityChange, applyRelativeAngularVelocityChange } from '../solver/xpbd.js';

const rA = new Vec3();
const rB = new Vec3();
const pA = new Vec3();
const pB = new Vec3();
const n = new Vec3();
const d = new Vec3();
const t = new Vec3();
const vA = new Vec3();
const vB = new Vec3();
const w = new Vec3();

/**
 * One sample of body A touching the surface of body B.
 * Collision detection runs once per step and stores body-local data; each substep re-evaluates
 * the contact against B's tangent plane at the stored surface point (linearised SDF), so no
 * distance query happens inside the substep loop. Instances are pooled by the narrowphase.
 */
export class Contact {
  constructor() {
    this.bodyA = null;
    this.bodyB = null;
    this.rA = new Vec3(); // A-local arm of the sample
    this.rB = new Vec3(); // B-local closest surface point
    this.nB = new Vec3(); // B-local outward normal
    this.depth = 0; // penetration at detection (negative = speculative gap)
    this.friction = 0;
    this.restitution = 0;
    this.rollingFriction = 0;
    this.lambdaN = 0;
    this.lambdaT = 0;
    this.vnPre = 0;
    this.depth0 = 0; // penetration at the start of the substep
    this.approach = 0; // closing speed along the normal when the step began (impact sounds, effects)
  }

  init(bodyA, bodyB, ax, ay, az, bx, by, bz, normal, depth) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.rA.set(ax, ay, az);
    this.rB.set(bx, by, bz);
    this.nB.copy(normal);
    this.depth = depth;
    this.friction = Math.sqrt(bodyA.friction * bodyB.friction);
    this.restitution = Math.max(bodyA.restitution, bodyB.restitution);
    this.rollingFriction = Math.max(bodyA.rollingFriction, bodyB.rollingFriction);
    this.lambdaN = 0;
    this.lambdaT = 0;
    this.vnPre = 0;
    this.approach = -1; // set by the first substep
    return this;
  }

  _world() {
    const A = this.bodyA;
    const B = this.bodyB;
    rA.copy(this.rA).applyQuat(A.quaternion);
    rB.copy(this.rB).applyQuat(B.quaternion);
    pA.copy(A.position).add(rA);
    pB.copy(B.position).add(rB);
    n.copy(this.nB).applyQuat(B.quaternion);
  }

  /** Called at the start of a substep, before integration. */
  begin() {
    this.lambdaN = 0;
    this.lambdaT = 0;
    this._world();
    this.depth0 = Math.max(0, d.subVectors(pB, pA).dot(n));
    this.bodyA.velocityAt(rA, vA);
    this.bodyB.velocityAt(rB, vB);
    this.vnPre = vA.sub(vB).dot(n);
    if (this.approach < 0) this.approach = Math.max(0, -this.vnPre);
  }

  /**
   * Penetration is pushed out at `maxDepenetrationSpeed` at most (on top of the approach speed):
   * XPBD turns every correction into velocity, and fast corrections make piles boil.
   * Against an immovable body (ground, walls, sleepers) only the penetration the substep started
   * with is limited that way; penetration created during the substep, e.g. by a heavy ball
   * crushing a part against a wall, is undone in full. These contacts come last in the solve,
   * so nothing pushes the part back in, and the obstacle cannot pass velocity on to a pile.
   */
  solvePosition(h, maxDepenetrationSpeed) {
    const A = this.bodyA;
    const B = this.bodyB;
    this._world();
    let depth = d.subVectors(pB, pA).dot(n);
    if (A.invMass > 0 && B.invMass > 0) {
      depth = Math.min(depth, (Math.max(0, -this.vnPre) + maxDepenetrationSpeed) * h);
    } else {
      depth -= Math.max(0, this.depth0 - maxDepenetrationSpeed * h);
    }
    if (depth <= 0) return;

    const dl = positionalDelta(A, B, rA, rB, n, depth, 0, h, this.lambdaN);
    this.lambdaN += dl;
    applyPositional(A, B, rA, rB, t.copy(n).scale(dl));

    // Static friction: undo tangential slip of the contact points during this substep
    this._world();
    d.copy(this.rA).applyQuat(A.prevQuaternion).add(A.prevPosition); // A point, substep start
    t.copy(this.rB).applyQuat(B.prevQuaternion).add(B.prevPosition); // B point, substep start
    d.subVectors(pA, d).sub(vA.subVectors(pB, t)); // relative displacement
    d.addScaled(n, -d.dot(n));
    const slip = d.length();
    if (slip < 1e-9) return;
    d.scale(-1 / slip);
    const dlt = positionalDelta(A, B, rA, rB, d, slip, 0, h, this.lambdaT);
    if (this.lambdaT + dlt < this.friction * this.lambdaN) {
      this.lambdaT += dlt;
      applyPositional(A, B, rA, rB, d.scale(dlt));
    }
  }

  solveVelocity(h, gravityMagnitude) {
    if (this.lambdaN <= 0) return;
    this._world();
    this.bodyA.velocityAt(rA, vA);
    this.bodyB.velocityAt(rB, vB);
    const A = this.bodyA;
    const B = this.bodyB;
    const v = vA.sub(vB);
    const vn = v.dot(n);
    t.copy(v).addScaled(n, -vn); // tangential velocity
    const vt = t.length();
    const fn = this.lambdaN / (h * h);

    // Restitution (off for resting contacts to avoid jitter)
    const e = Math.abs(vn) <= 2 * gravityMagnitude * h ? 0 : this.restitution;
    applyRelativeVelocityChange(A, B, rA, rB, d.copy(n).scale(-vn + Math.max(-e * this.vnPre, 0)));

    // Dynamic friction: impulse h * mu * fn, i.e. a velocity change of that times the inverse mass
    // seen along the slip (the XPBD paper's formula omits it, which makes light parts slide forever)
    if (vt > 1e-9) {
      t.scale(1 / vt);
      const w = A.pointInvMass(rA, t) + B.pointInvMass(rB, t);
      applyRelativeVelocityChange(A, B, rA, rB, t.scale(-Math.min(h * this.friction * fn * w, vt)));
    }
    this._resistRolling(h, fn);
  }

  /**
   * Rolling and spinning resistance: a torque of rollingFriction x normal force opposing the
   * relative spin, never reversing it. Real contacts are patches, not points; without this, debris
   * keeps rolling and pivoting on the ground indefinitely.
   */
  _resistRolling(h, fn) {
    if (this.rollingFriction <= 0) return;
    const A = this.bodyA;
    const B = this.bodyB;
    const spin = w.subVectors(A.angularVelocity, B.angularVelocity).length();
    if (spin < 1e-9) return;
    w.scale(1 / spin);
    const k = A.angularInvMass(w) + B.angularInvMass(w);
    applyRelativeAngularVelocityChange(A, B, w.scale(-Math.min(spin, h * this.rollingFriction * fn * k)));
  }

  /** World contact point and normal (for debug drawing). */
  worldPoint(outPoint, outNormal) {
    this._world();
    outPoint.copy(pB);
    if (outNormal) outNormal.copy(n);
    return outPoint;
  }
}
