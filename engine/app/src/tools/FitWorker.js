/**
 * A fit worker (fit.worker.js) seen as promises: target() builds a target and resolves with its
 * description ({ vertices, surface, voxel, grid, count, volume, centre, size }); fit() builds it,
 * reports every message to `on` (the target, each part placed as soon as it is found, progress)
 * and resolves when the fit is done. A worker runs one job at a time; cancel() stops it at once
 * (the worker is replaced) and the pending promises reject with 'cancelled'.
 */
export class FitWorker {
  constructor() {
    this._start();
  }

  _start() {
    this.worker = new Worker(new URL('./fit.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.jobs.get(data.id)?.(data);
    this.worker.onerror = (e) => this._fail(e.message || 'fit worker failed');
    this.jobs = new Map();
    this.meshes = new Set(); // names the worker already has
    this.nextId = 1;
  }

  target(name, mesh, place) {
    return this._run({ type: 'target', name, place }, mesh, () => {});
  }

  fit(name, mesh, place, stencils, fit, on) {
    return this._run({ type: 'fit', name, place, stencils, fit }, mesh, on);
  }

  _run(message, mesh, on) {
    if (!this.meshes.has(message.name)) {
      this.worker.postMessage({ type: 'mesh', name: message.name, V: mesh.V, F: mesh.F });
      this.meshes.add(message.name);
    }
    const id = this.nextId++;
    const last = message.type === 'fit' ? 'done' : 'target';
    return new Promise((resolve, reject) => {
      this.jobs.set(id, (m) => {
        if (m.type === 'error') {
          this.jobs.delete(id);
          reject(new Error(m.message));
          return;
        }
        on(m);
        if (m.type === last) {
          this.jobs.delete(id);
          resolve(m);
        }
      });
      this.worker.postMessage({ ...message, id });
    });
  }

  _fail(message) {
    for (const job of this.jobs.values()) job({ type: 'error', message });
  }

  cancel() {
    this.worker.terminate();
    this._fail('cancelled');
    this._start();
  }

  dispose() {
    this.worker.terminate();
    this._fail('cancelled');
  }
}
