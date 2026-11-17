import * as THREE from 'three';

/**
 * A radial blast. Every dynamic body within `radius` of `centre` gets a velocity kick away from
 * it (biased upwards by `lift`), `speed` m/s at the centre fading linearly to 0 at the radius,
 * plus a random tumble; welds and anchors tear where neighbours are kicked apart. A light flash
 * shows it for a moment (`update` animates it).
 */
export class Explosion {
  constructor(scene) {
    this.scene = scene;
    this.flashes = [];
  }

  blast(world, centre, { speed = 12, radius = 2.5, lift = 0.35 } = {}) {
    const c = new THREE.Vector3(...centre);
    const d = new THREE.Vector3();
    let hit = 0;
    for (const b of world.bodies) {
      if (b.type !== 'dynamic') continue;
      d.set(b.position.x - c.x, b.position.y - c.y, b.position.z - c.z);
      const dist = d.length();
      if (dist >= radius) continue;
      const kick = speed * (1 - dist / radius);
      if (dist < 1e-6) d.set(0, 1, 0);
      d.normalize();
      d.y += lift;
      d.normalize().multiplyScalar(kick);
      b.wake();
      b.velocity.x += d.x;
      b.velocity.y += d.y;
      b.velocity.z += d.z;
      const spin = (0.5 * kick) / Math.max(0.05, b.boundingRadius);
      b.angularVelocity.x += spin * (Math.random() * 2 - 1);
      b.angularVelocity.y += spin * (Math.random() * 2 - 1);
      b.angularVelocity.z += spin * (Math.random() * 2 - 1);
      hit++;
    }
    const light = new THREE.PointLight(0xffb060, 0, 4 * radius, 1.5);
    light.position.copy(c);
    this.scene.add(light);
    this.flashes.push({ light, age: 0, peak: 40 * speed });
    return hit;
  }

  /** Fades the flashes (seconds of real time). */
  update(dt) {
    for (const f of this.flashes) {
      f.age += dt;
      f.light.intensity = f.peak * Math.exp(-8 * f.age);
    }
    for (const f of this.flashes.filter((x) => x.age > 0.6)) {
      this.scene.remove(f.light);
      f.light.dispose();
    }
    this.flashes = this.flashes.filter((x) => x.age <= 0.6);
  }
}
