import * as THREE from 'three';
import { RigidBody, SphereShape } from '@sdfphys/core';

/**
 * Fires small, heavy balls from the camera along a ray (2 cm across at 80 m/s, three times as dense
 * as steel, black). Keeps at most `max` balls alive. A ball is drawn growing from nothing to its
 * size over its first `grow` seconds (simulation time), so it does not fill the view as it leaves
 * the camera; the physics ball is full size from the start.
 */
export class Cannon {
  constructor(views, { radius = 0.01, speed = 80, density = 3 * 7800, color = 0x111111, max = 32, grow = 0.35 } = {}) {
    this.views = views;
    this.options = { radius, speed, density, max, grow };
    this.balls = [];
    this.growing = []; // [{ mesh, born }]
    this.material = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.3 });
    this._geometry = null;
    this._radius = 0;
  }

  _mesh(radius) {
    if (radius !== this._radius) {
      this._geometry = new THREE.SphereGeometry(radius, 24, 16);
      this._radius = radius;
    }
    const mesh = new THREE.Mesh(this._geometry, this.material);
    mesh.castShadow = true;
    return mesh;
  }

  fire(world, ray) {
    const { radius, speed, density, max } = this.options;
    const d = ray.direction;
    const start = ray.origin.clone().addScaledVector(d, 0.15);
    const ball = world.addBody(new RigidBody({
      shape: new SphereShape(radius),
      position: [start.x, start.y, start.z],
      velocity: [d.x * speed, d.y * speed, d.z * speed],
      density,
      friction: 0.4,
      restitution: 0.3,
      ccd: true,
      name: 'ball',
    }));
    const mesh = this._mesh(radius);
    mesh.scale.setScalar(1e-3);
    this.views.add(ball, mesh);
    this.growing.push({ mesh, born: world.time });
    this.balls.push(ball);
    while (this.balls.length > max) {
      const old = this.balls.shift();
      world.removeBody(old);
      this.views.remove(old);
    }
    return ball;
  }

  /** Scales the balls still growing, at simulation time `time`. */
  update(time) {
    if (!this.growing.length) return;
    this.growing = this.growing.filter(({ mesh, born }) => {
      const s = Math.min(1, Math.max(0, (time - born) / this.options.grow));
      mesh.scale.setScalar(Math.max(1e-3, s));
      return s < 1;
    });
  }

  clear() {
    this.balls.length = 0;
    this.growing.length = 0;
  }
}
