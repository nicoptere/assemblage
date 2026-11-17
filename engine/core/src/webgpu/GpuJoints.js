import { WORDS, JOINT, COLOR_INDEX, MAX_COLORS, MAX_CONSTRAINTS } from './kernels/lib.wgsl.js';

const J = WORDS.joint;
const K = WORDS.constraint;
const BIG = 3e38;
const big = (x) => (Number.isFinite(x) ? x : BIG);

/**
 * Joints and user constraints on the GPU.
 * Joints are uploaded again whenever the set or a setting changes, sorted into colours: greedy colouring over the bodies that move, so the joints of a
 * colour share none and are solved in place, colour after colour (Gauss-Seidel between
 * colours, as the CPU solves them one by one): one dispatch per colour, or up to `singleMax`
 * joints, all colours in one workgroup (`single`), barriers between them. Supported: 'fixed' (weld, orientation lock with
 * its compliance) and 'ball' (with or without orientation drive); hinges stay CPU-only.
 * Constraints (drag points) are few and change every frame: sent every step, to a uniform of
 * MAX_CONSTRAINTS (their force is not read back).
 */
export const SINGLE_MAX = 2048; // joints up to which one workgroup solves every colour (GpuJoints.single)

export class GpuJoints {
  constructor(device, buffers) {
    this.device = device;
    this.buffers = buffers;
    this.singleMax = SINGLE_MAX;
    this.reset();
  }

  reset() {
    this.idOf = new Map(); // joint -> id (its jointState slot)
    this.byId = [];
    this.freeIds = [];
    this.list = []; // joints in GPU order (colour by colour)
    this.colors = []; // [{ index, start, count }]
    this.source = [];
    this.sig = [];
    this.constraintCount = 0;
    this._warned = false;
  }

  /** Whether every colour is solved by one workgroup in one dispatch (kernel jointColors). */
  get single() {
    return this.list.length > 0 && this.list.length <= this.singleMax;
  }

  static signature(j, bodies) {
    return [j.kind, j.compliance, j.angularCompliance, j.breakForce, j.breakTorque, bodies.slotOf.get(j.bodyA), bodies.slotOf.get(j.bodyB)];
  }

  /** Whether the joints differ from the ones sent: another list, or a signature changed (compared field by field). */
  _changed(joints, bodies) {
    if (joints.length !== this.source.length) return true;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      const s = this.sig[i];
      if (j !== this.source[i] || s[0] !== j.kind || s[1] !== j.compliance || s[2] !== j.angularCompliance || s[3] !== j.breakForce
        || s[4] !== j.breakTorque || s[5] !== bodies.slotOf.get(j.bodyA) || s[6] !== bodies.slotOf.get(j.bodyB)) return true;
    }
    return false;
  }

  /** Uploads the joints if anything about them changed; sends the constraints. */
  sync(world, bodies) {
    this._constraints(world.constraints, bodies);
    const joints = world.joints;
    if (!this._changed(joints, bodies)) {
      // targets moved (Joint.setTargetB: anchors following something): same list, new data
      if (this.list.some((j) => j.moved)) this._upload(bodies);
      return;
    }
    this.source = joints.slice();
    this.sig = joints.map((j) => GpuJoints.signature(j, bodies));
    const list = joints.filter((j) => j.kind === 'fixed' || j.kind === 'ball');
    if (list.length < joints.length && !this._warned) {
      console.warn('webgpu: hinge joints are not simulated on the GPU');
      this._warned = true;
    }
    // greedy colouring: a joint takes the first colour neither of its moving bodies has yet
    const used = new Map();
    const taken = (b) => (b.isDynamic ? used.get(b) ?? used.set(b, new Set()).get(b) : null);
    const colorOf = list.map((j) => {
      const a = taken(j.bodyA);
      const b = taken(j.bodyB);
      let c = 0;
      while (a?.has(c) || b?.has(c)) c++;
      if (c >= MAX_COLORS) throw new Error(`webgpu: more than ${MAX_COLORS} joints on one body`);
      a?.add(c);
      b?.add(c);
      return c;
    });
    this._ids(list);
    const order = list.map((_, i) => i).sort((x, y) => colorOf[x] - colorOf[y] || x - y);
    this.list = order.map((i) => list[i]);
    this.colors = [];
    order.forEach((i, k) => {
      const c = colorOf[i];
      if (!this.colors[c]) this.colors[c] = { index: COLOR_INDEX + c, start: k, count: 0 };
      this.colors[c].count++;
    });
    this._upload(bodies);
  }

  /** Stable ids: kept by joints still there, freed by removed ones; a new id starts intact. */
  _ids(list) {
    const keep = new Set(list);
    for (const [j, id] of this.idOf) {
      if (keep.has(j)) continue;
      this.idOf.delete(j);
      this.byId[id] = null;
      this.freeIds.push(id);
    }
    const fresh = [];
    for (const j of list) {
      if (this.idOf.has(j)) continue;
      const id = this.freeIds.length ? this.freeIds.pop() : this.byId.length;
      this.idOf.set(j, id);
      this.byId[id] = j;
      fresh.push(id);
    }
    this.buffers.ensure('jointState', Math.max(1, this.byId.length) * 16, { keep: true });
    const zero = new Float32Array(4);
    for (const id of fresh) this.buffers.write('jointState', zero, id * 16);
  }

  _upload(bodies) {
    const n = this.list.length;
    const data = new ArrayBuffer(Math.max(1, n) * J * 4);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    this.list.forEach((j, i) => {
      const o = i * J;
      j.moved = false;
      const drive = Number.isFinite(j.angularCompliance);
      u[o] = bodies.slotOf.get(j.bodyA);
      u[o + 1] = bodies.slotOf.get(j.bodyB);
      u[o + 2] = j.kind === 'fixed' ? 0 : 1;
      u[o + 3] = drive ? JOINT.drive : 0;
      f.set([j.localA.x, j.localA.y, j.localA.z, j.compliance, j.localB.x, j.localB.y, j.localB.z, drive ? j.angularCompliance : 0], o + 4);
      f.set([j.frameA.x, j.frameA.y, j.frameA.z, j.frameA.w, j.frameB.x, j.frameB.y, j.frameB.z, j.frameB.w], o + 12);
      f.set([big(j.breakForce), big(j.breakTorque)], o + 20);
      u[o + 22] = this.idOf.get(j);
    });
    this.buffers.ensure('joints', data.byteLength);
    this.buffers.write('joints', data);
    const index = new Uint32Array(64);
    const ranges = new Uint32Array(MAX_COLORS * 2); // the 'colors' uniform
    this.colors.forEach((c, k) => {
      index[0] = ranges[2 * k] = c.start;
      index[1] = ranges[2 * k + 1] = c.count;
      this.buffers.write('index', index.subarray(0, 4), c.index * 256);
    });
    this.buffers.write('colors', ranges);
  }

  _constraints(constraints, bodies) {
    let list = constraints.filter((c) => bodies.slotOf.has(c.body));
    if (list.length > MAX_CONSTRAINTS) {
      if (!this._warnedConstraints) console.warn(`webgpu: only the first ${MAX_CONSTRAINTS} drag points are solved`);
      this._warnedConstraints = true;
      list = list.slice(0, MAX_CONSTRAINTS);
    }
    this.constraintCount = list.length;
    if (!list.length) return;
    const data = new ArrayBuffer(list.length * K * 4);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    list.forEach((c, i) => {
      const o = i * K;
      u[o] = bodies.slotOf.get(c.body);
      f.set([c.local.x, c.local.y, c.local.z, c.compliance, c.target.x, c.target.y, c.target.z, c.damping, big(c.maxForce)], o + 4);
    });
    this.buffers.write('constraints', data);
  }


  /**
   * Reads a read-back of jointState taken when `byId` mapped ids to joints: updates each joint's
   * force / torque readouts and returns those that broke.
   */
  static readBreaks(data, byId) {
    const f = new Float32Array(data.buffer, data.byteOffset, byId.length * 4);
    const broken = new Set();
    byId.forEach((j, id) => {
      if (!j) return;
      j.force = f[id * 4 + 1];
      j.torque = f[id * 4 + 2];
      if (f[id * 4] !== 0 && !j.removed) broken.add(j);
    });
    return broken;
  }
}
