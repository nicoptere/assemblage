import { Backend } from '../world/Backend.js';
import { Broadphase } from './Broadphase.js';
import { Narrowphase } from './Narrowphase.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The reference backend: XPBD with substeps (one solver iteration per substep), on one CPU
 * thread. Runs everywhere (Node included) and is what other backends are checked against.
 *
 *   step(dt) = prepare  bounds, separated pairs released, broadphase (and sleepers it wakes)
 *              collide  SDF narrowphase, once per step: gather candidates, reduce to contacts
 *              solve    substeps: integrate -> positions (joints, user constraints, contacts)
 *                       -> velocities -> velocity solves -> joint breaks
 *              finish   breaks applied, sleep, time, stats, 'step' event
 * Each stage is a method, so a backend that ports a stage elsewhere (WebGPUBackend) extends
 * this one and overrides only that stage.
 */
export class CpuBackend extends Backend {
  constructor() {
    super();
    this.broadphase = new Broadphase();
    this.narrowphase = null;
    this.timing = { t0: 0, t1: 0, wait: 0 }; // wait: ms of the step spent idle, waiting for a device
  }

  get name() {
    return 'cpu';
  }

  attach(world) {
    this.narrowphase = new Narrowphase({
      maxContacts: world.maxContactsPerPair,
      maxSpeculative: world.maxSpeculativeContacts,
      margin: world.contactMargin,
      maxSweep: world.maxSweep,
    });
  }

  step(world, dt) {
    const pairs = this.prepare(world, dt);
    this.collide(world, pairs, dt);
    this.solve(world, dt);
    this.finish(world, dt, pairs);
  }

  penetration(a, b) {
    return this.narrowphase.penetration(a, b);
  }

  /** Where two bodies come closest, within `reach` (Narrowphase.closest). */
  closest(a, b, reach) {
    return this.narrowphase.closest(a, b, reach);
  }

  /** Bounds, released pairs, broadphase. Returns the candidate pairs [[a, b], ...]. */
  prepare(world, dt) {
    this.timing.t0 = now();
    for (const c of world.constraints) c.body.wake(); // a held body never sleeps
    for (const b of world.bodies) if (!b.sleeping) b.updateBounds(dt, world.contactMargin, world.maxSweep);
    world._releaseSeparated();
    let pairs = this.broadphase.findPairs(world.bodies, world.filter, world.contactMargin);
    // woken sleepers need their pairs with static bodies and other sleepers too: search again
    if (world._wakeTouched(pairs)) pairs = this.broadphase.findPairs(world.bodies, world.filter, world.contactMargin);
    return pairs;
  }

  /** Narrowphase: world.contacts from the pairs. */
  collide(world, pairs, dt) {
    const contacts = world.contacts;
    contacts.length = 0;
    this.narrowphase.begin();
    for (const [a, b] of pairs) this.narrowphase.collide(a, b, dt, contacts);
    CpuBackend.immovableLast(contacts);
  }

  /** The substeps. Returns the joints that broke. */
  solve(world, dt) {
    this.timing.t1 = now();
    const h = dt / world.substeps;
    const g = world.gravity;
    const gMag = g.length();
    const { constraints, bodies, contacts } = world;
    const joints = world.joints.filter((j) => j.bodyA.invMass > 0 || j.bodyB?.invMass > 0);
    const broken = new Set();
    for (let s = 0; s < world.substeps; s++) {
      for (const c of contacts) c.begin();
      for (const j of joints) j.begin();
      for (const c of constraints) c.begin();
      for (const b of bodies) b.integrate(h, g, world.maxSpeed, world.maxAngularSpeed, world.restSpeed, world.restDamping);

      for (const j of joints) j.solvePosition(h);
      for (const c of constraints) c.solvePosition(h);
      for (const c of contacts) c.solvePosition(h, world.maxDepenetrationSpeed);

      for (const b of bodies) b.updateVelocities(h);

      for (const c of contacts) c.solveVelocity(h, gMag);
      for (const j of joints) j.solveVelocity(h);
      for (const c of constraints) c.solveVelocity(h);

      for (const j of joints) if (j.end(h)) broken.add(j);
      for (const c of constraints) c.end(h);
    }
    this._broken = broken;
  }

  finish(world, dt, pairs) {
    world._applyBreaks(this._broken);
    world._updateSleep(dt);
    world.time += dt;
    world.frame++;
    const t2 = now();
    const { t0, t1, wait } = this.timing;
    Object.assign(world.stats, {
      backend: this.name,
      pairs: pairs.length,
      contacts: world.contacts.length,
      collideMs: t1 - t0,
      solveMs: t2 - t1,
      stepMs: t2 - t0,
      waitMs: wait,
      contactsStep: world.frame, // the step world.contacts belong to
    });
    world.emit('step', world.stats);
  }

  /** Contacts against immovable bodies (ground, walls, sleepers) last: they get the final say in each substep. */
  static immovableLast(contacts) {
    let n = 0;
    const fixed = [];
    for (const c of contacts) {
      if (c.bodyA.invMass > 0 && c.bodyB.invMass > 0) contacts[n++] = c;
      else fixed.push(c);
    }
    for (const c of fixed) contacts[n++] = c;
  }
}
