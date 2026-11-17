import { Joint, Quat } from '@sdfphys/core';

const smooth = (s) => s * s * (3 - 2 * s);
// welds a part takes at most, its closest neighbours': enough to hold it, and a bound on the joints
// one body has (the GPU solves those one after the other, and refuses a body with more than 256)
const MAX_WELDS = 16;

/**
 * Flies parts to the poses a fit chose and anchors them there, in mid-air, as the fit finds them:
 * add(move) takes a part as soon as its pose is known, close() says no more will come. Each part
 * leaves the simulation (its joints go), sets off at least `interval` seconds after the previous
 * one, travels for `flight` seconds along an arc (`arc` m high) while turning to its final
 * orientation, then comes back into the world at rest, welded to `anchor` (a static body) by a
 * joint breaking at `strength` N (and N m), so shots can knock it out. The fit places big parts
 * first, so the sculpture grows from its core outwards. Neighbours in the sculpture do not
 * collide while both are anchored (a fit lets parts overlap, and contacts fighting two rigid
 * anchors would break them); when an anchor goes, its part's pairs only resume once they have
 * come apart. A part landing on pile parts (the sculpture stands on the ground, where the pile
 * is) ignores them until they separate.
 * Once every part has landed, parts within `reach` of each other are welded together (joints
 * breaking at `weld` N and N m; 0: no welds) and the anchors go, but one per welded group: that of
 * its most central part on the floor, so the sculpture stands on the ground, held upright, and
 * comes apart where it is hit. `scale` multiplies both strengths (a big sculpture is heavier: see
 * setScale). Driven by simulation time.
 */
export class Rebuild {
  constructor(moves = [], { anchor, interval = 0.05, flight = 1.2, arc = 0.6, strength = 2000, weld = 1000, reach = 0.02, scale = 1 } = {}) {
    this.options = { anchor, interval, flight, arc, strength, weld, reach, scale };
    this.moves = [];
    this.bodies = new Set(); // every part of this build
    this.start = null;
    this.t = 0; // seconds since the first update
    this.lastStart = -Infinity;
    this.closed = false;
    this.arrived = [];
    this.anchors = [];
    this.welds = []; // joints between parts, made once every part has landed
    this.welded = false;
    this.world = null;
    this.neighbours = new Map(); // anchored body -> bodies it ignores
    this._q = new Quat();
    for (const m of moves) this.add(m);
    if (moves.length) this.close();
  }

  /** A part and its pose ({ body, position, quaternion }), to fly there next. */
  add(move) {
    const startAt = Math.max(this.t, this.lastStart + this.options.interval);
    this.lastStart = startAt;
    this.moves.push({ ...move, startAt, state: 'waiting' });
    this.bodies.add(move.body);
  }

  /** No more parts will be added (the fit ended or stopped). */
  close() {
    this.closed = true;
    if (this.done && this.world) this._weld(this.world);
  }

  get total() {
    return this.moves.length;
  }

  get done() {
    return this.closed && this.arrived.length >= this.moves.length;
  }

  update(world) {
    if (this.start === null) {
      this.world = world;
      this.start = world.time;
      world.on('jointRemoved', ({ joint }) => this._unanchored(world, joint));
    }
    const t = (this.t = world.time - this.start);
    for (const m of this.moves) {
      if (m.state === 'arrived' || t < m.startAt) continue;
      if (m.state === 'waiting') this._lift(world, m);
      const s = Math.min(1, (t - m.startAt) / this.options.flight);
      const e = smooth(s);
      m.body.position.copy(m.from).scale(1 - e).addScaled(m.position, e);
      m.body.position.y += this.options.arc * Math.sin(Math.PI * s);
      m.body.quaternion.copy(this._q.slerpQuats(m.fromQ, m.quaternion, e));
      if (s >= 1) this._land(world, m);
    }
  }

  _lift(world, m) {
    const b = m.body;
    b.wake();
    world.removeBody(b);
    m.from = b.position.clone();
    m.fromQ = b.quaternion.clone();
    m.state = 'flying';
  }

  _land(world, m) {
    const b = m.body;
    b.position.copy(m.position);
    b.quaternion.copy(m.quaternion);
    b.prevPosition.copy(b.position);
    b.prevQuaternion.copy(b.quaternion);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    world.addBody(b);
    const strength = this.options.strength * this.options.scale;
    this.anchors.push(world.addJoint(new Joint(b, this.options.anchor, {
      kind: 'fixed', anchor: b.position.clone(), collide: true, breakForce: strength, breakTorque: strength, name: 'rebuild anchor',
    })));
    this.neighbours.set(b, []);
    for (const o of this.arrived) {
      if (!this.neighbours.has(o) || !o.aabb.overlaps(b.aabb)) continue;
      world.filter.ignore(b, o);
      this.neighbours.get(b).push(o);
      this.neighbours.get(o).push(b);
    }
    // parts still lying where the sculpture stands pass through it until they come apart, rather
    // than being shoved out against its rigid anchors
    for (const o of world.bodies) {
      if (o === b || o.shape.infinite || this.neighbours.has(o) || !o.aabb.overlaps(b.aabb)) continue;
      if (world.backend.penetration(b, o) > world.separationTolerance) world.filter.ignoreUntilSeparated(b, o);
    }
    this.arrived.push(b);
    m.state = 'arrived';
    if (this.done) this._weld(world);
  }

  /**
   * Every part has landed: welds the parts within `reach` of each other where they come closest
   * (the closest pairs first, at most MAX_WELDS a part: a big shell of an upload can touch dozens),
   * and keeps one anchor per welded group (see the class). A weld does without the neighbours'
   * collision filter (a joint's bodies do not collide, and do again once apart when it breaks).
   */
  _weld(world) {
    const { reach, scale } = this.options;
    const weld = this.options.weld * scale;
    if (this.welded || !weld) return;
    this.welded = true;
    const parts = this.arrived.filter((b) => world.bodies.includes(b));
    const group = new Map(parts.map((b) => [b, b])); // union-find over the welds
    const root = (b) => (group.get(b) === b ? b : root(group.get(b)));
    const pairs = [];
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i];
        const b = parts[j];
        if (!Rebuild._near(a.aabb, b.aabb, reach)) continue;
        const c = world.backend.closest(a, b, reach);
        if (c) pairs.push({ a, b, c });
      }
    }
    const welds = new Map(parts.map((b) => [b, 0]));
    for (const { a, b, c } of pairs.sort((p, q) => p.c.gap - q.c.gap)) {
      if (welds.get(a) >= MAX_WELDS || welds.get(b) >= MAX_WELDS) continue;
      welds.set(a, welds.get(a) + 1);
      welds.set(b, welds.get(b) + 1);
      this.welds.push(world.addJoint(new Joint(a, b, { kind: 'fixed', anchor: c.point, breakForce: weld, breakTorque: weld, name: 'rebuild weld' })));
      if (this._unneighbour(a, b)) world.filter.unignore(a, b);
      group.set(root(a), root(b));
    }
    const keep = new Set();
    const groups = new Map();
    for (const b of parts) (groups.get(root(b)) ?? groups.set(root(b), []).get(root(b))).push(b);
    for (const members of groups.values()) keep.add(Rebuild._base(members));
    for (const j of this.anchors) if (!j.removed && !keep.has(j.bodyA)) world.removeJoint(j);
    this.anchors = this.anchors.filter((j) => !j.removed);
  }

  /** The part a group stands on: among its lowest (within 3 cm), the one nearest its middle seen from above. */
  static _base(members) {
    const floor = Math.min(...members.map((b) => b.aabb.min.y));
    const low = members.filter((b) => b.aabb.min.y <= floor + 0.03);
    const mx = members.reduce((s, b) => s + b.position.x, 0) / members.length;
    const mz = members.reduce((s, b) => s + b.position.z, 0) / members.length;
    return low.reduce((best, b) => (Math.hypot(b.position.x - mx, b.position.z - mz) < Math.hypot(best.position.x - mx, best.position.z - mz) ? b : best));
  }

  static _near(p, q, reach) {
    return p.min.x - reach <= q.max.x && q.min.x - reach <= p.max.x && p.min.y - reach <= q.max.y && q.min.y - reach <= p.max.y && p.min.z - reach <= q.max.z && q.min.z - reach <= p.max.z;
  }

  /** Drops a and b from each other's neighbours; whether they were. */
  _unneighbour(a, b) {
    const la = this.neighbours.get(a);
    const lb = this.neighbours.get(b);
    const i = la?.indexOf(b) ?? -1;
    if (i < 0) return false;
    la.splice(i, 1);
    const k = lb?.indexOf(a) ?? -1;
    if (k >= 0) lb.splice(k, 1);
    return true;
  }

  /** An anchor broke or was removed: its part collides with its neighbours again, once apart. */
  _unanchored(world, joint) {
    if (joint.name !== 'rebuild anchor') return;
    const b = joint.bodyA;
    for (const o of this.neighbours.get(b) ?? []) {
      world.filter.unignore(b, o);
      world.filter.ignoreUntilSeparated(b, o);
      const list = this.neighbours.get(o);
      list.splice(list.indexOf(b), 1);
    }
    this.neighbours.delete(b);
  }

  /** Lands every part still waiting or flying, at once, and takes no more. */
  finish(world) {
    for (const m of this.moves) {
      if (m.state === 'waiting') this._lift(world, m);
      if (m.state === 'flying') this._land(world, m);
    }
    this.close();
  }

  /**
   * Sets how hard the anchors are to break (N and N m), for those standing and those to come.
   * The sculpture is woken, so a weaker setting is felt at once (asleep, nothing loads an anchor).
   */
  setStrength(strength) {
    this.options.strength = strength;
    Rebuild._strengthen(this.anchors, strength * this.options.scale);
  }

  /** Sets how hard the welds between parts are to break (N and N m), standing and to come. */
  setWeld(weld) {
    this.options.weld = weld;
    Rebuild._strengthen(this.welds, weld * this.options.scale);
  }

  /** Multiplies the anchors' and welds' strengths by `scale`, standing and to come. */
  setScale(scale) {
    this.options.scale = scale;
    this.setStrength(this.options.strength);
    this.setWeld(this.options.weld);
  }

  static _strengthen(joints, strength) {
    for (const j of joints) {
      if (j.removed) continue;
      j.breakForce = strength;
      j.breakTorque = strength;
      j.bodyA.wake();
    }
  }

  /** Whether `body` is anchored or welded in the sculpture. */
  holds(body) {
    return this.neighbours.has(body) || this.welds.some((j) => !j.removed && (j.bodyA === body || j.bodyB === body));
  }

  /** Removes the anchors and welds (but those of parts in `keep`, a Set): the sculpture falls apart. */
  release(world, keep = null) {
    for (const j of this.anchors) if (!j.removed && !keep?.has(j.bodyA)) world.removeJoint(j);
    for (const j of this.welds) if (!j.removed && !(keep?.has(j.bodyA) && keep.has(j.bodyB))) world.removeJoint(j);
    this.anchors = this.anchors.filter((j) => !j.removed);
    this.welds = this.welds.filter((j) => !j.removed);
  }

  /** Whether any of its anchors or welds still stands. */
  get standing() {
    return this.anchors.some((j) => !j.removed) || this.welds.some((j) => !j.removed);
  }

  get label() {
    if (this.done) return `rebuilt from ${this.total} parts${this.welds.length ? `, ${this.welds.length} welds` : ''}`;
    return `rebuilding · part ${this.arrived.length}/${this.total}${this.closed ? '' : '…'}`;
  }
}
