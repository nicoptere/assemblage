import { SdfGridShape } from '../shapes/SdfGridShape.js';
import { PlaneShape, SphereShape, BoxShape } from '../shapes/primitives.js';

const RECORD = 24; // 32-bit words per shape record (the WGSL Shape struct)
const KIND = { grid: 0, plane: 1, sphere: 2, box: 3 };

/**
 * The shapes on the GPU, uploaded once: a table of shape records, every shape's surface samples
 * (shape space, all of them, in their spread order, so any precision is a prefix) and every
 * grid's int16 values (each grid starts on a word). Append-only, like the models a scene loads;
 * buffers grow by doubling (the old contents are copied on the GPU, so only new shapes are written).
 * Primitives are shared by value (a cannon makes a new sphere per ball). `slot(shape)` is null for
 * a shape the GPU cannot evaluate.
 */
export class GpuShapes {
  constructor(device, buffers) {
    this.device = device;
    this.buffers = buffers; // GpuBuffers: 'shapes', 'samples', 'sdf'
    this.slots = new Map(); // shape (or primitive key) -> slot | null
    this.records = []; // slots in record order
    this.sampleCount = 0;
    this.valueCount = 0; // int16 grid values, padded to whole words per grid
    this.pending = []; // slots added since the last upload
    for (const name of ['shapes', 'samples', 'sdf']) buffers.ensure(name, 256);
  }

  static kind(shape) {
    if (shape instanceof SdfGridShape) return KIND.grid;
    if (shape instanceof PlaneShape) return KIND.plane;
    if (shape instanceof SphereShape) return KIND.sphere;
    if (shape instanceof BoxShape) return KIND.box;
    return -1;
  }

  static key(shape) {
    if (shape instanceof PlaneShape) return `plane ${shape.normal.x} ${shape.normal.y} ${shape.normal.z} ${shape.offset}`;
    if (shape instanceof SphereShape) return `sphere ${shape.radius} ${shape.sampleCount}`;
    if (shape instanceof BoxShape) return `box ${shape.halfExtents.x} ${shape.halfExtents.y} ${shape.halfExtents.z} ${shape.sampleCount}`;
    return shape;
  }

  /** The GPU slot of `shape` ({ index, sampleStart, ... }), registering it; null if unsupported. */
  slot(shape) {
    const key = GpuShapes.key(shape);
    if (this.slots.has(key)) return this.slots.get(key);
    const kind = GpuShapes.kind(shape);
    if (kind < 0) {
      this.slots.set(key, null);
      return null;
    }
    const slot = { index: this.records.length, kind, shape, sampleStart: this.sampleCount, valueStart: this.valueCount, values: null, scale: 1 };
    if (kind === KIND.grid) {
      [slot.values, slot.scale] = GpuShapes._int16(shape);
      this.valueCount += slot.values.length;
    }
    this.sampleCount += shape.sampleCount;
    this.slots.set(key, slot);
    this.records.push(slot);
    this.pending.push(slot);
    return slot;
  }

  /** Uploads what was registered since last time. */
  upload() {
    if (!this.pending.length) return;
    const b = this.buffers;
    b.ensure('shapes', this.records.length * RECORD * 4, { keep: true });
    b.ensure('samples', this.sampleCount * 12, { keep: true });
    b.ensure('sdf', this.valueCount * 2, { keep: true });
    for (const s of this.pending) {
      b.write('shapes', GpuShapes._record(s), s.index * RECORD * 4);
      if (s.shape.sampleCount) b.write('samples', Float32Array.from(s.shape.samples), s.sampleStart * 12);
      if (s.values) b.write('sdf', s.values, s.valueStart * 2);
      s.values = null; // on the GPU now
    }
    this.pending = [];
  }

  static _record(s) {
    const buf = new ArrayBuffer(RECORD * 4);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    const shape = s.shape;
    u[0] = s.kind;
    u[11] = s.sampleStart;
    if (s.kind === KIND.grid) {
      u[1] = shape.nx; u[2] = shape.ny; u[3] = shape.nz;
      f[4] = shape.ox; f[5] = shape.oy; f[6] = shape.oz; f[7] = shape.voxel;
      f[8] = shape.inv; f[9] = s.scale; u[10] = s.valueStart;
    } else if (s.kind === KIND.plane) {
      f[12] = shape.normal.x; f[13] = shape.normal.y; f[14] = shape.normal.z; f[15] = shape.offset;
    } else if (s.kind === KIND.sphere) {
      f[12] = shape.radius;
    } else {
      f[12] = shape.halfExtents.x; f[13] = shape.halfExtents.y; f[14] = shape.halfExtents.z;
    }
    if (!shape.infinite) {
      const { min, max } = shape.localAabb;
      f[16] = min.x; f[17] = min.y; f[18] = min.z; f[19] = 1;
      f[20] = max.x; f[21] = max.y; f[22] = max.z;
    }
    return buf;
  }

  /**
   * A grid's values as int16, padded to a whole number of words, and their scale (metres per
   * unit): baked grids are int16 already; float grids are quantised.
   */
  static _int16(shape) {
    const { data, scale } = shape;
    const out = new Int16Array(data.length + (data.length & 1));
    if (data instanceof Int16Array) {
      out.set(data);
      return [out, scale];
    }
    let max = 0;
    for (const v of data) max = Math.max(max, Math.abs(v * scale));
    const q = max > 0 ? max / 32767 : 1;
    for (let i = 0; i < data.length; i++) out[i] = Math.round((data[i] * scale) / q);
    return [out, q];
  }

  dispose() {
    this.slots.clear();
    this.records = [];
    this.pending = [];
    this.sampleCount = this.valueCount = 0;
  }
}
