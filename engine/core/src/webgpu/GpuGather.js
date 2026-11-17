import { GATHER_WGSL } from './gather.wgsl.js';
import { mapRead } from './mapRead.js';

const JOB = 16; // 32-bit words per job (the WGSL Job struct)
const GROUP = 64;
const MAX_GROUPS_X = 65535;

/**
 * The gather pass on the GPU (see gather.wgsl.js): given the jobs of a step (one per direction
 * of each candidate pair), returns which samples came within their job's margin, as
 * [job, sample, job, sample, ...]. One dispatch and one read-back per step; the result buffer
 * grows with the scene (a step that overflows it is run again with a bigger one).
 */
export class GpuGather {
  constructor(device, shapes) {
    this.device = device;
    this.shapes = shapes;
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: GATHER_WGSL }), entryPoint: 'main' },
    });
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.counter = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.jobs = null;
    this.starts = null;
    this.found = null;
    this.readback = null;
    this.capacity = 0;
    this._grow(1 << 14);
    this.jobData = new Float32Array(JOB * 256);
    this.jobWords = new Uint32Array(this.jobData.buffer);
    this.startData = new Uint32Array(257);
    this.count = 0;
    this._bind = null;
    this._shapesVersion = -1;
  }

  /** Room for `n` jobs in the CPU-side arrays. */
  reserve(n) {
    if (n * JOB <= this.jobData.length) return;
    const size = 2 ** Math.ceil(Math.log2(n));
    const data = new Float32Array(JOB * size);
    data.set(this.jobData);
    this.jobData = data;
    this.jobWords = new Uint32Array(data.buffer);
    const starts = new Uint32Array(size + 1);
    starts.set(this.startData);
    this.startData = starts;
  }

  /** Starts a step's job list. */
  begin() {
    this.count = 0;
    this.total = 0;
    this.waitMs = 0; // submit to read-back mapped: GPU time plus the browser's delivery
  }

  /**
   * Adds a job: the `count` first samples of the shape at sample slot `sampleStart`, moved by
   * `frame` (row-major M with t in the 4th column, for shape-space samples), tested against
   * shape record `shape` within `margin`. Returns the job's index.
   */
  add(frame, margin, shape, sampleStart, count) {
    this.reserve(this.count + 1);
    const o = this.count * JOB;
    this.jobData.set(frame, o);
    this.jobData[o + 12] = margin;
    this.jobWords[o + 13] = shape;
    this.jobWords[o + 14] = sampleStart;
    this.jobWords[o + 15] = count;
    this.startData[this.count] = this.total;
    this.total += count;
    return this.count++;
  }

  /** Runs the jobs added since begin(). Resolves to a Uint32Array of [job, sample] pairs. */
  async run() {
    const jobs = this.count;
    if (jobs === 0 || this.total === 0) return new Uint32Array(0);
    this.startData[jobs] = this.total;
    this.shapes.upload();
    const { device } = this;
    this._ensure('jobs', jobs * JOB * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this._ensure('starts', (jobs + 1) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.jobs, 0, this.jobData, 0, jobs * JOB);
    device.queue.writeBuffer(this.starts, 0, this.startData, 0, jobs + 1);
    for (;;) {
      const groups = Math.ceil(this.total / GROUP);
      const groupsX = Math.min(groups, MAX_GROUPS_X);
      const groupsY = Math.ceil(groups / groupsX);
      device.queue.writeBuffer(this.params, 0, new Uint32Array([this.total, this.capacity, groupsX, jobs]));
      device.queue.writeBuffer(this.counter, 0, new Uint32Array([0]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this._bindGroup());
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
      encoder.copyBufferToBuffer(this.counter, 0, this.readback, 0, 4);
      encoder.copyBufferToBuffer(this.found, 0, this.readback, 8, this.capacity * 8);
      device.queue.submit([encoder.finish()]);
      this.waitMs += await mapRead(device, this.readback);
      const mapped = this.readback.getMappedRange();
      const n = new Uint32Array(mapped, 0, 1)[0];
      if (n > this.capacity) {
        this.readback.unmap();
        this._grow(2 ** Math.ceil(Math.log2(n)));
        continue;
      }
      const out = new Uint32Array(mapped, 8, n * 2).slice();
      this.readback.unmap();
      return out;
    }
  }

  _ensure(name, bytes, usage) {
    if (this[name] && this[name].size >= bytes) return;
    this[name]?.destroy();
    this[name] = this.device.createBuffer({ size: Math.max(256, 2 ** Math.ceil(Math.log2(bytes))), usage });
    this._bind = null;
  }

  _grow(capacity) {
    this.capacity = capacity;
    this.found?.destroy();
    this.readback?.destroy();
    this.found = this.device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.readback = this.device.createBuffer({ size: capacity * 8 + 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this._bind = null;
  }

  /** The bind group, rebuilt when a buffer was replaced (here or in the shape store). */
  _bindGroup() {
    if (this._bind && this._shapesVersion === this.shapes.version) return this._bind;
    const { shapes, samples, sdf } = this.shapes.buffers;
    const entries = [this.jobs, this.starts, shapes, samples, sdf, this.found, this.counter, this.params]
      .map((buffer, binding) => ({ binding, resource: { buffer } }));
    this._bind = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
    this._shapesVersion = this.shapes.version;
    return this._bind;
  }

  dispose() {
    for (const b of [this.params, this.counter, this.jobs, this.starts, this.found, this.readback]) b?.destroy();
  }
}
