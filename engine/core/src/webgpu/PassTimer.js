/**
 * The compute passes of a step, timed on the GPU with timestamp queries when the device has them.
 *   by phase   (every step)  one pass per phase (collide, solve): stats.collideMs / solveMs
 *   by kernel  (profiling)   one pass per dispatch, so the time of each kernel shows (GpuProfiler)
 * Passes beyond the query set's capacity run untimed. dispatch / dispatchIndirect are GpuKernels'.
 */
export class PassTimer {
  constructor(kernels, encoder, querySet = null, { perKernel = false } = {}) {
    this.kernels = kernels;
    this.encoder = encoder;
    this.querySet = querySet;
    this.perKernel = perKernel;
    this.labels = []; // what each pair of timestamps timed: { phase, kernel }
    this.pass = null;
    this.current = '';
  }

  /** Starts a phase ('collide', 'solve'). */
  phase(name) {
    this.current = name;
    if (!this.perKernel) this._begin('');
  }

  dispatch(name, groups, index = 0) {
    if (this.perKernel) this._begin(name);
    this.kernels.dispatch(this.pass, name, groups, index);
  }

  dispatchIndirect(name, offset, index = 0) {
    if (this.perKernel) this._begin(name);
    this.kernels.dispatchIndirect(this.pass, name, offset, index);
  }

  /** Ends the last pass; returns the number of timestamps written. */
  end() {
    this.pass?.end();
    this.pass = null;
    return this.labels.length * 2;
  }

  _begin(kernel) {
    this.pass?.end();
    const q = this.labels.length * 2;
    const timed = this.querySet && q + 2 <= this.querySet.count;
    if (timed) this.labels.push({ phase: this.current, kernel });
    this.pass = this.encoder.beginComputePass(timed ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: q, endOfPassWriteIndex: q + 1 } } : {});
  }
}
