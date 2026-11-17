import * as THREE from 'three';
import { GroundMaterial } from './Ground.js';

/**
 * The walls' marks: a flat frame `cell` m wide around them, a little above the floor, painted with
 * diagonal stripes (`stripes` a cell, in world space so they run on round the corners) and a line
 * along the walls, over the floor's own colour and grid (GroundMaterial): 8 vertices, 8 triangles.
 * It is opaque and drawn first, so the parts lying on it hide it. set(half): the walls `half` m
 * from the centre, null hides it.
 */
export class WallFrame {
  constructor(scene, { cell, color, stripes = 10, share = 0.4, opacity = 0.7, height = 0.003 }) {
    this.cell = cell;
    this.half = null;
    const material = new GroundMaterial({ cell, stripes: { color, opacity, period: cell / stripes, share } });
    Object.assign(material, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }); // over the floor, never in it
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.position.y = height;
    this.mesh.renderOrder = -1;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  set(half) {
    this.mesh.visible = half != null;
    if (half == null || half === this.half) return;
    this.half = half;
    // the outer square then the inner one, corner by corner; a quad a side between them, facing up
    const square = (r) => [[-r, -r], [r, -r], [r, r], [-r, r]];
    const corners = [...square(half + this.cell), ...square(half)];
    const index = [0, 1, 2, 3].flatMap((k) => {
      const [a, b, c, d] = [k, (k + 1) % 4, 4 + ((k + 1) % 4), 4 + k];
      return [a, c, b, a, d, c];
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, z]) => [x, 0, z]), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(corners.flatMap(() => [0, 1, 0]), 3));
    geometry.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.material.setEdge(half);
  }
}
