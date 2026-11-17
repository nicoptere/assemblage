/**
 * Sort-and-sweep on x over world AABBs. Infinite shapes (planes) are tested against every
 * finite body with their own `touchesAabb`. Returns candidate pairs [a, b] that pass the filter.
 * A half-space must stop everything, so its test also covers what a body's box leaves out of
 * its travel, and how far a body it touches could shove it (`pushed`: a part hit by a ball).
 */
export class Broadphase {
  constructor() {
    this.sorted = [];
    this.pairs = [];
  }

  findPairs(bodies, filter, margin) {
    const pairs = this.pairs;
    pairs.length = 0;
    const finite = this.sorted;
    finite.length = 0;
    const infinite = [];
    for (const b of bodies) (b.shape.infinite ? infinite : finite).push(b);

    finite.sort((a, b) => a.aabb.min.x - b.aabb.min.x);
    for (const b of finite) b.pushed = 0;
    for (let i = 0; i < finite.length; i++) {
      const a = finite[i];
      const maxX = a.aabb.max.x;
      for (let j = i + 1; j < finite.length; j++) {
        const b = finite[j];
        if (b.aabb.min.x > maxX) break;
        if (a.aabb.overlaps(b.aabb) && filter.canCollide(a, b)) {
          pairs.push([a, b]);
          a.pushed = Math.max(a.pushed, b.sweep);
          b.pushed = Math.max(b.pushed, a.sweep);
        }
      }
    }
    for (const p of infinite) {
      for (const b of finite) {
        if (p.shape.touchesAabb(b.aabb, margin + b.sweepShortfall + b.pushed) && filter.canCollide(p, b)) pairs.push([b, p]);
      }
    }
    return pairs;
  }
}
