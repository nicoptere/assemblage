import { Backend } from '../world/Backend.js';
import { Narrowphase } from '../cpu/Narrowphase.js';
import { GpuBuffers } from './GpuBuffers.js';
import { GpuShapes } from './GpuShapes.js';
import { GpuBodies } from './GpuBodies.js';
import { GpuJoints } from './GpuJoints.js';
import { GpuKernels } from './GpuKernels.js';
import { Readback } from './Readback.js';
import { nudgeNeeded } from './mapRead.js';
import { PassTimer } from './PassTimer.js';
import { GpuProfiler } from './GpuProfiler.js';
import { COLLIDE, ARGS } from './kernels/collide.wgsl.js';
import { SOLVE } from './kernels/solve.wgsl.js';
import { WORDS, COUNTER, COUNTERS, SLOTS, MAX_SUBSTEPS, MAX_ITERATIONS, MAX_COLORS, MAX_CONSTRAINTS, COLOR_INDEX, INDEX_SLOTS, atomLayout } from './kernels/lib.wgsl.js';

const now = () => performance.now();
const PARAMS_BYTES = 176; // struct Params (lib.wgsl.js): 28 words, then the planes (16 u32)
const GPU = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

/** A contact as read back (impact sounds, debug view): who touched whom, how hard, where. */
class ReportedContact {
  constructor(bodyA, bodyB, approach, active, f, o) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.approach = approach;
    this.lambdaN = active ? 1 : 0;
    this.p = [f[o + 4], f[o + 5], f[o + 6]];
    this.n = [f[o + 8], f[o + 9], f[o + 10]];
  }

  worldPoint(out, outNormal) {
    outNormal?.set(this.n[0], this.n[1], this.n[2]);
    return out.set(this.p[0], this.p[1], this.p[2]);
  }
}

/**
 * The WebGPU engine: the whole step runs on the GPU, the CPU never waits for it.
 *
 *   collide  (once a step)  commands -> bounds -> pairs (all i < j) + half-spaces -> gather
 *            (samples against distance fields, the deepest per hashed cell of each pair) ->
 *            contacts -> per-body contact lists                  (kernels/collide.wgsl.js)
 *   solve    (every substep) integrate -> joints by colour (one dispatch while they are few) ->
 *            drag points -> contacts (position, averaged per body, `iterations` times; the last
 *            sets the velocities) -> contacts (velocity)         (kernels/solve.wgsl.js)
 *
 * The World stays the API and the scene: its RigidBody objects mirror the GPU state, read back
 * without blocking (a frame or two late) and written back as commands when the app changes them
 * (GpuBodies). stats.mainMs splits the main thread's part of a step (stepMs): `read` (results
 * applied: poses, wakes, breaks, contacts, sleep), `send` (bodies and joints brought up to date),
 * `encode` (the step's commands encoded and submitted). What the CPU still does, from the read-back: sleeping (islands, as CpuBackend),
 * joint breaks (the GPU disables a joint at once, the World removes it), collision filter
 * releases, raycasts and the contacts the sounds and the debug view use (hits of `reportSpeed`
 * and more). Differences from CpuBackend: contacts are chosen per cell rather than by farthest
 * point, and solved Jacobi-style (averaged per body) rather than one after the other; joints
 * stay Gauss-Seidel. Results are close to the CPU's, not identical. Hinges are CPU-only.
 * Steps are queued without waiting: world.stepAsync resolves once the step is submitted, and only
 * waits when the last step read back is more than `maxAhead` steps behind (stats.waitMs). While
 * the GPU keeps up (stats.gpuMs under the step), up to `maxQueued` steps may be in flight instead,
 * enough to cover the read-back latency (stats.readbackMs): the browser can take far longer to
 * hand results back than the GPU takes to compute them, and the simulation should not slow down
 * for it (what is drawn lags by that latency either way). profile() tells where the GPU time goes
 * (GpuProfiler).
 */
export class WebGPUBackend extends Backend {
  constructor({ powerPreference = 'high-performance', maxAhead = 4, maxQueued = 16, timestamps = true, nudge = 'auto', solve = 'one', iterations = 3, reportSpeed = 0.3, pairCap = 16384, contactCap = 32768, reportCap = 2048 } = {}) {
    super();
    this.iterations = Math.max(1, Math.min(MAX_ITERATIONS, iterations)); // contact position passes per substep (see solve.wgsl.js)
    this.powerPreference = powerPreference;
    this.maxAhead = maxAhead;
    this.maxQueued = maxQueued;
    this.timestamps = timestamps; // GPU times from timestamp queries, where the device has them
    this.nudge = nudge; // 'auto' (measured at init), true or false: see mapRead
    this.solve = solve; // 'one': every substep in one dispatch where possible, 'split': a dispatch per phase (see solve.wgsl.js)
    this.reportSpeed = reportSpeed; // m/s: contacts closing at least this fast are read back
    this.caps = { pairs: pairCap, contacts: contactCap, reports: reportCap };
    this.device = null;
    this.lost = null;
    this.generation = 0;
    this.kernelTimer = null; // set by GpuProfiler for one step: every dispatch timed
  }

  get name() {
    return 'webgpu';
  }

  get async() {
    return true;
  }

  /**
   * { ok, reason, gpu, software }: whether this page can run the engine, and why not; the GPU it
   * would get, and whether that is a CPU emulation (SwiftShader: works, but slower than the CPU engine).
   */
  static async probe({ powerPreference = 'high-performance' } = {}) {
    if (globalThis.isSecureContext === false) return { ok: false, reason: 'not a secure context: open the app on localhost or https' };
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return { ok: false, reason: 'this browser has WebGPU turned off' };
    try {
      const adapter = await gpu.requestAdapter({ powerPreference });
      if (!adapter) return { ok: false, reason: 'no GPU adapter (on Linux, Chromium needs Vulkan for WebGPU)' };
      const a = WebGPUBackend.describe(adapter);
      return { ok: true, reason: '', gpu: WebGPUBackend.nameOf(a), software: a.software };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** What an adapter is: { vendor, architecture, description, software }. */
  static describe(adapter) {
    const info = adapter.info ?? {};
    const text = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
    const software = !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter) || /swiftshader|llvmpipe|lavapipe|software/.test(text);
    return { vendor: info.vendor, architecture: info.architecture, description: info.description, software };
  }

  static nameOf(a) {
    const name = [a.vendor, a.architecture].filter(Boolean).join(' ') || a.description || 'unknown GPU';
    return a.software ? `software (${name})` : name;
  }

  static async available() {
    return (await WebGPUBackend.probe()).ok;
  }

  async init() {
    if (this.device) return;
    const { ok, reason } = await WebGPUBackend.probe();
    if (!ok) throw new Error(`WebGPU unavailable: ${reason}`);
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: this.powerPreference });
    const { maxStorageBufferBindingSize, maxBufferSize, maxStorageBuffersPerShaderStage, maxComputeInvocationsPerWorkgroup, maxComputeWorkgroupSizeX } = adapter.limits;
    const timestamps = this.timestamps && adapter.features.has('timestamp-query');
    this.device = await adapter.requestDevice({
      requiredFeatures: timestamps ? ['timestamp-query'] : [],
      requiredLimits: { maxStorageBufferBindingSize, maxBufferSize, maxStorageBuffersPerShaderStage, maxComputeInvocationsPerWorkgroup, maxComputeWorkgroupSizeX },
    });
    this.device.lost.then((info) => { this.lost = info; });
    this.adapter = WebGPUBackend.describe(adapter);
    const device = this.device;
    const b = (this.buffers = new GpuBuffers(device));
    b.ensure('params', PARAMS_BYTES, { usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    b.ensure('index', INDEX_SLOTS * 256, { usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    b.ensure('args', ARGS.words * 4, { usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    for (const name of ['commands', 'joints', 'jointState', 'excludedKeys']) b.ensure(name, 256);
    b.ensure('constraints', MAX_CONSTRAINTS * WORDS.constraint * 4, { usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    b.ensure('colors', MAX_COLORS * 8, { usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._sizeCollision();
    const index = new Uint32Array(COLOR_INDEX * 64); // (substep, iteration) slots; joint colours follow (GpuJoints)
    for (let s = 0; s < MAX_SUBSTEPS; s++) for (let k = 0; k < MAX_ITERATIONS; k++) index.set([s, k], (s * MAX_ITERATIONS + k) * 64);
    b.write('index', index);
    if (timestamps) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
      b.ensure('timing', 32, { usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    this.shapes = new GpuShapes(device, b);
    this.bodies = new GpuBodies(device, b, this.shapes);
    this.joints = new GpuJoints(device, b);
    // a CPU emulation (SwiftShader) runs a workgroup on one thread: there, one dispatch per colour is faster
    if (this.adapter.software) this.joints.singleMax = 0;
    this.kernels = new GpuKernels(device, b, { ...COLLIDE, ...SOLVE });
    const errors = await this.kernels.errors();
    if (errors.length) throw new Error(`webgpu: shader errors\n${errors.join('\n')}`);
    this.mapLatency = await nudgeNeeded(device); // { nudge, plainMs, nudgedMs }
    if (this.nudge !== 'auto') this.mapLatency.nudge = !!this.nudge;
    this.readback = new Readback(device, 3, { nudge: this.mapLatency.nudge });
  }

  _sizeCollision() {
    const { pairs, contacts, reports } = this.caps;
    const b = this.buffers;
    b.ensure('pairs', pairs * WORDS.pair * 4, { usage: GPU() });
    b.ensure('slots', pairs * SLOTS * 4, { usage: GPU() });
    b.ensure('contacts', contacts * WORDS.contact * 4, { usage: GPU() });
    b.ensure('corr', contacts * 4 * 16, { usage: GPU() });
    b.ensure('csr', contacts * 2 * 4, { usage: GPU() });
    b.ensure('reports', reports * WORDS.report * 4, { usage: GPU() });
  }

  /** The GPU in use, e.g. 'nvidia ampere', 'software (google swiftshader)'. */
  get gpuName() {
    return this.adapter ? WebGPUBackend.nameOf(this.adapter) : '';
  }

  attach(world) {
    if (!this.device) throw new Error('webgpu: await backend.init() before attaching it');
    this.world = world;
    this.generation++;
    this.bodies.reset();
    this.joints.reset();
    this.readback.clear();
    this.step = 0; // steps submitted
    this.readStep = 0; // last step read back
    this.narrowphase = new Narrowphase({ maxContacts: world.maxContactsPerPair, maxSpeculative: world.maxSpeculativeContacts, margin: world.contactMargin, maxSweep: world.maxSweep });
  }

  detach(world) {
    this._drain(world);
    this.generation++;
    this.readback.clear();
    this.world = null;
  }

  /** Deepest overlap of two bodies in their mirrored pose (filter releases, ignoreOverlaps). */
  penetration(a, b) {
    return this.narrowphase.penetration(a, b);
  }

  /** Where two bodies come closest, within `reach` (Narrowphase.closest). */
  closest(a, b, reach) {
    return this.narrowphase.closest(a, b, reach);
  }

  step() {
    throw new Error('webgpu: steps are asynchronous, use world.stepAsync(dt)');
  }

  async stepAsync(world, dt) {
    if (this.lost) throw new Error(`WebGPU device lost: ${this.lost.message || this.lost.reason}`);
    const t0 = now();
    let waited = 0;
    let read = 0; // the main thread's time, by part: results applied, bodies and joints sent, commands encoded and submitted
    const drain = () => {
      const t = now();
      this._drain(world);
      read += now() - t;
    };
    const ahead = this._ahead(world, dt);
    while (this.step - this.readStep > ahead) {
      const pending = this.readback.oldest();
      if (!pending) break;
      const t = now();
      await pending;
      waited += now() - t;
      drain();
    }
    drain();
    const step = ++this.step;
    const { bodies, joints } = this;
    if (world.substeps > MAX_SUBSTEPS) throw new Error(`webgpu: at most ${MAX_SUBSTEPS} substeps`);
    const t1 = now();
    const commands = bodies.sync(world, step);
    joints.sync(world, bodies);
    const t2 = now();
    const n = bodies.count;
    if (n) {
      this._params(world, dt, commands);
      const encoder = this.device.createCommandEncoder();
      const timer = this.kernelTimer;
      this.kernelTimer = null;
      const passes = new PassTimer(this.kernels, encoder, timer ? timer.querySet : this.querySet, { perKernel: !!timer });
      const queries = this._encode(passes, world, commands);
      if (timer) timer.capture(encoder, passes.labels);
      else if (queries) encoder.resolveQuerySet(this.querySet, 0, queries, this.buffers.get('timing'), 0);
      this._readback(encoder, step, dt, n, !timer && queries > 0);
      this.device.queue.submit([encoder.finish()]);
      this.readback.start();
    }
    world.time += dt;
    world.frame++;
    const t3 = now();
    Object.assign(world.stats, { backend: this.name, stepMs: t3 - t0 - waited, waitMs: waited, mainMs: { read, send: t2 - t1, encode: t3 - t2 } });
    world.emit('step', world.stats);
  }

  /**
   * Whether the substeps run in one dispatch (kernel solve): unless asked not to, on a device
   * that allows its 9 storage buffers and not a CPU emulation (one workgroup is one thread there).
   */
  get oneDispatch() {
    return this.solve === 'one' && this.kernels.has('solve') && !this.adapter.software;
  }

  /** Steps that may be in flight: maxAhead, or enough to cover the read-back latency while the GPU keeps up. */
  _ahead(world, dt) {
    const gpu = world.stats.gpuMs;
    const ms = dt * 1000;
    if (!(gpu < 0.8 * ms)) return this.maxAhead; // the GPU is the bottleneck (or its time is unknown)
    return Math.min(this.maxQueued, Math.max(this.maxAhead, Math.ceil(this.readback.latencyMs / ms) + 2));
  }

  /** The step's dispatches: collide once, then the substeps. Returns the timestamps written. */
  _encode(passes, world, commands) {
    const { bodies, joints } = this;
    const n = bodies.count;
    const g = Math.ceil(n / 64);
    passes.phase('collide');
    passes.dispatch('commands', Math.ceil(commands / 64));
    passes.dispatch('bounds', g);
    passes.dispatch('pairs', [Math.ceil(n / 8), Math.ceil(n / 8)]);
    if (bodies.planes.length) passes.dispatch('planes', g);
    passes.dispatch('plan', 1);
    passes.dispatchIndirect('gather', ARGS.gather);
    passes.dispatchIndirect('build', ARGS.build);
    passes.dispatch('plan2', 1);
    passes.dispatch('scan', 1);
    passes.dispatchIndirect('scatter', ARGS.contacts);
    passes.dispatchIndirect('report', ARGS.contacts);
    passes.phase('solve');
    if (this.oneDispatch) {
      passes.dispatch('solve', 1);
      return passes.end();
    }
    const drag = joints.constraintCount > 0;
    for (let s = 0; s < world.substeps; s++) {
      passes.dispatch('integrate', g);
      if (joints.single) passes.dispatch('jointColors', 1);
      else for (const c of joints.colors) passes.dispatch('joints', Math.ceil(c.count / 64), c.index);
      if (drag) passes.dispatch('constraints', 1);
      for (let k = 0; k < this.iterations; k++) {
        const index = s * MAX_ITERATIONS + k; // the first pass begins the contacts, the last sets the velocities
        passes.dispatchIndirect('contactPosition', ARGS.contacts, index);
        passes.dispatch('applyPosition', g, index);
      }
      passes.dispatchIndirect('contactVelocity', ARGS.contacts);
      passes.dispatch('applyVelocity', g);
      if (drag) passes.dispatch('constraintVelocity', 1);
    }
    return passes.end();
  }

  /**
   * Where the GPU time of a step goes (see GpuProfiler.format to print it). Runs steps of the
   * world (it advances); pause rendering and any other stepping meanwhile.
   */
  async profile(world, dt, options) {
    if (this.world !== world) throw new Error('webgpu: profile the world this backend runs');
    this._profiler ??= new GpuProfiler(this);
    return this._profiler.run(world, dt, options);
  }

  _params(world, dt, commands) {
    const data = new ArrayBuffer(PARAMS_BYTES);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    const { bodies, caps } = this;
    const h = dt / world.substeps;
    f[0] = dt;
    f[1] = h;
    u[2] = world.substeps;
    u[3] = bodies.count;
    f.set([world.gravity.x, world.gravity.y, world.gravity.z, world.contactMargin, world.maxSweep, world.maxDepenetrationSpeed, world.maxSpeed, world.maxAngularSpeed], 4);
    u.set([caps.pairs, caps.contacts, caps.reports], 12);
    f[15] = this.reportSpeed;
    u.set([commands, bodies.excludedCount, bodies.planes.length, this.joints.constraintCount, bodies.cap, this.iterations, this.joints.colors.length], 16);
    f[24] = world.restSpeed;
    f[25] = world.restDamping;
    u.set(bodies.planes, 28);
    this.buffers.write('params', data);
  }

  _readback(encoder, step, dt, count, timed) {
    const b = this.buffers;
    const atom = atomLayout(this.bodies.cap);
    const parts = [
      { name: 'counters', buffer: b.get('atom'), size: COUNTERS * 4 },
      { name: 'wake', buffer: b.get('atom'), offset: atom.wake * 4, size: count * 4 },
      { name: 'state', buffer: b.get('state'), size: count * WORDS.state * 4 },
      { name: 'joints', buffer: b.get('jointState'), size: this.joints.byId.length * 16 },
      { name: 'reports', buffer: b.get('reports'), size: this.caps.reports * WORDS.report * 4 },
    ];
    if (timed) parts.push({ name: 'timing', buffer: b.get('timing'), size: 32 });
    this.readback.encode(encoder, parts, { step, dt, count, joints: this.joints.byId.slice(), generation: this.generation });
  }

  /** Applies the newest read-back: poses, wakes, breaks, contacts, counters, then sleep. */
  _drain(world) {
    const r = this.readback.take();
    if (!r) return;
    try {
      const m = r.meta;
      if (m.generation !== this.generation || m.step <= this.readStep) return;
      const counters = new Uint32Array(r.part('counters').slice().buffer);
      this._grow(counters);
      const { bodies } = this;
      const state = r.part('state');
      bodies.applyState(new Float32Array(state.buffer, state.byteOffset, m.count * WORDS.state), m.count, m.step, this.step + 1, world.contactMargin);
      const wake = r.part('wake');
      const flags = new Uint32Array(wake.buffer, wake.byteOffset, m.count);
      for (let i = 0; i < m.count; i++) if (flags[i]) bodies.bodyAtStep(i, m.step)?.wake();
      if (m.joints.length) world._applyBreaks(GpuJoints.readBreaks(r.part('joints'), m.joints));
      this._contacts(world, r.part('reports'), Math.min(counters[COUNTER.reports], this.caps.reports), m.step);
      const timing = r.part('timing');
      if (timing) {
        const t = new BigUint64Array(timing.slice().buffer);
        world.stats.collideMs = Number(t[1] - t[0]) / 1e6;
        world.stats.solveMs = Number(t[3] - t[2]) / 1e6;
        world.stats.gpuMs = world.stats.collideMs + world.stats.solveMs;
      }
      world.stats.readbackMs = this.readback.latencyMs;
      world.stats.pairs = Math.min(counters[COUNTER.pairs], this.caps.pairs);
      world.stats.contacts = Math.min(counters[COUNTER.contacts], this.caps.contacts);
      world._updateSleep((m.step - this.readStep) * m.dt);
      this.readStep = m.step;
      world._releaseSeparated();
    } finally {
      this.readback.release(r);
    }
  }

  _contacts(world, data, n, step) {
    const f = new Float32Array(data.buffer, data.byteOffset, n * WORDS.report);
    const u = new Uint32Array(data.buffer, data.byteOffset, n * WORDS.report);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = i * WORDS.report;
      const a = this.bodies.bodyAtStep(u[o], step);
      const b = this.bodies.bodyAtStep(u[o + 1], step);
      if (a && b) out.push(new ReportedContact(a, b, f[o + 2], f[o + 3] > 0, f, o));
    }
    world.contacts = out;
    world.stats.contactsStep = step;
  }

  /** Grows the pair or contact buffers when a step overflowed them (that step lost some). */
  _grow(counters) {
    const over = counters[COUNTER.overflow];
    if (!over) return;
    const { caps } = this;
    if (over & 1) caps.pairs = 2 ** Math.ceil(Math.log2(counters[COUNTER.pairs] * 1.5));
    if (over & 2) caps.contacts = 2 ** Math.ceil(Math.log2(counters[COUNTER.contacts] * 1.5));
    this._sizeCollision();
  }

  dispose() {
    this._profiler?.dispose();
    this.readback?.dispose();
    this.buffers?.dispose();
    this.device?.destroy();
    this.device = null;
  }
}

