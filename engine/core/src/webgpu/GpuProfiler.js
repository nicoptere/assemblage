import { mapRead } from './mapRead.js';
import { SINGLE_MAX } from './GpuJoints.js';

const now = () => performance.now();
const QUERIES = 4096; // the most a query set holds: 2048 timed dispatches per step

/**
 * Where the GPU time of a step goes, for the world as it is (it advances by the steps profiled):
 *   plain steps     queued back to back as the app does: stepMs is the time the queue took per
 *                   step (nothing else should use the GPU meanwhile: pause rendering), cpuMs the
 *                   encoding, collideMs / solveMs from the timestamps, readbackMs how long the
 *                   results took to come back. stepMs far above the GPU time with a long
 *                   read-back means the browser, not the GPU, holds the steps back
 *   round trips     on the idle GPU: a small read-back with and without nudges (see mapRead),
 *                   and an empty submission's onSubmittedWorkDone
 *   other solve     the same plain steps with the substeps the other way (one dispatch, or a
 *                   dispatch per phase: WebGPUBackend.solve), where both are possible
 *   kernel steps    every dispatch in its own timed pass: ms per kernel and step (all substeps),
 *                   averaged over the steps. timedMs sums them; what a plain step takes beyond
 *                   it is dispatch and barrier overhead (more kernels cost more of it). Split,
 *                   then the joints the other way (GpuJoints.single), to tell which suits this GPU
 * Browsers round timestamps (Chrome to 0.1 ms unless WebGPU developer features are on), so a
 * short kernel reads 0 or 0.1: the averages over its many calls still come out about right.
 */
export class GpuProfiler {
  constructor(backend) {
    this.backend = backend;
    this.querySet = null;
    this.resolve = null;
    this.read = null;
  }

  async run(world, dt, { steps = 30, kernelSteps = 8 } = {}) {
    const backend = this.backend;
    const device = backend.device;
    await device.queue.onSubmittedWorkDone();
    const doneMs = await GpuProfiler._doneLatency(device);
    const plain = await this._plainSteps(world, dt, steps);
    const readbackMs = backend.readback.latencyMs;
    const ahead = backend._ahead(world, dt);
    // the substeps the other way (one dispatch, or a dispatch per phase), where both are possible
    let solveAlt = null;
    const mode = backend.solve;
    backend.solve = 'one';
    const both = backend.oneDispatch;
    backend.solve = mode;
    if (both) {
      backend.solve = mode === 'one' ? 'split' : 'one';
      try {
        solveAlt = { solve: backend.solve, ...(await this._plainSteps(world, dt, steps)) };
      } finally {
        backend.solve = mode;
      }
    }

    let kernels = [];
    let dispatches = 0;
    let jointsAlt = null;
    if (backend.querySet) {
      this._ensure(device);
      ({ kernels, dispatches } = await this._kernelSteps(world, dt, kernelSteps));
      // split: the joints the other way (one workgroup for every colour, or a dispatch per colour)
      const joints = backend.joints;
      if (!backend.oneDispatch && joints.list.length && joints.list.length <= SINGLE_MAX) {
        const max = joints.singleMax;
        joints.singleMax = joints.single ? 0 : SINGLE_MAX;
        try {
          const other = await this._kernelSteps(world, dt, kernelSteps);
          jointsAlt = other.kernels.find((e) => e.kernel === 'joints' || e.kernel === 'jointColors') ?? null;
        } finally {
          joints.singleMax = max;
        }
      }
    }
    const list = kernels.sort((a, b) => b.ms - a.ms);
    return {
      gpu: backend.gpuName,
      bodies: world.bodies.length,
      pairs: world.stats.pairs,
      contacts: world.stats.contacts,
      substeps: world.substeps,
      iterations: backend.iterations,
      solve: backend.oneDispatch ? 'one' : 'split',
      ...plain,
      solveAlt,
      readbackMs,
      ahead,
      map: backend.mapLatency,
      doneMs,
      dispatches,
      timedMs: list.reduce((s, e) => s + e.ms, 0),
      kernels: list,
      joints: backend.joints.list.length,
      colors: backend.joints.colors.length,
      jointsAlt,
    };
  }

  /** `steps` steps queued back to back: { stepMs, cpuMs, collideMs, solveMs } per step. */
  async _plainSteps(world, dt, steps) {
    const backend = this.backend;
    const timing = { collide: 0, solve: 0, n: 0 };
    let cpu = 0;
    let seen = backend.readStep;
    await backend.device.queue.onSubmittedWorkDone();
    const t0 = now();
    for (let i = 0; i < steps; i++) {
      await world.stepAsync(dt);
      cpu += world.stats.stepMs;
      if (backend.readStep !== seen && world.stats.gpuMs != null) {
        seen = backend.readStep;
        timing.collide += world.stats.collideMs;
        timing.solve += world.stats.solveMs;
        timing.n++;
      }
    }
    await backend.device.queue.onSubmittedWorkDone();
    const avg = (x) => (timing.n ? x / timing.n : null);
    return { stepMs: (now() - t0) / steps, cpuMs: cpu / steps, collideMs: avg(timing.collide), solveMs: avg(timing.solve) };
  }

  /** `steps` steps with every dispatch timed: [{ phase, kernel, calls, ms }] per step, and dispatches per step. */
  async _kernelSteps(world, dt, steps) {
    const device = this.backend.device;
    const kernels = new Map();
    let dispatches = 0;
    for (let i = 0; i < steps; i++) {
      this.backend.kernelTimer = this;
      await world.stepAsync(dt);
      const labels = this.labels ?? [];
      this.labels = null;
      if (!labels.length) continue;
      await mapRead(device, this.read, 0, labels.length * 16);
      const t = new BigUint64Array(this.read.getMappedRange(0, labels.length * 16).slice(0));
      this.read.unmap();
      dispatches = labels.length;
      labels.forEach(({ phase, kernel }, k) => {
        const key = `${phase} ${kernel}`;
        const e = kernels.get(key) ?? { phase, kernel, calls: 0, ms: 0 };
        e.calls++;
        e.ms += t[2 * k + 1] > t[2 * k] ? Number(t[2 * k + 1] - t[2 * k]) / 1e6 : 0;
        kernels.set(key, e);
      });
    }
    return { kernels: [...kernels.values()].map((e) => ({ ...e, calls: e.calls / steps, ms: e.ms / steps })), dispatches };
  }

  /** The fastest of a few onSubmittedWorkDone after an empty submission, in ms. */
  static async _doneLatency(device, trials = 3) {
    let best = Infinity;
    for (let i = 0; i < trials; i++) {
      const t = now();
      device.queue.submit([device.createCommandEncoder().finish()]);
      await device.queue.onSubmittedWorkDone();
      best = Math.min(best, now() - t);
    }
    return best;
  }

  /** Called by the backend while encoding a kernel step: resolves the timestamps for reading. */
  capture(encoder, labels) {
    const n = labels.length * 2;
    if (!n) return;
    encoder.resolveQuerySet(this.querySet, 0, n, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, this.read, 0, n * 8);
    this.labels = labels;
  }

  _ensure(device) {
    if (this.querySet) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: QUERIES });
    this.resolve = device.createBuffer({ size: QUERIES * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.read = device.createBuffer({ size: QUERIES * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  dispose() {
    this.querySet?.destroy();
    this.resolve?.destroy();
    this.read?.destroy();
  }

  /** The result as text, to paste in a bug report. */
  static format(r) {
    const ms = (x) => (x == null ? '?' : x.toFixed(2));
    const lines = [
      `GPU ${r.gpu}: ${r.bodies} bodies, ${r.pairs} pairs, ${r.contacts} contacts, ${r.substeps} substeps x ${r.iterations} iterations`,
      `step ${ms(r.stepMs)} ms on the queue (cpu ${ms(r.cpuMs)})   timestamps: collide ${ms(r.collideMs)} + solve ${ms(r.solveMs)} ms   substeps in ${r.solve === 'one' ? 'one dispatch' : 'a dispatch per phase'}`,
      ...(r.solveAlt ? [`  the other way (${r.solveAlt.solve === 'one' ? 'one dispatch' : 'a dispatch per phase'}): ${ms(r.solveAlt.stepMs)} ms on the queue, solve ${ms(r.solveAlt.solveMs)} ms`] : []),
      `read-back ${ms(r.readbackMs)} ms after queuing, up to ${r.ahead} steps in flight   idle round trips: map ${ms(r.map?.plainMs)} ms, nudged ${ms(r.map?.nudgedMs)} (nudges ${r.map?.nudge ? 'on' : 'off'}), work done ${ms(r.doneMs)} ms`,
    ];
    if (r.kernels.length) {
      lines.push(`per kernel (${r.dispatches} dispatches, ${ms(r.timedMs)} ms timed):`);
      for (const k of r.kernels) lines.push(`  ${`${k.phase} ${k.kernel}`.padEnd(28)} ${ms(k.ms).padStart(7)} ms  ${String(Math.round(k.calls)).padStart(4)} calls`);
      const a = r.jointsAlt;
      if (a) lines.push(`${r.joints} joints in ${r.colors} colours; solved the other way (${a.kernel}): ${ms(a.ms)} ms, ${Math.round(a.calls)} calls`);
    } else {
      lines.push('no timestamp queries (turned off, or not on this device): no per-kernel times');
    }
    return lines.join('\n');
  }
}
