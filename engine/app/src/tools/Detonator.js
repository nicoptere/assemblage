/**
 * Chooses what a blast blows up, from a point on screen:
 *   - a part anchored in the sculpture: the whole sculpture (`sculpture.explode()`);
 *   - any other part: the piece it belongs to (the parts still joined to it, World.connected),
 *     from the piece's mass centre, the radius reaching past its farthest part;
 *   - the floor: the pile around that point;
 *   - nothing (the sky): the whole scene, from just under its mass centre.
 * Armed (`arm()`), the next left click on the canvas picks the target instead of grabbing.
 * `env`: { world() -> World, blast(centre, radius), sculpture: { holds(body), explode() } }.
 */
export class Detonator {
  constructor(stage, env, { floorRadius = 1.2, sceneRadius = 2.5, minRadius = 0.8 } = {}) {
    this.stage = stage;
    this.env = env;
    this.options = { floorRadius, sceneRadius, minRadius };
    this.armed = false;
    this.onArm = () => {};
    // window, capture phase: ahead of the canvas' drag tool and orbit controls; stopPropagation
    // keeps it from them but lets other window listeners (the audio unlock) run
    window.addEventListener('pointerdown', (e) => {
      if (!this.armed || e.button !== 0 || e.target !== stage.renderer.domElement) return;
      e.stopPropagation();
      this.at(e);
      this.disarm();
    }, { capture: true });
  }

  arm() {
    this._setArmed(true);
  }

  disarm() {
    this._setArmed(false);
  }

  _setArmed(on) {
    this.armed = on;
    this.stage.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.onArm(on);
  }

  /**
   * Blows up what is under `pointer` ({ clientX, clientY }), or the whole scene if nothing is.
   * `first()`, if given, runs once the target is chosen and measured, just before the blast (the
   * models taken apart: the piece is sized whole, and flies apart).
   */
  at(pointer, first = () => {}) {
    const blast = this._aim(pointer);
    first();
    blast?.();
  }

  /** The blast for what is under `pointer`, to set off; undefined if there is nothing to blow up. */
  _aim(pointer) {
    const world = this.env.world();
    const ray = pointer && this.stage.ray(pointer);
    const hit = ray && world.raycast(ray.origin, ray.direction, { maxDistance: 100, filter: (b) => b.name !== 'wall' });
    if (!hit) return this._all();
    if (this.env.sculpture.holds(hit.body)) return () => this.env.sculpture.explode();
    if (!hit.body.isDynamic) return () => this.env.blast([hit.point.x, hit.point.y + 0.05, hit.point.z], this.options.floorRadius);
    const { centre, reach } = Detonator._extent(world.connected(hit.body));
    return () => this.env.blast(centre, Math.max(this.options.minRadius, 1.25 * reach + 0.3));
  }

  /** Blows the scene apart from its mass centre, lowered to a third of its height, so parts fly up and out. */
  all() {
    this._all()?.();
  }

  _all() {
    const centre = this.sceneCentre();
    return centre ? () => this.env.blast(centre, this.options.sceneRadius) : undefined;
  }

  /** Where a blast of the whole scene goes off: its mass centre, lowered to a third of its height (null: nothing to blow up). */
  sceneCentre() {
    const bodies = this.env.world().bodies.filter((b) => b.isDynamic);
    if (!bodies.length) return null;
    const { centre } = Detonator._extent(bodies);
    centre[1] = Math.max(0.05, centre[1] / 3);
    return centre;
  }

  /** Mass centre of `bodies` and how far their surfaces reach from it (bounding spheres). */
  static _extent(bodies) {
    const c = [0, 0, 0];
    let m = 0;
    for (const b of bodies) {
      c[0] += b.mass * b.position.x; c[1] += b.mass * b.position.y; c[2] += b.mass * b.position.z;
      m += b.mass;
    }
    const centre = c.map((v) => v / m);
    const reach = Math.max(...bodies.map((b) =>
      Math.hypot(b.position.x - centre[0], b.position.y - centre[1], b.position.z - centre[2]) + b.boundingRadius));
    return { centre, reach };
  }
}
