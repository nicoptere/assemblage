const SEGMENT = ['torso', 'thigh', 'shin', 'paw'];
const ARTICULATION = { '0-1': 'hip', '1-2': 'knee', '2-3': 'ankle' };

/** Rig info of a joint: which limb it belongs to, how low on it, and a readable name. */
function describe(joint) {
  const a = joint.bodyA.userData.part;
  const b = joint.bodyB.userData.part;
  const limb = [a, b].find((p) => p.chain !== 'TORSO');
  const chain = limb ? limb.chain : 'TORSO';
  const levels = [a, b].filter((p) => p.chain === chain || chain === 'TORSO').map((p) => p.level);
  const lo = Math.min(a.level, b.level);
  const hi = Math.max(a.level, b.level);
  const name = lo === hi ? `${SEGMENT[lo] ?? 'part'} weld` : ARTICULATION[`${lo}-${hi}`] ?? (lo === 0 ? 'hip' : 'link');
  return { chain, depth: Math.max(...levels), name };
}

/**
 * Takes assemblies apart joint by joint, all of them at once and in `duration` seconds whatever
 * their joint count: each limb after limb, each limb from the foot up, then the torso from the
 * bottom up. Joint i of an assembly's n goes at duration * sqrt((i + 1) / n), so removals start
 * slow and accelerate. Driven by simulation time, so it replays identically at any frame rate.
 */
export class Dismantle {
  constructor(instances, { duration = 2 } = {}) {
    this.queues = [instances].flat().map((instance) => ({ items: Dismantle.order(instance), next: 0 }));
    this.total = this.queues.reduce((n, q) => n + q.items.length, 0);
    this.models = this.queues.length;
    this.duration = duration;
    this.removed = 0;
    this.start = null;
    this.last = null;
  }

  /** Limbs in a ring around the torso, each from the foot up; torso joints last, bottom up. */
  static order(instance) {
    const joints = instance.intactJoints.map((joint) => ({ joint, ...describe(joint), y: joint.worldAnchorA(joint.bodyA.position.clone()).y }));
    const limbs = new Map();
    for (const j of joints) {
      if (j.chain === 'TORSO') continue;
      const p = j.joint.bodyA.position;
      const entry = limbs.get(j.chain) ?? { x: 0, z: 0, n: 0 };
      entry.x += p.x;
      entry.z += p.z;
      entry.n++;
      limbs.set(j.chain, entry);
    }
    const ring = [...limbs.entries()]
      .map(([chain, e]) => ({ chain, angle: Math.atan2(e.z / e.n, e.x / e.n) }))
      .sort((a, b) => a.angle - b.angle)
      .map((l) => l.chain);
    const rank = (c) => (c === 'TORSO' ? ring.length : ring.indexOf(c));
    return joints.sort((a, b) => rank(a.chain) - rank(b.chain) || b.depth - a.depth || a.y - b.y);
  }

  get done() {
    return this.removed >= this.total;
  }

  /** Call after every physics step; removes the joints that are due. */
  update(world) {
    if (this.start === null) this.start = world.time;
    const t = world.time - this.start;
    for (const q of this.queues) {
      const n = q.items.length;
      while (q.next < n && t >= this.duration * Math.sqrt((q.next + 1) / n)) {
        const item = q.items[q.next++];
        this.removed++;
        if (item.joint.broken || item.joint.removed) continue; // broke on its own meanwhile
        world.removeJoint(item.joint);
        this.last = item;
      }
    }
  }

  get label() {
    const models = this.models > 1 ? ` · ${this.models} models` : '';
    if (this.done) return `all ${this.total} joints removed${models}`;
    if (!this.last) return 'dismantling…';
    const chain = this.last.chain.replace('_', ' ').toLowerCase();
    return `joint ${this.removed}/${this.total}${models} · ${chain} ${this.last.name}`;
  }
}
