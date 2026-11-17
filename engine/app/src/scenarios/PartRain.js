import { Vec3 } from '@sdfphys/core';

/** Small seeded generator (mulberry32): the same seed rains the same parts in the same places. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rains `count` loose parts onto the scene, `rate` per second (Infinity: all at once), each dropped
 * at a random spot within `radius` of the centre and a random orientation, `height` to `height` +
 * `spread` above the top of what has landed (parts still falling from the last second are not
 * counted, or each drop would stack on the one before), and higher if it would overlap one still
 * falling (their bounding spheres, against any body: parts spawned into each other burst apart, and
 * drops started together would land in the same places). Parts are dealt
 * from `deck` (every part of every model, shuffled), round after round, so each round fills one
 * skinned mesh per model. `spawn(item, pose)` creates one part and returns its body. Seeded and
 * driven by simulation time, so it replays identically.
 */
export class PartRain {
  constructor(deck, spawn, { count = 500, rate = 25, radius = 1.2, height = 1.0, spread = 0.5, first = 0.5, seed = 1 } = {}) {
    this.rand = random(seed);
    this.deck = PartRain.shuffle(deck, this.rand);
    this.spawn = spawn;
    this.options = { rate, radius, height, spread, first };
    this.total = count;
    this.count = 0;
    this.start = null;
    this.recent = []; // [body, time] of parts dropped in the last second
  }

  static shuffle(items, rand) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  get done() {
    return this.count >= this.total;
  }

  update(world) {
    if (this.start === null) this.start = world.time;
    const { rate, first } = this.options;
    const since = world.time - this.start - first;
    const due = since < 0 ? 0 : rate === Infinity ? this.total : Math.min(this.total, Math.floor(since * rate) + 1);
    if (this.count >= due) return;
    this.recent = this.recent.filter(([, t]) => world.time - t < 1);
    const top = this._top(world);
    while (this.count < due) {
      const body = this.spawn(this.deck[this.count % this.deck.length], this._pose(top));
      this._clear(body, world);
      this.recent.push([body, world.time]);
      this.count++;
    }
  }

  /** Lifts `body` until its bounding sphere is clear of every other body's. */
  _clear(body, world) {
    const p = body.position;
    let y = p.y;
    for (let moved = true; moved; ) {
      moved = false; // each body can lift it once at most: lifted, it is above that one for good
      for (const other of world.bodies) {
        if (other === body || other.shape.infinite) continue;
        const q = other.position;
        const reach = body.boundingRadius + other.boundingRadius + 0.005;
        const across = reach * reach - (p.x - q.x) ** 2 - (p.z - q.z) ** 2;
        if (across <= 0 || Math.abs(y - q.y) >= Math.sqrt(across)) continue;
        y = q.y + Math.sqrt(across) + 1e-4; // a hair over, or rounding would find it touching again
        moved = true;
      }
    }
    if (y > p.y) body.setOrigin(body.getOrigin(new Vec3()).add(new Vec3(0, y - p.y, 0)));
  }

  /** Highest point of everything that has landed (or is about to). */
  _top(world) {
    const falling = new Set(this.recent.map(([b]) => b));
    let top = 0;
    for (const b of world.bodies) if (!b.shape.infinite && !falling.has(b)) top = Math.max(top, b.aabb.max.y);
    return top;
  }

  _pose(top) {
    const { radius, height, spread } = this.options;
    const r = radius * Math.sqrt(this.rand());
    const a = 2 * Math.PI * this.rand();
    // uniform random rotation (Shoemake)
    const [u1, u2, u3] = [this.rand(), this.rand(), this.rand()];
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    const quaternion = [s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3)];
    return { position: [r * Math.cos(a), top + height + spread * this.rand(), r * Math.sin(a)], quaternion };
  }

  get label() {
    return this.count === 0 ? 'raining parts…' : `part ${this.count}/${this.total}`;
  }
}
