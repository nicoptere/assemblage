/**
 * XPBD building blocks (Müller et al. 2020, "Detailed Rigid Body Simulation with Extended
 * Position Based Dynamics"). Every constraint in the engine is expressed with these calls.
 *
 * Sign convention: a correction `dx` / `dtheta` is the displacement / rotation that body A should
 * undergo relative to body B. B may be null (anchored to the world). Lambdas accumulate positive.
 */
import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';

const _n = new Vec3();
const _p = new Vec3();
const _rhs = new Vec3();
const _K = new Mat3();
const _J = new Mat3();

/**
 * Vector point lock: solves pA - pB = 0 in all three directions at once with the full 3x3
 * effective mass  K = sum (1/m E + S^T I^-1 S). A scalar solve along the error direction is only
 * exact when K is isotropic; for light bodies far from their anchor (thin plates, pendulum bobs)
 * it over-rotates and goes unstable. `lambda` is a Vec3, `dx` the displacement A needs.
 */
export function solvePoint(bA, bB, rA, rB, dx, compliance, h, lambda, maxForce = Infinity) {
  if (dx.lengthSq() < 1e-24 && compliance === 0) return;
  _K.zero();
  if (bA.invMass > 0) _K.addArmInertia(bA.invInertiaWorld(_J), rA).addDiagonal(bA.invMass);
  if (bB && bB.invMass > 0) _K.addArmInertia(bB.invInertiaWorld(_J), rB).addDiagonal(bB.invMass);
  const alpha = compliance / (h * h);
  _K.addDiagonal(alpha);
  _rhs.copy(dx).addScaled(lambda, -alpha);
  if (!_K.solve(_rhs, _p)) return;
  if (Number.isFinite(maxForce)) {
    // cap the force (lambda / h^2), not the error: the pull saturates instead of going soft
    _rhs.copy(lambda).add(_p);
    const cap = maxForce * h * h;
    const l = _rhs.length();
    if (l > cap) _p.copy(_rhs).scale(cap / l).sub(lambda);
  }
  lambda.add(_p);
  applyPositional(bA, bB, rA, rB, _p);
}

/** Vector orientation lock / drive: rotation error dtheta (A relative to B), full 3x3 solve. */
export function solveRotation(bA, bB, dtheta, compliance, h, lambda) {
  _K.zero();
  if (bA.invMass > 0) _K.add(bA.invInertiaWorld(_J));
  if (bB && bB.invMass > 0) _K.add(bB.invInertiaWorld(_J));
  const alpha = compliance / (h * h);
  _K.addDiagonal(alpha);
  _rhs.copy(dtheta).addScaled(lambda, -alpha);
  if (!_K.solve(_rhs, _p)) return;
  lambda.add(_p);
  bA.applyAngularCorrection(_p, 1);
  if (bB) bB.applyAngularCorrection(_p, -1);
}

/** Δλ for a positional constraint of error c along unit n at world arms rA, rB. */
export function positionalDelta(bA, bB, rA, rB, n, c, compliance, h, lambda) {
  const w = bA.pointInvMass(rA, n) + (bB ? bB.pointInvMass(rB, n) : 0);
  const alpha = compliance / (h * h);
  if (w + alpha === 0) return 0;
  return (c - alpha * lambda) / (w + alpha);
}

export function applyPositional(bA, bB, rA, rB, p) {
  bA.applyPositionCorrection(p, rA, 1);
  if (bB) bB.applyPositionCorrection(p, rB, -1);
}

/** Solves a rotation error dtheta (world rotation vector, applied to A relative to B). Returns Δλ. */
export function solveAngular(bA, bB, dtheta, compliance, h, lambda) {
  const c = dtheta.length();
  if (c < 1e-12) return 0;
  _n.copy(dtheta).scale(1 / c);
  const w = bA.angularInvMass(_n) + (bB ? bB.angularInvMass(_n) : 0);
  const alpha = compliance / (h * h);
  if (w + alpha === 0) return 0;
  const dl = (c - alpha * lambda) / (w + alpha);
  _p.copy(_n).scale(dl);
  bA.applyAngularCorrection(_p, 1);
  if (bB) bB.applyAngularCorrection(_p, -1);
  return dl;
}

/** Applies a velocity change dv to the relative velocity of two material points. */
export function applyRelativeVelocityChange(bA, bB, rA, rB, dv) {
  const c = dv.length();
  if (c < 1e-12) return;
  _n.copy(dv).scale(1 / c);
  const w = bA.pointInvMass(rA, _n) + (bB ? bB.pointInvMass(rB, _n) : 0);
  if (w === 0) return;
  _p.copy(dv).scale(1 / w);
  bA.applyVelocityImpulse(_p, rA, 1);
  if (bB) bB.applyVelocityImpulse(_p, rB, -1);
}

/** Applies a change dw to the relative angular velocity of two bodies. */
export function applyRelativeAngularVelocityChange(bA, bB, dw) {
  const c = dw.length();
  if (c < 1e-12) return;
  _n.copy(dw).scale(1 / c);
  const w = bA.angularInvMass(_n) + (bB ? bB.angularInvMass(_n) : 0);
  if (w === 0) return;
  _p.copy(dw).scale(1 / w);
  bA.applyAngularVelocityImpulse(_p, 1);
  if (bB) bB.applyAngularVelocityImpulse(_p, -1);
}
