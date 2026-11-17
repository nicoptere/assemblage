import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat3 } from '../math/Mat3.js';
import { Aabb } from '../math/Aabb.js';

const _t = new Vec3();
const _u = new Vec3();
const _q = new Quat();

let nextId = 0;

/**
 * A rigid body. Its frame is centred on the centre of mass; the shape lives in its own space,
 * offset by `com` (shape-space position of the centre of mass):  bodyLocal = shapeLocal - com.
 *
 * type: 'dynamic' (simulated), 'kinematic' (moves by its velocity, infinite mass), 'static'.
 * `position` / `quaternion` passed to the constructor place the SHAPE origin, so assets authored
 * in model space can be spawned where they were modelled.
 *
 * Sleeping: a dynamic body at rest can be frozen with sleep(). It keeps its place in the world
 * and still collides, but as an immovable obstacle (inverse mass 0) that costs nothing to
 * simulate. wake() restores it together with every body that fell asleep with it (its island).
 * Rest is judged by drift from a reference pose, not by speed: XPBD contacts make light parts
 * rattle in place at a few cm/s while they go nowhere.
 */
export class RigidBody {
  constructor({
    shape,
    type = 'dynamic',
    position = [0, 0, 0],
    quaternion = [0, 0, 0, 1],
    velocity = [0, 0, 0],
    angularVelocity = [0, 0, 0],
    density = 1000,
    friction = 0.6,
    restitution = 0.1,
    rollingFriction = 0.003,
    linearDamping = 0.02,
    angularDamping = 0.05,
    ccd = false,
    name = '',
    userData = null,
  }) {
    this.id = nextId++;
    this.name = name;
    this.userData = userData;
    this.shape = shape;
    this.type = type;
    this.friction = friction;
    this.restitution = restitution;
    this.rollingFriction = rollingFriction; // m: resisting torque = rollingFriction x normal force
    this.linearDamping = linearDamping;
    this.angularDamping = angularDamping;
    this.ccd = ccd; // fast body (bullet): keeps its full swept collision margin

    this.quaternion = Quat.from(quaternion).normalize();
    this.velocity = Vec3.from(velocity);
    this.angularVelocity = Vec3.from(angularVelocity);
    this.invInertiaLocal = new Mat3();
    this.com = new Vec3();
    this.mass = Infinity;
    this.invMass = 0;
    if (type === 'dynamic') this.setMassProperties(shape.massProperties(density));

    this.position = Vec3.from(position).add(_t.copy(this.com).applyQuat(this.quaternion));
    this.prevPosition = this.position.clone();
    this.prevQuaternion = this.quaternion.clone();
    this.rotation = new Mat3().setFromQuat(this.quaternion);
    this.aabb = new Aabb();
    this.sweep = 0;
    this.sweepShortfall = 0;
    this.pushed = 0; // travel of the fastest body it may touch this step (set by the broadphase)
    this.sampleFraction = 1; // share of the shape's samples in use (see setSampleFraction)
    this._updateSamples();

    this.sleeping = false;
    this.stillTime = 0; // seconds spent within the world's sleep tolerance of the rest pose
    this.awakeTime = 0; // seconds since it last woke (or was made)
    this.moved = false; // left its rest pose during the last step (its rest timer starts again)
    this.stirs = false; // ...and faster than the world's wakeSpeed: wakes the sleepers it touches
    this.island = null; // bodies that fell asleep together, and wake together
    this._awakeInvMass = 0;
    this._restPosition = this.position.clone();
    this._restQuaternion = this.quaternion.clone();
  }

  get isDynamic() {
    return this.type === 'dynamic';
  }

  /** Dynamic and not sleeping: actually simulated this step. */
  get isAwake() {
    return this.type === 'dynamic' && !this.sleeping;
  }

  /** Upper bound of the speed of any point of the body (m/s). */
  motionSpeed() {
    return this.velocity.length() + this.angularVelocity.length() * this.boundingRadius;
  }

  // ---- sleeping ----------------------------------------------------------------------------

  /** Takes the current pose as the reference for restDrift(). */
  markRest() {
    this._restPosition.copy(this.position);
    this._restQuaternion.copy(this.quaternion);
  }

  /** Upper bound of how far any point of the body moved since markRest() (m). */
  restDrift() {
    _q.copy(this._restQuaternion).conjugate();
    _q.multiplyQuats(this.quaternion, _q);
    const s = Math.min(1, Math.hypot(_q.x, _q.y, _q.z));
    return _t.subVectors(this.position, this._restPosition).length() + 2 * Math.asin(s) * this.boundingRadius;
  }

  /** Freezes a dynamic body in place; it stays an obstacle for the others. */
  sleep() {
    if (!this.isAwake) return;
    this.sleeping = true;
    this._awakeInvMass = this.invMass;
    this.invMass = 0; // every solver path already treats invMass 0 as immovable
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  /** Wakes the body and its island; on an awake body, restarts its rest timer. */
  wake() {
    if (!this.sleeping) {
      this.stillTime = 0;
      this.markRest();
      return;
    }
    for (const b of this.island ?? [this]) b._wakeSelf();
  }

  _wakeSelf() {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.invMass = this._awakeInvMass;
    this.stillTime = 0;
    this.awakeTime = 0;
    this.moved = false;
    this.stirs = false;
    this.island = null;
    this.markRest();
  }

  setMassProperties({ mass, com, inertia }) {
    if (this.sleeping) this.wake();
    this.mass = mass;
    this.invMass = 1 / mass;
    this.com = com.clone();
    this.invInertiaLocal = inertia.clone().invert();
    if (this.localSamples) this._updateSamples();
  }

  /**
   * Collides with only the first `fraction` of the shape's samples: an evenly spread subset (see
   * Shape.samplesFor). Fewer samples are cheaper, but contacts are found more coarsely, so thin
   * features sink in further before they are caught.
   */
  setSampleFraction(fraction) {
    if (fraction === this.sampleFraction) return;
    this.sampleFraction = fraction;
    this._updateSamples();
    this.wake();
  }

  /** Body-local samples (centred on the centre of mass) and bounding radius. A new array each time, so backends can cache per array. */
  _updateSamples() {
    this.localSamples = this._centredSamples();
    this.boundingRadius = this._boundingRadius();
  }

  _centredSamples() {
    const s = this.shape.samplesFor(this.sampleFraction);
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 3) {
      out[i] = s[i] - this.com.x;
      out[i + 1] = s[i + 1] - this.com.y;
      out[i + 2] = s[i + 2] - this.com.z;
    }
    return out;
  }

  _boundingRadius() {
    if (this.shape.infinite) return Infinity;
    const { min, max } = this.shape.localAabb;
    let r = 0;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      r = Math.max(r, Math.hypot(x - this.com.x, y - this.com.y, z - this.com.z));
    }
    return r;
  }

  /** World position of the shape origin (what a renderer attaches meshes to). */
  getOrigin(out = new Vec3()) {
    return out.copy(this.com).applyQuat(this.quaternion).negate().add(this.position);
  }

  /** Places the shape origin at `position`. */
  setOrigin(position, quaternion = this.quaternion) {
    this.wake();
    this.quaternion.copy(quaternion).normalize();
    this.position.copy(this.com).applyQuat(this.quaternion).add(position);
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    this.rotation.setFromQuat(this.quaternion);
    return this;
  }

  // ---- XPBD integration --------------------------------------------------------------------

  /** One substep's motion; below `restSpeed` (any point), velocities are damped by `restDamping` (1/s) too. */
  integrate(h, gravity, maxSpeed, maxAngularSpeed, restSpeed = 0, restDamping = 0) {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    if (this.type === 'static' || this.sleeping) return;
    if (this.type === 'dynamic') {
      if (restDamping > 0 && this.motionSpeed() < restSpeed) {
        const k = Math.max(0, 1 - restDamping * h);
        this.velocity.scale(k);
        this.angularVelocity.scale(k);
      }
      this.velocity.addScaled(gravity, h);
      this.velocity.scale(Math.max(0, 1 - this.linearDamping * h));
      this.angularVelocity.scale(Math.max(0, 1 - this.angularDamping * h));
      const v = this.velocity.length();
      if (v > maxSpeed) this.velocity.scale(maxSpeed / v);
      const w = this.angularVelocity.length();
      if (w > maxAngularSpeed) this.angularVelocity.scale(maxAngularSpeed / w);
    }
    this.position.addScaled(this.velocity, h);
    this.quaternion.addRotation(this.angularVelocity, h);
  }

  updateVelocities(h) {
    if (!this.isAwake) return;
    this.velocity.subVectors(this.position, this.prevPosition).scale(1 / h);
    const q = this.quaternion;
    const p = this.prevQuaternion;
    // dq = q * conj(p)
    const dx = q.w * -p.x + q.x * p.w + q.y * -p.z - q.z * -p.y;
    const dy = q.w * -p.y - q.x * -p.z + q.y * p.w + q.z * -p.x;
    const dz = q.w * -p.z + q.x * -p.y - q.y * -p.x + q.z * p.w;
    const dw = q.w * p.w + q.x * p.x + q.y * p.y + q.z * p.z;
    const s = (dw >= 0 ? 2 : -2) / h;
    this.angularVelocity.set(dx * s, dy * s, dz * s);
  }

  // ---- inverse mass queries & corrections (all world space) -------------------------------

  /** out = I^-1 v (world inverse inertia). */
  invInertiaMul(v, out) {
    if (this.invMass === 0) return out.set(0, 0, 0);
    out.copy(v).applyQuatInverse(this.quaternion);
    this.invInertiaLocal.mulVec(out, out);
    return out.applyQuat(this.quaternion);
  }

  /** World inverse inertia tensor (zero for static / kinematic bodies). */
  invInertiaWorld(out) {
    return this.invMass === 0 ? out.zero() : out.setRotated(this.invInertiaLocal, this.quaternion);
  }

  /** Inverse mass seen at arm r along unit direction n. */
  pointInvMass(r, n) {
    if (this.invMass === 0) return 0;
    _t.crossVectors(r, n);
    return this.invMass + _t.dot(this.invInertiaMul(_t, _u));
  }

  /** Inverse rotational mass about unit axis n. */
  angularInvMass(n) {
    if (this.invMass === 0) return 0;
    return n.dot(this.invInertiaMul(n, _u));
  }

  /** Positional correction p (world) applied at arm r, with sign +1 / -1. */
  applyPositionCorrection(p, r, sign) {
    if (this.invMass === 0) return;
    this.position.addScaled(p, this.invMass * sign);
    _t.crossVectors(r, p);
    this.quaternion.addRotation(this.invInertiaMul(_t, _u), sign);
  }

  applyAngularCorrection(p, sign) {
    if (this.invMass === 0) return;
    this.quaternion.addRotation(this.invInertiaMul(p, _u), sign);
  }

  applyVelocityImpulse(p, r, sign) {
    if (this.invMass === 0) return;
    this.velocity.addScaled(p, this.invMass * sign);
    _t.crossVectors(r, p);
    this.angularVelocity.addScaled(this.invInertiaMul(_t, _u), sign);
  }

  applyAngularVelocityImpulse(p, sign) {
    if (this.invMass === 0) return;
    this.angularVelocity.addScaled(this.invInertiaMul(p, _u), sign);
  }

  /** Velocity of the material point at world arm r. */
  velocityAt(r, out) {
    return out.crossVectors(this.angularVelocity, r).add(this.velocity);
  }

  // ---- impulses for users (shots, explosions) ---------------------------------------------

  applyImpulse(impulse, worldPoint) {
    this.wake();
    _t.subVectors(worldPoint, this.position);
    this.applyVelocityImpulse(Vec3.from(impulse), _t, 1);
  }

  // ---- bounds ------------------------------------------------------------------------------

  /** Swept world box for this step; non-CCD bodies sweep at most `maxSweep`. Call it once more
   *  right after sleep() (dt 0) to tighten the box: sleepers do not move, so it stays valid. */
  updateBounds(dt, margin, maxSweep = Infinity) {
    this.rotation.setFromQuat(this.quaternion);
    if (this.shape.infinite) return;
    this.aabb.setTransformed(this.shape.localAabb, this.rotation, this.position, this.com);
    if (this.type !== 'static') {
      const limit = this.ccd ? Infinity : maxSweep;
      _t.copy(this.velocity).scale(dt);
      const l = _t.length();
      const spin = this.angularVelocity.length() * this.boundingRadius * dt;
      if (l > limit) _t.scale(limit / l);
      this.aabb.sweep(_t);
      this.aabb.expand(margin + Math.min(spin, limit));
      this.sweep = l + spin; // how far any point of it can travel this step
      // how much of that the box leaves out; half-spaces (walls) add it back
      this.sweepShortfall = Math.max(0, l - limit) + Math.max(0, spin - limit);
    } else {
      this.aabb.expand(margin);
    }
  }
}
