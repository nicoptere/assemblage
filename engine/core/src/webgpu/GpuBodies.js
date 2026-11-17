import { WORDS, FLAG, COMMAND, MAX_PLANES, atomLayout } from './kernels/lib.wgsl.js';

const P = WORDS.props;
const C = WORDS.command;
const S = 13; // shadow numbers per slot: position 3, quaternion 4, velocity 3, angular velocity 3
const BIG = 3e38; // "infinite" for WGSL, which may not keep IEEE infinities

/**
 * The bodies on the GPU, mirrored by the World's RigidBody objects. The GPU owns the pose and
 * velocity of what it simulates; the CPU bodies hold a copy read back a frame late
 * (applyState), which the app reads and may change. Every step, sync() compares each body with
 * what was last sent or read for it (its shadow) and sends what the app changed, as commands:
 *   teleport      pose changed (setOrigin, a respawn): the whole state, absolute
 *   addVelocity   velocity changed (a blast, a shot): the difference, added on the GPU to whatever
 *                 the velocity has become since the read-back
 *   setVelocity   velocity zeroed (sleep, a hold) or set right after one, and any change of a
 *                 kinematic body's (the app drives it: its velocity is the app's, never read back)
 * together with the props (mass, material, flags) of the bodies whose props changed. A read-back
 * older than a body's last absolute write leaves that body alone.
 */
export class GpuBodies {
  constructor(device, buffers, shapes) {
    this.device = device;
    this.buffers = buffers;
    this.shapes = shapes;
    this.cap = 0;
    this.reset();
  }

  /** Forgets every body (a new world). */
  reset() {
    this.count = 0; // slots in use: the highest one + 1
    this.slotOf = new Map();
    this.slotById = new Map();
    this.bodyAt = [];
    this.free = [];
    this.sig = [];
    this.commands = new Map(); // slot -> pending command
    this.planes = [];
    this.excludedCount = 0;
    this._filterVersion = -1;
    this._epoch = 0; // bumps when slots change hands (the exclusion keys are by slot)
    this._exclEpoch = -1;
    this._lo = Infinity;
    this._hi = -1;
    this._present = new Set();
    if (this.cap) this.since.fill(0);
    else this._grow(256);
  }

  _grow(cap) {
    const props = new ArrayBuffer(cap * P * 4);
    if (this.cap) new Uint8Array(props).set(new Uint8Array(this.propsData));
    this.propsData = props;
    this.pf = new Float32Array(props);
    this.pu = new Uint32Array(props);
    const shadow = new Float64Array(cap * S);
    const since = new Float64Array(cap);
    if (this.cap) {
      shadow.set(this.shadow);
      since.set(this.since);
    }
    this.shadow = shadow;
    this.since = since;
    const b = this.buffers;
    b.ensure('props', cap * P * 4);
    b.ensure('state', cap * WORDS.state * 4, { keep: true });
    b.ensure('prev', cap * WORDS.prev * 4, { keep: true });
    b.ensure('bounds', cap * WORDS.bounds * 4);
    b.ensure('atom', atomLayout(cap).words * 4);
    this.cap = cap;
    this._lo = 0;
    this._hi = this.count - 1; // props buffer replaced: send them all again
  }

  /** Brings the GPU up to date with `world` before step number `step`. Returns the command count. */
  sync(world, step) {
    const present = this._present;
    present.clear();
    for (const b of world.bodies) present.add(b);
    for (const [body, slot] of this.slotOf) if (!present.has(body)) this._release(body, slot);
    this.planes.length = 0;
    for (const b of world.bodies) {
      const slot = this.slotOf.get(b);
      if (slot === undefined) this._add(b, step);
      else {
        if (this._propsChanged(b, slot)) this._writeProps(b, slot);
        this._diff(b, slot, step);
      }
      if (b.shape.infinite && this.planes.length < MAX_PLANES) this.planes.push(this.slotOf.get(b));
    }
    this._exclusions(world.filter);
    this.shapes.upload();
    if (this._hi >= this._lo) {
      this.buffers.write('props', this.pf.subarray(this._lo * P, (this._hi + 1) * P), this._lo * P * 4);
      this._lo = Infinity;
      this._hi = -1;
    }
    return this._sendCommands();
  }

  _add(b, step) {
    const shape = this.shapes.slot(b.shape);
    if (!shape) throw new Error(`webgpu: ${b.shape.constructor.name} is not supported on the GPU (body '${b.name}')`);
    if (b.localSamples.length / 3 > 8192) throw new Error(`webgpu: body '${b.name}' has more than 8192 samples`);
    const slot = this.free.length ? this.free.pop() : this.count++;
    if (slot >= this.cap) this._grow(this.cap * 2);
    this.slotOf.set(b, slot);
    this.slotById.set(b.id, slot);
    this.bodyAt[slot] = b;
    this._epoch++;
    this._writeProps(b, slot);
    this._command(slot, COMMAND.teleport, b);
    this.since[slot] = step;
    this._remember(b, slot);
  }

  _release(body, slot) {
    this.slotOf.delete(body);
    this.slotById.delete(body.id);
    this.bodyAt[slot] = null;
    this.commands.delete(slot);
    this.sig[slot] = null;
    this.pu.fill(0, slot * P, (slot + 1) * P); // inactive
    this._dirty(slot);
    this.free.push(slot);
    this._epoch++;
  }

  _dirty(slot) {
    if (slot < this._lo) this._lo = slot;
    if (slot > this._hi) this._hi = slot;
  }

  static flags(b) {
    let f = FLAG.active | (b.type === 'dynamic' ? FLAG.dynamic : b.type === 'kinematic' ? FLAG.kinematic : FLAG.static);
    if (b.sleeping) f |= FLAG.sleeping;
    if (b.ccd) f |= FLAG.ccd;
    if (b.shape.infinite) f |= FLAG.infinite;
    if (b.stirs) f |= FLAG.moved; // wakes the sleepers it touches (World.wakeSpeed)
    return f;
  }

  /** What the props are made of: a body whose signature changed is sent again (_propsChanged). */
  static signature(b) {
    const c = b.com;
    return [b.invMass, GpuBodies.flags(b), b.friction, b.restitution, b.rollingFriction, b.linearDamping, b.angularDamping,
      b.localSamples, c.x, c.y, c.z, b.invInertiaLocal, b.collisionGroup, b.collisionMask, b.shape, b.boundingRadius];
  }

  /** signature(b) against the one sent, field by field (every body, every step: no array made). */
  _propsChanged(b, slot) {
    const s = this.sig[slot];
    const c = b.com;
    return s[0] !== b.invMass || s[1] !== GpuBodies.flags(b) || s[2] !== b.friction || s[3] !== b.restitution
      || s[4] !== b.rollingFriction || s[5] !== b.linearDamping || s[6] !== b.angularDamping || s[7] !== b.localSamples
      || s[8] !== c.x || s[9] !== c.y || s[10] !== c.z || s[11] !== b.invInertiaLocal || s[12] !== b.collisionGroup
      || s[13] !== b.collisionMask || s[14] !== b.shape || s[15] !== b.boundingRadius;
  }

  _writeProps(b, slot) {
    const shape = this.shapes.slot(b.shape);
    const f = this.pf;
    const u = this.pu;
    const o = slot * P;
    const e = b.invInertiaLocal.e;
    f[o] = b.invMass;
    u[o + 1] = GpuBodies.flags(b);
    u[o + 2] = shape.index;
    u[o + 3] = shape.sampleStart;
    u[o + 4] = b.localSamples.length / 3;
    u[o + 5] = (b.collisionGroup ?? 1) >>> 0;
    u[o + 6] = (b.collisionMask ?? -1) >>> 0;
    f[o + 7] = Number.isFinite(b.boundingRadius) ? b.boundingRadius : 0;
    f.set([b.com.x, b.com.y, b.com.z, b.friction, e[0], e[1], e[2], b.restitution, e[3], e[4], e[5], b.rollingFriction, e[6], e[7], e[8], b.linearDamping], o + 8);
    if (!b.shape.infinite) {
      const { min, max } = b.shape.localAabb;
      f.set([min.x, min.y, min.z, b.angularDamping, max.x, max.y, max.z, 0], o + 24);
    } else f.set([0, 0, 0, b.angularDamping, 0, 0, 0, 0], o + 24);
    this.sig[slot] = GpuBodies.signature(b);
    this._dirty(slot);
  }

  /** Turns what the app changed since the shadow into a command for the next step. */
  _diff(b, slot, step) {
    const s = this.shadow;
    const o = slot * S;
    const p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
    if (p.x !== s[o] || p.y !== s[o + 1] || p.z !== s[o + 2] || q.x !== s[o + 3] || q.y !== s[o + 4] || q.z !== s[o + 5] || q.w !== s[o + 6]) {
      this._command(slot, COMMAND.teleport, b);
      this.since[slot] = step;
    } else if (v.x !== s[o + 7] || v.y !== s[o + 8] || v.z !== s[o + 9] || w.x !== s[o + 10] || w.y !== s[o + 11] || w.z !== s[o + 12]) {
      const pending = this.commands.get(slot);
      const zero = !v.x && !v.y && !v.z && !w.x && !w.y && !w.z;
      if (pending?.kind === COMMAND.teleport || pending?.kind === COMMAND.setVelocity) this._command(slot, pending.kind, b);
      else if (zero || b.type === 'kinematic') this._command(slot, COMMAND.setVelocity, b);
      else {
        const c = pending ?? this._command(slot, COMMAND.addVelocity, null);
        c.vel[0] += v.x - s[o + 7]; c.vel[1] += v.y - s[o + 8]; c.vel[2] += v.z - s[o + 9];
        c.ang[0] += w.x - s[o + 10]; c.ang[1] += w.y - s[o + 11]; c.ang[2] += w.z - s[o + 12];
      }
    } else return;
    this._remember(b, slot);
  }

  _command(slot, kind, b) {
    const c = { kind, pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], ang: [0, 0, 0] };
    if (b) {
      c.pos = [b.position.x, b.position.y, b.position.z];
      c.quat = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
      c.vel = [b.velocity.x, b.velocity.y, b.velocity.z];
      c.ang = [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z];
    }
    this.commands.set(slot, c);
    return c;
  }

  _remember(b, slot) {
    const s = this.shadow;
    const o = slot * S;
    const p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
    s[o] = p.x; s[o + 1] = p.y; s[o + 2] = p.z;
    s[o + 3] = q.x; s[o + 4] = q.y; s[o + 5] = q.z; s[o + 6] = q.w;
    s[o + 7] = v.x; s[o + 8] = v.y; s[o + 9] = v.z;
    s[o + 10] = w.x; s[o + 11] = w.y; s[o + 12] = w.z;
  }

  _sendCommands() {
    const n = this.commands.size;
    if (!n) return 0;
    const data = new ArrayBuffer(n * C * 4);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    let i = 0;
    for (const [slot, c] of this.commands) {
      const o = i++ * C;
      u[o] = slot;
      u[o + 1] = c.kind;
      f.set(c.pos, o + 4);
      f.set(c.quat, o + 8);
      f.set(c.vel, o + 12);
      f.set(c.ang, o + 16);
    }
    this.buffers.ensure('commands', data.byteLength);
    this.buffers.write('commands', data);
    this.commands.clear();
    return n;
  }

  /** Pairs that must not collide (joints, user rules, not yet separated), as sorted slot keys. */
  _exclusions(filter) {
    if (filter.version === this._filterVersion && this._epoch === this._exclEpoch) return;
    this._filterVersion = filter.version;
    this._exclEpoch = this._epoch;
    const keys = [];
    const add = (sa, sb) => {
      if (sa !== undefined && sb !== undefined) keys.push(((Math.min(sa, sb) << 16) | Math.max(sa, sb)) >>> 0);
    };
    for (const k of filter.ignored.keys()) add(this.slotById.get(Math.floor(k / 2097152)), this.slotById.get(k % 2097152));
    for (const [a, b] of filter.pending.values()) add(this.slotOf.get(a), this.slotOf.get(b));
    const sorted = Uint32Array.from(keys).sort();
    this.excludedCount = sorted.length;
    this.buffers.ensure('excludedKeys', Math.max(4, sorted.byteLength));
    if (sorted.length) this.buffers.write('excludedKeys', sorted);
  }

  /**
   * Copies a read-back of step `step` (State records of `count` slots) into the bodies, except
   * where the app changed something since (that becomes a command for step `next`) or the GPU
   * state predates the body's last absolute write. Refreshes their bounds for CPU queries.
   */
  applyState(data, count, step, next, margin) {
    for (let slot = 0; slot < Math.min(count, this.count); slot++) {
      const b = this.bodyAt[slot];
      if (!b || b.type === 'static' || this.since[slot] > step) continue;
      this._diff(b, slot, next);
      if (this.since[slot] > step) continue;
      const o = slot * WORDS.state;
      b.position.set(data[o], data[o + 1], data[o + 2]);
      b.quaternion.set(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
      if (b.type !== 'kinematic') { // a kinematic body moves at the velocity the app gives it
        b.velocity.set(data[o + 8], data[o + 9], data[o + 10]);
        b.angularVelocity.set(data[o + 12], data[o + 13], data[o + 14]);
      }
      this._remember(b, slot);
      b.updateBounds(0, margin);
    }
  }

  /** The body in `slot` if it was there at step `step` (and still is). */
  bodyAtStep(slot, step) {
    return this.since[slot] <= step ? this.bodyAt[slot] ?? null : null;
  }
}
