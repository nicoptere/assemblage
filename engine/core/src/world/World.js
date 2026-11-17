import { Vec3 } from '../math/Vec3.js';
import { CollisionFilter } from './CollisionFilter.js';
import { raycast } from './raycast.js';
import { Emitter } from './Emitter.js';
import { CpuBackend } from '../cpu/CpuBackend.js';

/**
 * The simulation's state and API: bodies, joints, user constraints, contacts, collision filter,
 * sleeping. A backend runs the steps (see Backend): CpuBackend by default, WebGPUBackend from
 * '@sdfphys/core/webgpu'. Switching backend keeps everything (setBackend).
 *
 *   step(dt) / await stepAsync(dt):  bounds -> broadphase -> SDF narrowphase (once) -> substeps
 *              (integrate, positions, velocities, joint breaks) -> sleep (CpuBackend has the detail)
 *   sleep:     islands (bodies linked by joints) whose bodies stayed within `sleepTolerance` of a
 *              rest pose for `sleepTime` freeze (all of them, or, once all have been awake for
 *              `sleepPatience`, `sleepQuorum` of them while the others are slower than
 *              `restSpeed`: a slow motion only starting goes on); a body moving faster than `wakeSpeed` that
 *              reaches a sleeper, a new or removed joint, a user constraint, an impulse or a
 *              removed neighbour wakes it. Below `restSpeed`, bodies are damped by `restDamping`
 *              (1/s) on top of their own damping: a pile's last jitter dies out and it falls asleep.
 *              Beyond `maxAwake` bodies, the calmest islands (none of their points faster than
 *              `restSpeed`, none of their bodies off its rest pose for 0.1 s) are put to sleep at
 *              once, the calmest first: a cap on the work that never stops anything in flight.
 *
 * Events: 'jointBreak' { joint }, 'jointRemoved' { joint } (breaks included), 'step' { stats }.
 */
export class World extends Emitter {
  constructor({
    gravity = [0, -9.81, 0],
    substeps = 16,
    contactMargin = 0.004,
    maxContactsPerPair = 32, // both directions pooled (see Narrowphase)
    maxSpeculativeContacts = 4,
    maxSweep = 0.05,
    maxDepenetrationSpeed = 0.25,
    maxSpeed = 200,
    maxAngularSpeed = 120,
    separationTolerance = 0.0015,
    allowSleep = true,
    sleepTolerance = 0.01,
    sleepTime = 0.5,
    wakeSpeed = 0.5,
    restSpeed = 0.15,
    restDamping = 5,
    sleepQuorum = 0.9,
    sleepPatience = 2,
    maxAwake = Infinity,
    samplePrecision = 1,
    backend = new CpuBackend(),
  } = {}) {
    super();
    this.gravity = Vec3.from(gravity);
    this.substeps = substeps;
    this._samplePrecision = samplePrecision;
    this.contactMargin = contactMargin;
    this.maxContactsPerPair = maxContactsPerPair; // both directions pooled (see Narrowphase)
    this.maxSpeculativeContacts = maxSpeculativeContacts;
    this.maxSweep = maxSweep;
    this.maxDepenetrationSpeed = maxDepenetrationSpeed;
    this.maxSpeed = maxSpeed;
    this.maxAngularSpeed = maxAngularSpeed;
    this.separationTolerance = separationTolerance;
    this.sleepTolerance = sleepTolerance; // m, drift of any point of a body over sleepTime
    this.sleepTime = sleepTime; // s
    this.wakeSpeed = wakeSpeed; // m/s: slower bodies (any of their points) do not wake the sleepers they touch
    this.restSpeed = restSpeed; // m/s: below it (any point of a body), restDamping applies
    this.restDamping = restDamping; // 1/s
    this.sleepQuorum = sleepQuorum; // share of an island's bodies that must be still for it to sleep, the others slower than restSpeed...
    this.sleepPatience = sleepPatience; // s: ...once all of them have been awake that long (a motion only starting is let through)
    this.maxAwake = maxAwake; // awake bodies beyond which the calmest islands are put to sleep
    this._allowSleep = allowSleep;

    this.bodies = [];
    this.joints = [];
    this.constraints = [];
    this.contacts = [];
    this.filter = new CollisionFilter();
    this.time = 0;
    this.frame = 0;
    this.stats = { backend: backend.name, pairs: 0, contacts: 0, sleeping: 0, collideMs: 0, solveMs: 0, stepMs: 0, waitMs: 0 };
    this._stepping = false;
    this.backend = backend;
    backend.attach(this);
  }

  /**
   * Hands the stepping to another backend (initialised first), between two steps; the state stays.
   * Returns the backend.
   */
  async setBackend(backend) {
    if (this._stepping) throw new Error('World.setBackend: a step is running');
    await backend.init();
    if (backend === this.backend) return backend;
    this.backend.detach(this);
    this.backend = backend;
    // the timings are the new engine's from now on (WebGPU's GPU times come later, or never without timestamp queries)
    Object.assign(this.stats, { backend: backend.name, collideMs: 0, solveMs: 0, stepMs: 0, waitMs: 0, gpuMs: undefined });
    backend.attach(this);
    return backend;
  }

  /** Share of every body's surface samples used for collision, 0..1 (see RigidBody.setSampleFraction). */
  get samplePrecision() {
    return this._samplePrecision;
  }

  set samplePrecision(fraction) {
    this._samplePrecision = fraction;
    for (const b of this.bodies) b.setSampleFraction(fraction);
  }

  get allowSleep() {
    return this._allowSleep;
  }

  set allowSleep(on) {
    this._allowSleep = on;
    if (!on) this.wakeAll();
  }

  wakeAll() {
    for (const b of this.bodies) b.wake();
  }

  // ---- scene management ---------------------------------------------------------------------

  addBody(body) {
    body.setSampleFraction(this._samplePrecision);
    this.bodies.push(body);
    body.updateBounds(0, this.contactMargin);
    return body;
  }

  removeBody(body) {
    const i = this.bodies.indexOf(body);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    this._wakeAround(body); // whatever rested on it must fall
    for (const j of [...this.joints]) if (j.bodyA === body || j.bodyB === body) this.removeJoint(j);
    this.constraints = this.constraints.filter((c) => c.body !== body);
    this.contacts = this.contacts.filter((c) => c.bodyA !== body && c.bodyB !== body);
    this.filter.forgetBody(body);
  }

  addJoint(joint) {
    joint.removed = false;
    joint.bodyA.wake();
    joint.bodyB?.wake();
    this.joints.push(joint);
    if (!joint.collide) this.filter.ignore(joint.bodyA, joint.bodyB);
    return joint;
  }

  /** Removes a joint. The pair stays non-colliding until it separates, so nothing explodes. */
  removeJoint(joint) {
    const i = this.joints.indexOf(joint);
    if (i < 0) return;
    this.joints.splice(i, 1);
    joint.removed = true;
    joint.bodyA.wake();
    joint.bodyB?.wake();
    if (!joint.collide) {
      this.filter.unignore(joint.bodyA, joint.bodyB);
      this.filter.ignoreUntilSeparated(joint.bodyA, joint.bodyB);
    }
    this.emit('jointRemoved', { joint });
  }

  addConstraint(c) {
    c.body.wake();
    this.constraints.push(c);
    return c;
  }

  removeConstraint(c) {
    this.constraints = this.constraints.filter((x) => x !== c);
  }

  /** Excludes every currently interpenetrating pair among `bodies` until it separates. */
  ignoreOverlaps(bodies = this.bodies) {
    let n = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (!this.filter.canCollide(a, b) || !a.aabb.overlaps(b.aabb)) continue;
        if (this.backend.penetration(a, b) > this.separationTolerance) {
          this.filter.ignoreUntilSeparated(a, b);
          n++;
        }
      }
    }
    return n;
  }

  /** `body` and every dynamic body joined to it, directly or through others (a static anchor does not link). */
  connected(body) {
    const links = new Map();
    const link = (a, b) => (links.get(a) ?? links.set(a, []).get(a)).push(b);
    for (const j of this.joints) {
      if (!j.bodyA.isDynamic || !j.bodyB?.isDynamic) continue;
      link(j.bodyA, j.bodyB);
      link(j.bodyB, j.bodyA);
    }
    const piece = new Set([body]);
    const stack = [body];
    while (stack.length) {
      for (const o of links.get(stack.pop()) ?? []) {
        if (piece.has(o)) continue;
        piece.add(o);
        stack.push(o);
      }
    }
    return [...piece];
  }

  raycast(origin, direction, options) {
    return raycast(this.bodies, origin, direction, options);
  }

  // ---- simulation ---------------------------------------------------------------------------

  /** One step of `dt` seconds (synchronous backends; see stepAsync). */
  step(dt) {
    if (this.backend.async) throw new Error(`World.step: the ${this.backend.name} backend steps asynchronously, use await world.stepAsync(dt)`);
    this.backend.step(this, dt);
  }

  /** One step of `dt` seconds with any backend. One at a time. */
  async stepAsync(dt) {
    if (this._stepping) throw new Error('World.stepAsync: a step is already running');
    this._stepping = true;
    try {
      await this.backend.stepAsync(this, dt);
    } finally {
      this._stepping = false;
    }
  }

  /** Removes the joints that broke during a step and reports them. */
  _applyBreaks(broken) {
    for (const j of broken) {
      j.broken = true;
      this.removeJoint(j);
      this.emit('jointBreak', { joint: j });
    }
  }

  // ---- sleeping -----------------------------------------------------------------------------

  /**
   * Wakes sleepers whose box overlaps a body that is really moving (`stirs`: it just left its rest
   * pose, faster than `wakeSpeed`), or a moving kinematic. Settling neighbours that only rattle or
   * creep in place do not count, and a freshly woken body only spreads the wake once it moves.
   * Returns true if any woke.
   */
  _wakeTouched(pairs) {
    if (!this._allowSleep) return false;
    let woke = false;
    for (const [a, b] of pairs) {
      if (a.sleeping === b.sleeping) continue;
      const [sleeper, other] = a.sleeping ? [a, b] : [b, a];
      if (other.stirs || (other.type === 'kinematic' && other.motionSpeed() > 0)) {
        sleeper.wake();
        woke = true;
      }
    }
    return woke;
  }

  _wakeAround(body) {
    const touches = body.shape.infinite
      ? (b) => body.shape.touchesAabb(b.aabb, this.contactMargin)
      : (b) => body.aabb.overlaps(b.aabb);
    for (const b of this.bodies) if (b.sleeping && touches(b)) b.wake();
  }

  /**
   * Rest timers, then islands whose members have all rested long enough fall asleep; past
   * `maxAwake`, the calmest islands too.
   */
  _updateSleep(dt) {
    let ready = false;
    let sleeping = 0;
    let awake = 0;
    const held = this.constraints.length ? new Set(this.constraints.map((c) => c.body)) : null;
    for (const b of this.bodies) {
      if (b.sleeping) sleeping++;
      if (!b.isAwake) continue;
      awake++;
      b.awakeTime += dt;
      b.moved = b.restDrift() > this.sleepTolerance;
      // a body the user holds wakes what it pushes, however slowly
      b.stirs = b.moved && (b.motionSpeed() > this.wakeSpeed || !!held?.has(b));
      if (b.moved || !this._allowSleep) {
        b.markRest();
        b.stillTime = 0;
      } else {
        b.stillTime += dt;
        if (b.stillTime >= this.sleepTime) ready = true;
      }
    }
    if (ready) {
      for (const island of this._islands()) {
        let still = 0;
        let fastest = 0;
        let young = false;
        for (const b of island) {
          if (b.stillTime >= this.sleepTime) still++;
          else fastest = Math.max(fastest, b.motionSpeed());
          if (b.awakeTime < this.sleepPatience) young = true;
        }
        if (still < island.length && (young || still < this.sleepQuorum * island.length || fastest >= this.restSpeed)) continue;
        this._sleepIsland(island);
        sleeping += island.length;
        awake -= island.length;
      }
    }
    if (this._allowSleep && awake > this.maxAwake) {
      // the calmest islands first (their fastest point): slow, and none of their bodies has left its rest pose
      // for a while (not a part at the top of its flight); the ones held by the user never
      const calm = [];
      const settled = Math.min(0.1, this.sleepTime);
      for (const island of this._islands()) {
        let fastest = 0;
        for (const b of island) fastest = Math.max(fastest, held?.has(b) || b.stillTime < settled ? Infinity : b.motionSpeed());
        if (fastest < this.restSpeed) calm.push({ island, fastest });
      }
      calm.sort((a, b) => a.fastest - b.fastest);
      for (const { island } of calm) {
        if (awake <= this.maxAwake) break;
        this._sleepIsland(island);
        sleeping += island.length;
        awake -= island.length;
      }
    }
    this.stats.sleeping = sleeping;
  }

  _sleepIsland(island) {
    for (const b of island) {
      b.sleep();
      b.island = island;
      b.updateBounds(0, this.contactMargin);
    }
  }

  /**
   * Awake dynamic bodies grouped by joints (union-find): parts of one assembly sleep and wake as
   * one. Contacts do not link islands, so a pile settles piece by piece; a resting neighbour is
   * just an obstacle to a sleeper, and a fast one wakes it (_wakeTouched).
   */
  _islands() {
    const awake = this.bodies.filter((b) => b.isAwake);
    const index = new Map(awake.map((b, i) => [b, i]));
    const parent = awake.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const j of this.joints) {
      const a = index.get(j.bodyA);
      const b = j.bodyB ? index.get(j.bodyB) : undefined;
      if (a !== undefined && b !== undefined) parent[find(a)] = find(b);
    }
    const islands = new Map();
    awake.forEach((body, i) => {
      const r = find(i);
      if (!islands.has(r)) islands.set(r, []);
      islands.get(r).push(body);
    });
    return islands.values();
  }

  _releaseSeparated() {
    if (this.filter.pending.size === 0 || this.frame % 4 !== 0) return;
    for (const [, [a, b]] of this.filter.pending) {
      if (!a.aabb.overlaps(b.aabb) || this.backend.penetration(a, b) <= this.separationTolerance) {
        this.filter.release(a, b);
      }
    }
  }
}
