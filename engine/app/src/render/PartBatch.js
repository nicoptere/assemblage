import * as THREE from 'three';

/** Materials that render identically share a key (same type, scalars and textures). */
function materialKey(m) {
  const key = [m.type, m.side, m.transparent, m.opacity, m.color?.getHex(), m.metalness, m.roughness, m.vertexColors];
  for (const name of Object.keys(m)) if (m[name]?.isTexture) key.push(name, m[name].uuid);
  return key.join('|');
}

/**
 * Every part mesh of one model, drawn with one THREE.BatchedMesh per distinct material: the part
 * geometries are uploaded once, and each spawned part is an instance whose matrix follows its
 * body. A model of N parts costs one draw call (plus one per shadow map) instead of N.
 *
 * `parts` maps a part name to its primitives [{ geometry, material }], in model space.
 */
export class PartBatch {
  constructor(parts, { capacity = parts.size || 1 } = {}) {
    this.object = new THREE.Group();
    this.object.name = 'parts';
    this.geometries = new Map(); // part name -> [{ mesh, geometryId }]

    const groups = new Map(); // material key -> { material, items: [{ name, geometry }] }
    for (const [name, primitives] of parts) {
      for (const { geometry, material } of primitives) {
        const key = materialKey(material);
        if (!groups.has(key)) groups.set(key, { material, items: [] });
        groups.get(key).items.push({ name, geometry });
      }
    }
    for (const { material, items } of groups.values()) {
      const vertices = items.reduce((n, { geometry }) => n + geometry.attributes.position.count, 0);
      const indices = items.reduce((n, { geometry }) => n + (geometry.index?.count ?? 0), 0);
      const mesh = new THREE.BatchedMesh(capacity, vertices, indices, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // its overall bounds go stale as parts fly; instances are culled one by one
      this.object.add(mesh);
      for (const { name, geometry } of items) {
        if (!this.geometries.has(name)) this.geometries.set(name, []);
        this.geometries.get(name).push({ mesh, geometryId: mesh.addGeometry(geometry) });
        geometry.dispose();
      }
    }
  }

  /** New instance of a part (all its primitives); grows the batches when they are full. */
  addPart(name) {
    const instances = (this.geometries.get(name) ?? []).map(({ mesh, geometryId }) => {
      if (mesh.instanceCount >= mesh.maxInstanceCount) mesh.setInstanceCount(mesh.maxInstanceCount * 2);
      return { mesh, id: mesh.addInstance(geometryId) };
    });
    return new BatchedPart(this, instances);
  }
}

/** One spawned part inside a PartBatch: what BodyViews moves, tints, hides and disposes. */
export class BatchedPart {
  constructor(batch, instances) {
    this.batch = batch;
    this.instances = instances;
    this._visible = true;
  }

  setMatrix(matrix) {
    for (const { mesh, id } of this.instances) mesh.setMatrixAt(id, matrix);
  }

  setColor(color) {
    for (const { mesh, id } of this.instances) mesh.setColorAt(id, color);
  }

  get visible() {
    return this._visible;
  }

  set visible(on) {
    this._visible = on;
    for (const { mesh, id } of this.instances) mesh.setVisibleAt(id, on);
  }

  dispose() {
    for (const { mesh, id } of this.instances) mesh.deleteInstance(id);
    this.instances = [];
  }
}
