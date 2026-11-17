/**
 * Decides which body pairs may collide.
 *  - ignore / unignore: reference-counted exclusions (jointed pairs, user rules)
 *  - ignoreUntilSeparated: excluded until the pair no longer overlaps (freshly broken joints,
 *    parts that interpenetrate in their rest pose), then collisions resume smoothly
 *  - collision groups: body.collisionGroup & other.collisionMask must be non-zero both ways
 *  - motion: a pair is only worth testing if something in it can move (see canMove)
 */
export class CollisionFilter {
  constructor() {
    this.ignored = new Map();
    this.pending = new Map();
    this.version = 0; // bumps on every change (a GPU backend mirrors the exclusions)
  }

  static key(a, b) {
    return a.id < b.id ? a.id * 2097152 + b.id : b.id * 2097152 + a.id;
  }

  ignore(a, b) {
    this.version++;
    const k = CollisionFilter.key(a, b);
    this.ignored.set(k, (this.ignored.get(k) || 0) + 1);
  }

  unignore(a, b) {
    this.version++;
    const k = CollisionFilter.key(a, b);
    const n = (this.ignored.get(k) || 0) - 1;
    if (n > 0) this.ignored.set(k, n);
    else this.ignored.delete(k);
  }

  ignoreUntilSeparated(a, b) {
    this.version++;
    this.pending.set(CollisionFilter.key(a, b), [a, b]);
  }

  release(a, b) {
    this.version++;
    this.pending.delete(CollisionFilter.key(a, b));
  }

  forgetBody(body) {
    this.version++;
    for (const [k, [a, b]] of this.pending) if (a === body || b === body) this.pending.delete(k);
  }

  /**
   * At least one side is simulated (dynamic) and at least one side is in motion (awake or
   * kinematic). Static/kinematic pairs and pairs of sleepers or sleeper + static are skipped;
   * sleeper + awake stays, so the world can decide whether the sleeper must wake.
   */
  static canMove(a, b) {
    const moving = (x) => x.type === 'kinematic' || x.isAwake;
    return (a.isDynamic || b.isDynamic) && (moving(a) || moving(b));
  }

  canCollide(a, b) {
    if (a === b || !CollisionFilter.canMove(a, b)) return false;
    const ga = a.collisionGroup ?? 1;
    const gb = b.collisionGroup ?? 1;
    if (!(ga & (b.collisionMask ?? -1)) || !(gb & (a.collisionMask ?? -1))) return false;
    const k = CollisionFilter.key(a, b);
    return !this.ignored.has(k) && !this.pending.has(k);
  }
}
