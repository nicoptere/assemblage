import * as THREE from 'three';
import { PointConstraint } from '@sdfphys/core';

/**
 * Grab-and-pull for any dynamic body, ragdoll style. Picking uses the engine's SDF raycast
 * (sphere tracing), so what you grab is exactly what collides. The grabbed point follows the
 * pointer on a camera-facing plane through the grab point. `picked`: the body held, or else the
 * one held last, while it is still in the world.
 */
export class DragTool {
  constructor(stage, getWorld, { compliance = 5e-5, damping = 3, maxForce = 5000 } = {}) {
    this.stage = stage;
    this.getWorld = getWorld;
    this.options = { compliance, damping, maxForce };
    this.constraint = null;
    this.last = null; // the body grabbed last
    this.plane = new THREE.Plane();
    this.ray = new THREE.Ray();
    this.hit = new THREE.Vector3();

    this.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false }),
    );
    this.line.renderOrder = 20;
    this.line.visible = false;
    this.line.frustumCulled = false;
    stage.scene.add(this.line);

    const el = stage.renderer.domElement;
    // capture phase: runs before OrbitControls, so a grab never starts an orbit
    el.addEventListener('pointerdown', (e) => this._down(e), { capture: true });
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e));
  }

  get active() {
    return this.constraint !== null;
  }

  get picked() {
    const body = this.constraint?.body ?? this.last;
    return body && this.getWorld().bodies.includes(body) ? body : null;
  }

  _down(e) {
    if (e.button !== 0 || e.shiftKey) return;
    const world = this.getWorld();
    const ray = this.stage.ray(e, this.ray);
    const hit = world.raycast(ray.origin, ray.direction, { filter: (b) => b.isDynamic, maxDistance: 50 });
    if (!hit) return;
    this.constraint = world.addConstraint(new PointConstraint(hit.body, hit.point, this.options));
    this.last = hit.body;
    const normal = this.stage.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.plane.setFromNormalAndCoplanarPoint(normal, this.hit.set(hit.point.x, hit.point.y, hit.point.z));
    this.stage.controls.enabled = false;
    e.stopImmediatePropagation();
    e.target.setPointerCapture(e.pointerId);
    this.line.visible = true;
  }

  _move(e) {
    if (!this.constraint) return;
    const ray = this.stage.ray(e, this.ray);
    if (ray.intersectPlane(this.plane, this.hit)) this.constraint.target.set(this.hit.x, this.hit.y, this.hit.z);
  }

  _up() {
    this.release();
  }

  release() {
    if (!this.constraint) return;
    this.getWorld().removeConstraint(this.constraint);
    this.constraint = null;
    this.line.visible = false;
    this.stage.controls.enabled = true;
  }

  /** Drops the grab without touching the (possibly already replaced) world. */
  forget() {
    this.constraint = null;
    this.last = null;
    this.line.visible = false;
    this.stage.controls.enabled = true;
  }

  update() {
    const c = this.constraint;
    if (!c) return;
    if (!this.getWorld().bodies.includes(c.body)) return this.forget();
    const p = c.worldPoint(c.body.position.clone());
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, p.x, p.y, p.z);
    pos.setXYZ(1, c.target.x, c.target.y, c.target.z);
    pos.needsUpdate = true;
  }
}
