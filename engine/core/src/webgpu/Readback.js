import { mapRead } from './mapRead.js';

const align = (n) => Math.ceil(n / 16) * 16;

/**
 * GPU -> CPU copies without waiting: a few staging buffers, each filled at the end of a step's
 * commands (encode), mapped once the work is submitted (start), and handed over when mapped
 * (take: the newest, older ones are dropped). A step whose staging buffers are all busy simply
 * reads nothing back. latencyMs: how long a copy takes to come back once submitted (averaged).
 * `nudge`: see mapRead.
 */
export class Readback {
  constructor(device, count = 3, { nudge = true } = {}) {
    this.device = device;
    this.nudge = nudge;
    this.latencyMs = 0;
    this.slots = Array.from({ length: count }, () => ({ buffer: null, state: 'free', meta: null, layout: null, size: 0, promise: null }));
  }

  /** Copies `parts` ([{ name, buffer, offset?, size }]) into a free staging buffer; null if none is free. */
  encode(encoder, parts, meta) {
    const slot = this.slots.find((s) => s.state === 'free');
    if (!slot) return null;
    let size = 0;
    slot.layout = {};
    for (const p of parts) {
      slot.layout[p.name] = { offset: size, size: p.size };
      size += align(p.size);
    }
    size = Math.max(16, size);
    if (!slot.buffer || slot.buffer.size < size) {
      slot.buffer?.destroy();
      slot.buffer = this.device.createBuffer({ size: 2 ** Math.ceil(Math.log2(size)), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'readback' });
    }
    for (const p of parts) if (p.size > 0) encoder.copyBufferToBuffer(p.buffer, p.offset ?? 0, slot.buffer, slot.layout[p.name].offset, p.size);
    slot.size = size;
    slot.meta = meta;
    slot.state = 'encoded';
    return slot;
  }

  /** Maps what was encoded into work just submitted. */
  start() {
    for (const s of this.slots) {
      if (s.state !== 'encoded') continue;
      s.state = 'pending';
      s.promise = mapRead(this.device, s.buffer, 0, s.size, { nudge: this.nudge }).then(
        (ms) => {
          s.state = 'ready';
          this.latencyMs = this.latencyMs ? 0.8 * this.latencyMs + 0.2 * ms : ms;
        },
        (error) => { s.state = 'failed'; s.error = error; },
      );
    }
  }

  /** The oldest copy still on its way (a promise), or null. */
  oldest() {
    const pending = this.slots.filter((s) => s.state === 'pending').sort((a, b) => a.meta.step - b.meta.step);
    return pending[0]?.promise ?? null;
  }

  /** The newest mapped copy as { meta, part(name) -> Uint8Array }, or null; release() it when done. */
  take() {
    const failed = this.slots.find((s) => s.state === 'failed');
    if (failed) {
      failed.state = 'free';
      throw failed.error;
    }
    const ready = this.slots.filter((s) => s.state === 'ready').sort((a, b) => b.meta.step - a.meta.step);
    if (!ready.length) return null;
    for (const s of ready.slice(1)) this._free(s);
    const s = ready[0];
    const data = s.buffer.getMappedRange(0, s.size);
    return {
      slot: s,
      meta: s.meta,
      part: (name) => {
        const l = s.layout[name];
        return l ? new Uint8Array(data, l.offset, l.size) : null;
      },
    };
  }

  release(taken) {
    this._free(taken.slot);
  }

  _free(s) {
    s.buffer.unmap();
    s.state = 'free';
  }

  /** Drops what is in flight (a new world); pending maps are released when they land. */
  clear() {
    for (const s of this.slots) {
      if (s.state === 'ready') this._free(s);
      else if (s.state === 'pending') s.promise.then(() => { if (s.state === 'ready') this._free(s); });
      else if (s.state === 'encoded' || s.state === 'failed') s.state = 'free';
    }
  }

  dispose() {
    for (const s of this.slots) s.buffer?.destroy();
  }
}
