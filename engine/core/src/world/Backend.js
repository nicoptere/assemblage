/**
 * What steps a World. The World holds every piece of state (bodies, joints, constraints,
 * contacts, filters, sleep timers) and its API; a backend only runs the step on it, so a world
 * can change backend between two steps and nothing has to be copied (World.setBackend).
 * Same split as three.js's Renderer and its WebGPU / WebGL backends.
 *
 * A backend is attached to one world at a time and may be reused by the next (a reset):
 *   init()                once, before the first attach (async: a GPU device, say)
 *   attach(world)         takes the world's collision settings
 *   detach(world)
 *   step(world, dt)       one step, synchronous backends only
 *   stepAsync(world, dt)  one step, every backend
 *   penetration(a, b)     deepest overlap of two bodies now (separation checks, ignoreOverlaps)
 *   closest(a, b, reach)  where two bodies come closest now, if within reach: { gap, point } or null
 *   dispose()             frees what init made
 * `async` is true when only stepAsync works (results come back from a GPU).
 */
export class Backend {
  get name() {
    return 'backend';
  }

  get async() {
    return false;
  }

  async init() {}

  attach() {}

  detach() {}

  step() {
    throw new Error(`${this.name}: step() is not available, use stepAsync()`);
  }

  async stepAsync(world, dt) {
    this.step(world, dt);
  }

  penetration() {
    return 0;
  }

  closest() {
    return null;
  }

  dispose() {}
}
