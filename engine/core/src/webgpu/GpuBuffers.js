const STORAGE = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

/**
 * The named GPU buffers kernels bind (see GpuKernels). Buffers grow by doubling; `version` bumps
 * whenever one is replaced, so bind groups know to rebuild.
 */
export class GpuBuffers {
  constructor(device) {
    this.device = device;
    this.map = new Map();
    this.version = 0;
  }

  get(name) {
    const b = this.map.get(name);
    if (!b) throw new Error(`GpuBuffers: no buffer '${name}'`);
    return b;
  }

  /** A buffer of at least `bytes`; with `keep`, a replaced buffer's contents are copied over (on the GPU). */
  ensure(name, bytes, { usage = STORAGE(), keep = false } = {}) {
    const old = this.map.get(name);
    if (old && old.size >= bytes) return old;
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(bytes, 4))));
    const buffer = this.device.createBuffer({ size, usage, label: name });
    if (old) {
      if (keep) {
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(old, 0, buffer, 0, old.size);
        this.device.queue.submit([encoder.finish()]);
      }
      old.destroy();
    }
    this.map.set(name, buffer);
    this.version++;
    return buffer;
  }

  write(name, data, offset = 0) {
    this.device.queue.writeBuffer(this.get(name), offset, data);
  }

  dispose() {
    for (const b of this.map.values()) b.destroy();
    this.map.clear();
  }
}
