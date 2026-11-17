import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { solvePoint, solveRotation, solveAngular } from '../solver/xpbd.js';

const rA = new Vec3();
const rB = new Vec3();
const dx = new Vec3();
const dth = new Vec3();
const QA = new Quat();
const QB = new Quat();
const Qerr = new Quat();
const Q = new Quat();
const a1 = new Vec3();
const a2 = new Vec3();
const b1 = new Vec3();
const b2 = new Vec3();
const X = new Vec3(1, 0, 0);
const Y = new Vec3(0, 1, 0);

/** Rotation taking +X onto unit axis `a` (shortest arc). */
function frameForAxis(a) {
  const q = new Quat();
  const c = X.dot(a);
  if (c < -0.999999) return q.setFromAxisAngle(Y, Math.PI);
  const axis = new Vec3().crossVectors(X, a);
  return q.set(axis.x, axis.y, axis.z, 1 + c).normalize();
}

/**
 * Joint between two bodies, built from XPBD positional and angular constraints:
 *   fixed: point lock + orientation lock (angularCompliance 0 = weld)
 *   ball:  point lock + optional orientation drive (angularCompliance = drive softness, Infinity = free)
 *   hinge: point lock + axis alignment + optional angle drive (angularCompliance) + limits
 *
 * There is no separate joint damping: applied as a velocity kick it fought contacts and pumped
 * energy into resting debris; XPBD's implicit integration already damps the drives.
 * The rest pose is the pose at creation. Joints report the force / torque they carried in the
 * last substep and break when those exceed breakForce / breakTorque.
 */
export class Joint {
  constructor(bodyA, bodyB, {
    kind = 'fixed',
    anchor,
    axis = [1, 0, 0],
    compliance = 0,
    angularCompliance = 0,
    limits = null,
    driveAngle = 0,
    breakForce = Infinity,
    breakTorque = Infinity,
    collide = false,
    name = '',
    userData = null,
  }) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.kind = kind;
    this.compliance = compliance;
    this.angularCompliance = angularCompliance;
    this.limits = limits;
    this.driveAngle = driveAngle;
    this.breakForce = breakForce;
    this.breakTorque = breakTorque;
    this.collide = collide;
    this.name = name;
    this.userData = userData;
    this.broken = false;
    this.moved = false; // setTargetB since the GPU engine last sent it
    this.force = 0;
    this.torque = 0;

    const p = Vec3.from(anchor);
    this.localA = new Vec3().subVectors(p, bodyA.position).applyQuatInverse(bodyA.quaternion);
    this.localB = new Vec3().subVectors(p, bodyB.position).applyQuatInverse(bodyB.quaternion);
    // Joint frame (X = hinge axis) expressed in each body, so both coincide in the rest pose
    const world = frameForAxis(Vec3.from(axis).normalize());
    this.frameA = new Quat().multiplyQuats(bodyA.quaternion.clone().conjugate(), world);
    this.frameB = new Quat().multiplyQuats(bodyB.quaternion.clone().conjugate(), world);
    this.lambdaPoint = new Vec3();
    this.lambdaRot = new Vec3();
    this.lambda = new Float64Array(3); // hinge: align, drive, limit
  }

  /** Re-captures the current relative pose as rest pose (e.g. after posing a rig). */
  setRestPose() {
    const world = new Quat().multiplyQuats(this.bodyA.quaternion, this.frameA);
    const anchor = this.worldAnchorA(new Vec3());
    this.localB.subVectors(anchor, this.bodyB.position).applyQuatInverse(this.bodyB.quaternion);
    this.frameB.multiplyQuats(this.bodyB.quaternion.clone().conjugate(), world);
  }

  /**
   * Moves where bodyA is held: its anchor at `position` (world) and bodyA turned to `quaternion`,
   * as seen from bodyB's current pose (a joint to a static body becomes a moving target). Wakes
   * bodyA; `moved` tells the GPU engine to send the joint again.
   */
  setTargetB(position, quaternion) {
    const B = this.bodyB;
    this.localB.subVectors(position, B.position).applyQuatInverse(B.quaternion);
    this.frameB.multiplyQuats(B.quaternion.clone().conjugate(), Q.multiplyQuats(quaternion, this.frameA));
    this.moved = true;
    this.bodyA.wake(); // asleep, it would not follow
  }

  worldAnchorA(out) {
    return out.copy(this.localA).applyQuat(this.bodyA.quaternion).add(this.bodyA.position);
  }

  worldAnchorB(out) {
    return out.copy(this.localB).applyQuat(this.bodyB.quaternion).add(this.bodyB.position);
  }

  begin() {
    this.lambdaPoint.set(0, 0, 0);
    this.lambdaRot.set(0, 0, 0);
    this.lambda.fill(0);
  }

  solvePosition(h) {
    const A = this.bodyA;
    const B = this.bodyB;
    const L = this.lambda;

    if (this.kind === 'fixed' || (this.kind === 'ball' && Number.isFinite(this.angularCompliance))) {
      QA.multiplyQuats(A.quaternion, this.frameA);
      QB.multiplyQuats(B.quaternion, this.frameB);
      Qerr.multiplyQuats(QB, QA.conjugate()).toRotationVector(dth);
      solveRotation(A, B, dth, this.angularCompliance, h, this.lambdaRot);
    } else if (this.kind === 'hinge') {
      QA.multiplyQuats(A.quaternion, this.frameA);
      QB.multiplyQuats(B.quaternion, this.frameB);
      a1.copy(X).applyQuat(QA);
      a2.copy(X).applyQuat(QB);
      L[0] += solveAngular(A, B, dth.crossVectors(a1, a2), 0, h, L[0]);

      QA.multiplyQuats(A.quaternion, this.frameA);
      QB.multiplyQuats(B.quaternion, this.frameB);
      a1.copy(X).applyQuat(QA);
      b1.copy(Y).applyQuat(QA);
      b2.copy(Y).applyQuat(QB);
      const angle = Math.atan2(dth.crossVectors(b1, b2).dot(a1), b1.dot(b2));
      if (Number.isFinite(this.angularCompliance)) {
        L[1] += solveAngular(A, B, dth.copy(a1).scale(angle - this.driveAngle), this.angularCompliance, h, L[1]);
      }
      if (this.limits) {
        const [lo, hi] = this.limits;
        const target = angle < lo ? lo : angle > hi ? hi : angle;
        if (target !== angle) L[2] += solveAngular(A, B, dth.copy(a1).scale(angle - target), 0, h, L[2]);
      }
    }

    // Point lock last, so the anchor is exact after the angular corrections moved the arms
    rA.copy(this.localA).applyQuat(A.quaternion);
    rB.copy(this.localB).applyQuat(B.quaternion);
    dx.copy(B.position).add(rB).sub(rA).sub(A.position);
    solvePoint(A, B, rA, rB, dx, this.compliance, h, this.lambdaPoint);
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  solveVelocity(h) {
    // nothing at velocity level (see class comment)
  }

  /**
   * Updates readouts; returns true if the joint should break. Structural load (point lock, weld,
   * hinge alignment and limits) can break a joint; drive torque cannot, an overloaded drive yields.
   */
  end(h) {
    const L = this.lambda;
    const inv = 1 / (h * h);
    const rot = this.lambdaRot.length() * inv;
    this.force = this.lambdaPoint.length() * inv;
    this.driveTorque = this.kind === 'ball' ? rot : Math.abs(L[1]) * inv;
    this.torque = (this.kind === 'fixed' ? rot : 0) + (Math.abs(L[0]) + Math.abs(L[2])) * inv;
    return this.force > this.breakForce || this.torque > this.breakTorque;
  }
}
