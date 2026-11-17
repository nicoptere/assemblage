import * as THREE from 'three';

/**
 * A simple photo studio to reflect (Stage: PMREMGenerator.fromScene): a pale grey room, lit by four
 * softboxes, emissive panels as bright as `light` (linear): a big one overhead, a key to the front
 * left, a fill to the right, a strip behind. Glossy surfaces (the white ceramic) show them as soft
 * highlights; rough ones take a gentle, even light from them.
 */
export class StudioEnvironment extends THREE.Scene {
  constructor({ wall = 0.55, light = 8 } = {}) {
    super();
    const room = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(wall), side: THREE.BackSide }));
    room.position.y = 2.5; // the floor 1 m under the origin, the ceiling 6 m over it
    this.add(room);
    const box = (width, height, strength, position) => {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(strength * light), side: THREE.DoubleSide }));
      panel.position.set(...position);
      panel.lookAt(0, 0, 0);
      this.add(panel);
    };
    box(5, 5, 1, [0, 5.5, 0]); // overhead
    box(2.5, 3.5, 1.2, [-4.5, 2.5, 3.5]); // key
    box(2, 3, 0.5, [5, 1.5, 2]); // fill
    box(6, 1, 0.8, [0, 2, -5.5]); // strip behind
  }

  dispose() {
    this.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
}
