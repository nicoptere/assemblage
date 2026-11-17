/**
 * Drops models one after another onto the scene: the first after `first` seconds, then with the
 * gaps in `gaps` (the last gap repeats), e.g. [3, 2] = 3 s, then every 2 s. `drop(model, index)`
 * spawns one model and must be synchronous (models are loaded beforehand), so the sequence is
 * driven purely by simulation time and replays identically.
 */
export class ModelRain {
  constructor(models, drop, { first = 0.5, gaps = [3, 2] } = {}) {
    this.models = models;
    this.drop = drop;
    this.gaps = gaps;
    this.nextAt = first;
    this.count = 0;
    this.start = null;
  }

  get total() {
    return this.models.length;
  }

  get done() {
    return this.count >= this.total;
  }

  update(world) {
    if (this.start === null) this.start = world.time;
    if (this.done || world.time - this.start < this.nextAt) return;
    this.drop(this.models[this.count], this.count);
    this.nextAt += this.gaps[Math.min(this.count, this.gaps.length - 1)];
    this.count++;
  }

  /** Drops no more of `model` (taken away: App.removeModel); those already down stay counted. */
  without(model) {
    this.models = [...this.models.slice(0, this.count), ...this.models.slice(this.count).filter((m) => m !== model)];
  }

  get label() {
    if (this.count === 0) return 'raining models…';
    return `model ${this.count}/${this.total} · ${this.models[this.count - 1].name}`;
  }
}
