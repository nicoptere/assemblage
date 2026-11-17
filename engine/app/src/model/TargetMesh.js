import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { primitivesOf, triangleSoup } from '../upload/MeshFile.js';

/**
 * A shape to rebuild: the triangles of every mesh in a GLB (lines and points, like the feature
 * curves of the decomposed targets, are skipped), node transforms applied, as { V, F } in the
 * file's units; `report(fraction)` hears how the file comes. Rendering the target is done from the
 * placed copy (TargetVolume.vertices).
 */
export async function loadTargetMesh(url, report = () => {}) {
  const gltf = await new GLTFLoader().loadAsync(url, (e) => e.lengthComputable && report(e.loaded / e.total));
  const primitives = primitivesOf(gltf.scene);
  const { V, F } = triangleSoup(primitives);
  for (const { geometry } of primitives) geometry.dispose();
  return { V: Float64Array.from(V), F: Int32Array.from(F) };
}

/** The simple shapes listed first among the targets (a box twice as tall as wide, a sphere, an octahedron): { name, thumb, geometry() (three.js), mesh() -> { V, F } }. */
export const PRIMITIVES = [
  ['box', () => new THREE.BoxGeometry(1, 2, 1)],
  ['sphere', () => new THREE.SphereGeometry(0.5, 48, 24)],
  ['octahedron', () => new THREE.OctahedronGeometry(0.5, 0)],
].map(([shape, geometry]) => ({ name: `primitive: ${shape}`, thumb: `thumbs/primitive_${shape}.png`, geometry, mesh: () => geometryMesh(geometry()) }));

/** A three.js geometry's triangles as { V, F } (the geometry is disposed of). */
export function geometryMesh(geometry) {
  const V = Float64Array.from(geometry.attributes.position.array);
  const F = geometry.index ? Int32Array.from(geometry.index.array) : Int32Array.from({ length: V.length / 3 }, (_, i) => i);
  geometry.dispose();
  return { V, F };
}

/** A see-through copy of a placed target (world-space vertices), to compare the build with. */
export function ghostMesh(vertices, F) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(vertices), 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(F), 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x8fb4ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rebuild target';
  mesh.renderOrder = 2;
  return mesh;
}

const MAX_VOXELS = 200000;

/**
 * The target's skin as voxels (instanced boxes a little smaller than a voxel), so the resolution,
 * the shell and the size of what a fit will fill are visible before it runs. `surface`: xyz
 * centres (TargetVolume.surface); beyond MAX_VOXELS an even subset is drawn.
 */
export function voxelMesh(surface, voxel) {
  const n = surface.length / 3;
  const stride = Math.max(1, Math.ceil(n / MAX_VOXELS));
  const count = Math.ceil(n / stride);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x9fc2ff, roughness: 0.7, transparent: true, opacity: 0.55, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const m = new THREE.Matrix4();
  const s = 0.8 * voxel;
  for (let i = 0, k = 0; i < n; i += stride, k++) {
    m.makeScale(s, s, s).setPosition(surface[i * 3], surface[i * 3 + 1], surface[i * 3 + 2]);
    mesh.setMatrixAt(k, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'rebuild target voxels';
  mesh.renderOrder = 2;
  return mesh;
}
