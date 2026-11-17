/** What a frame's time goes to, in the order the band shows them. */
export const PHASES = ['collisions', 'marshalling', 'solver', 'render', 'other'];

/**
 * Where a frame's time goes, smoothed over frames (ms):
 *   collisions   finding contacts (broadphase, narrowphase) in the frame's physics steps
 *   solver       the substeps (joints, contacts, integration)
 *   marshalling  getting the bodies to the screen: the poses copied to the views and the overlays,
 *                plus, with the WebGPU engine, the main thread's part of each step (results
 *                applied, bodies and joints written, the step's commands encoded and submitted)
 *   render       drawing the frame (the main thread's part: commands sent to the GPU)
 *   other        the rest of the frame's script: scenarios, sounds, sleep and joint bookkeeping
 *                between steps, labels and stats
 * With the WebGPU engine, collisions and solver are GPU time (timestamp queries; `gpu` says so),
 * spent alongside the main thread's. What is left of the frame is not the page's script: the
 * browser's own work (events, style, compositing, garbage collection) and waiting, for the
 * display's next refresh or for the GPU to finish the frame before. Steps report themselves (the
 * loop's 'step' events); time(phase, fn) measures the rest, end(frameMs, scriptMs) closes a frame
 * (`scriptMs`: the frame callback's whole time).
 */
export class FrameBudget {
  constructor(physics, { smoothing = 0.08 } = {}) {
    this.smoothing = smoothing;
    this.frame = FrameBudget.zero(); // being counted
    this._script = 0; // of it, what ran in the frame's callback (or may have: a GPU step's part)
    this.ms = FrameBudget.zero(); // smoothed
    this.frameMs = 1000 / 60; // smoothed frame interval
    this.gpu = false;
    physics.on('step', ({ world }) => this._step(world.stats));
  }

  static zero(keys = PHASES) {
    return Object.fromEntries(keys.map((p) => [p, 0]));
  }

  _step(s) {
    this.gpu = s.backend === 'webgpu';
    this.frame.collisions += s.collideMs || 0;
    this.frame.solver += s.solveMs || 0;
    if (this.gpu) this.frame.marshalling += s.stepMs || 0;
    this._script += this.gpu ? s.stepMs || 0 : (s.collideMs || 0) + (s.solveMs || 0);
  }

  /** Runs `fn`, its time counted to `phase`; returns what it returns. */
  time(phase, fn) {
    const t = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t;
      this.frame[phase] += ms;
      this._script += ms;
    }
  }

  /** Closes the frame, `frameMs` after the previous one, its callback `scriptMs` long. */
  end(frameMs, scriptMs = 0) {
    this.frame.other = Math.max(0, scriptMs - this._script);
    this._script = 0;
    const a = this.smoothing;
    for (const p of PHASES) {
      this.ms[p] += (this.frame[p] - this.ms[p]) * a;
      this.frame[p] = 0;
    }
    if (frameMs > 0 && frameMs < 1000) this.frameMs += (frameMs - this.frameMs) * a;
  }

  /** The smoothed phases' sum (ms). */
  get total() {
    return PHASES.reduce((s, p) => s + this.ms[p], 0);
  }
}
