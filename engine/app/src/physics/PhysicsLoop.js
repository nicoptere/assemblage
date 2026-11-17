import { World, RigidBody, PlaneShape, Emitter, CpuBackend } from '@sdfphys/core';
import { WebGPUBackend, GpuProfiler } from '@sdfphys/core/webgpu';

/**
 * Owns the World and advances it with a fixed timestep, decoupled from the render rate.
 * The engine ('cpu' or 'webgpu') can change at any time (setBackend): the world is kept, the
 * switch happens between two steps. The WebGPU engine queues its steps without waiting for the
 * GPU (the bodies it moves are read back a frame or two late), one batch at a time.
 * Emits 'reset' { world } when a fresh world is built, 'step' { world } after every step
 * (scenarios run there, always between steps), and 'error' { error } when a GPU step fails
 * (the loop then goes back to the CPU).
 */
export class PhysicsLoop extends Emitter {
  constructor({ dt = 1 / 60, maxStepsPerFrame = 3, world = {}, gpu = {} } = {}) {
    super();
    this.gpuOptions = gpu; // WebGPUBackend options
    this.dt = dt;
    this.maxStepsPerFrame = maxStepsPerFrame;
    this.worldOptions = world;
    this.paused = false;
    this.accumulator = 0;
    this.backends = { cpu: new CpuBackend(), webgpu: null };
    this.backend = this.backends.cpu;
    this._running = null; // the batch of asynchronous steps in flight
    this._done = 0; // steps finished since the last update()
    this.reset();
  }

  /** { ok, reason }: whether this page can run the WebGPU engine, and why not. */
  static gpuProbe() {
    return WebGPUBackend.probe();
  }

  reset() {
    this.world = new World({ ...this.worldOptions, backend: this.backend });
    this.world.addBody(new RigidBody({ shape: new PlaneShape(), type: 'static', friction: 0.9, name: 'ground' }));
    this.accumulator = 0;
    this.emit('reset', { world: this.world });
  }

  /** Switches the engine ('cpu' or 'webgpu') between two steps, keeping the world. */
  async setBackend(name) {
    const backend = name === 'webgpu' ? (this.backends.webgpu ??= new WebGPUBackend(this.gpuOptions)) : this.backends.cpu;
    await backend.init(); // throws if this browser has no WebGPU
    await this._running;
    await this.world.setBackend(backend);
    this.backend = backend;
    return backend;
  }

  /** Changes world options now and for every world built by later resets. */
  configure(options) {
    Object.assign(this.worldOptions, options);
    Object.assign(this.world, options);
  }

  set substeps(n) {
    this.configure({ substeps: n });
  }

  get substeps() {
    return this.world.substeps;
  }

  /** The WebGPU engine's profile as text (WebGPUBackend.profile), the loop held meanwhile. */
  async profileGpu(options) {
    if (this.backend.name !== 'webgpu') throw new Error('profiling needs the WebGPU engine');
    const paused = this.paused;
    this.paused = true;
    try {
      await this._running;
      return GpuProfiler.format(await this.backend.profile(this.world, this.dt, options));
    } finally {
      this.paused = paused;
      this.accumulator = 0;
    }
  }

  /** Advances by the elapsed real time (seconds). Returns the number of steps finished since the last call. */
  update(elapsed) {
    if (this.paused) return this._take();
    this.accumulator = Math.min(this.accumulator + elapsed, this.dt * this.maxStepsPerFrame);
    if (this.backend.async) {
      const n = Math.floor(this.accumulator / this.dt);
      if (!this._running && n > 0) {
        this.accumulator -= n * this.dt;
        this._run(n);
      }
      return this._take();
    }
    let n = 0;
    while (this.accumulator >= this.dt) {
      this._step();
      this.accumulator -= this.dt;
      n++;
    }
    return n;
  }

  stepOnce() {
    if (!this.backend.async) this._step();
    else if (!this._running) this._run(1);
  }

  _step() {
    this.world.step(this.dt);
    this.emit('step', { world: this.world });
  }

  /** `n` asynchronous steps, one after the other; stops early if the world is replaced. */
  _run(n) {
    const world = this.world;
    this._running = (async () => {
      for (let i = 0; i < n && world === this.world; i++) {
        await world.stepAsync(this.dt);
        this._done++;
        if (world === this.world) this.emit('step', { world });
      }
    })()
      .catch(async (error) => {
        this.backend = this.backends.cpu;
        await this.world.setBackend(this.backend);
        this.emit('error', { error });
      })
      .finally(() => { this._running = null; });
  }

  _take() {
    const n = this._done;
    this._done = 0;
    return n;
  }
}
