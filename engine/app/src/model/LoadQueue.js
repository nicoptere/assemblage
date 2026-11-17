/**
 * Loads things one at a time (`concurrency`), in the order they were added, the ones asked for
 * first. `load(key, report)` loads one and resolves to it, calling report(fraction 0..1, note?)
 * as it goes (the note: what it is doing, for a progress line). Each key has an entry { key,
 * state, progress, note?, value?, error? } (state: 'waiting', 'loading', 'done', 'failed');
 * listeners hear of every change of one.
 *   add(keys, load?)   queues them (once), at the back; `load` loads these instead of the queue's
 *   need(key)          its promise; queued if new, and started now if still waiting (ahead of the rest)
 *   entry(key)         its entry, or undefined
 *   remove(key)        forgets an entry that is not loading (failed, done: a model taken away, or still waiting)
 */
export class LoadQueue {
  constructor(load, { concurrency = 1 } = {}) {
    this.load = load;
    this.concurrency = concurrency;
    this.entries = new Map(); // key -> entry, in the order added
    this.running = 0;
    this.listeners = new Set();
  }

  add(keys, load = this.load) {
    for (const key of keys) {
      if (this.entries.has(key)) continue;
      const entry = { key, state: 'waiting', progress: 0, load };
      entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
      entry.promise.catch(() => {}); // a failure is the entry's state; whoever needs it hears of it
      this.entries.set(key, entry);
    }
    this._next();
  }

  need(key) {
    this.add([key]);
    const entry = this.entries.get(key);
    if (entry.state === 'waiting') this._run(entry);
    return entry.promise;
  }

  entry(key) {
    return this.entries.get(key);
  }

  remove(key) {
    if (this.entries.get(key)?.state !== 'loading') this.entries.delete(key);
  }

  /** The keys loaded so far, in the order added. */
  get done() {
    return [...this.entries.values()].filter((e) => e.state === 'done').map((e) => e.key);
  }

  /** How far the whole queue is, 0..1 (1 when empty), and whether anything is left to load. */
  get fraction() {
    const list = [...this.entries.values()];
    return list.length ? list.reduce((s, e) => s + (e.state === 'waiting' ? 0 : e.state === 'loading' ? e.progress : 1), 0) / list.length : 1;
  }

  get busy() {
    return [...this.entries.values()].some((e) => e.state === 'waiting' || e.state === 'loading');
  }

  /** Calls `listener(entry)` on every change; returns a function that stops it. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _next() {
    for (const entry of this.entries.values()) {
      if (this.running >= this.concurrency) return;
      if (entry.state === 'waiting') this._run(entry);
    }
  }

  async _run(entry) {
    entry.state = 'loading';
    this.running++;
    this._emit(entry);
    try {
      entry.value = await entry.load(entry.key, (fraction, note = entry.note) => {
        entry.progress = Math.min(1, Math.max(entry.progress, fraction)); // never back
        entry.note = note;
        this._emit(entry);
      });
      Object.assign(entry, { state: 'done', progress: 1 });
      entry.resolve(entry.value);
    } catch (error) {
      Object.assign(entry, { state: 'failed', error });
      entry.reject(error);
    }
    this.running--;
    this._emit(entry);
    this._next();
  }

  _emit(entry) {
    for (const listener of this.listeners) listener(entry);
  }
}
