import { Vec3 } from '@sdfphys/core';

/**
 * Click to focus the depth of field: a click (press and release without moving, so orbiting and
 * dragging do not count) on a part keeps that point of the part sharp as it moves; on the floor,
 * that point; on the background, focus goes back to what the camera orbits. Picking is the
 * engine's SDF raycast (walls aside).
 */
export class FocusTool {
  constructor(stage, getWorld, { slop = 4 } = {}) {
    this.stage = stage;
    this.getWorld = getWorld;
    this._point = new Vec3();
    const el = stage.renderer.domElement;
    let down = null;
    // capture: the drag tool stops the events it uses
    window.addEventListener('pointerdown', (e) => { down = e.button === 0 && e.target === el ? [e.clientX, e.clientY] : null; }, true);
    window.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= slop) this.at(e);
      down = null;
    }, true);
  }

  /** Focuses on what is under a pointer event. */
  at(e) {
    const ray = this.stage.ray(e);
    const hit = this.getWorld().raycast(ray.origin, ray.direction, { maxDistance: 100, filter: (b) => b.name !== 'wall' });
    if (!hit) return this.reset();
    const b = hit.body;
    if (b.type === 'static') {
      const p = hit.point.clone();
      this.stage.setFocus(() => p);
      return;
    }
    const local = hit.point.clone().sub(b.position).applyQuatInverse(b.quaternion);
    this.stage.setFocus(() => this._point.copy(local).applyQuat(b.quaternion).add(b.position));
  }

  /** Back to the orbit target (a new scene). */
  reset() {
    this.stage.setFocus(null);
  }
}
