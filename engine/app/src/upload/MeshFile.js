import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MeshTopology } from '@sdfphys/core/segment';

/** The mesh files read here, by extension (glTF with its buffers and textures inside it). */
export const MESH_FILES = ['.glb', '.gltf', '.obj', '.stl', '.ply'];

const grey = () => new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.6, metalness: 0.1 });

/** Reads a mesh file (a File or Blob with a name) into a three.js scene. */
export async function readMeshFile(file) {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!MESH_FILES.includes(ext)) throw new Error(`not a mesh file (${MESH_FILES.join(' ')})`);
  if (ext === '.glb' || ext === '.gltf') {
    const data = ext === '.glb' ? await file.arrayBuffer() : await file.text();
    return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '')).scene;
  }
  if (ext === '.obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    return new OBJLoader().parse(await file.text());
  }
  const { STLLoader } = ext === '.stl' ? await import('three/addons/loaders/STLLoader.js') : {};
  const { PLYLoader } = ext === '.ply' ? await import('three/addons/loaders/PLYLoader.js') : {};
  const geometry = (STLLoader ? new STLLoader() : new PLYLoader()).parse(await file.arrayBuffer());
  if (STLLoader) geometry.deleteAttribute('normal'); // one per face, often left zero: made again (primitivesOf)
  const material = grey();
  if (geometry.getAttribute('color')) material.vertexColors = true;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  return group;
}

/**
 * Every triangle mesh of `scene` (lines and points skipped) as primitives { geometry, material }:
 * one per material (a multi-material mesh is split along its groups), node transforms applied
 * (a skinned mesh posed by its skeleton, as it is drawn: posed()), attributes as plain floats,
 * always indexed. Missing normals are made, smooth but for creases.
 */
export function primitivesOf(scene) {
  scene.updateMatrixWorld(true);
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const source = o.geometry;
    if (!source.getAttribute('position')) return;
    let geometry = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(source.attributes)) geometry.setAttribute(name, floats(a));
    if (source.index) geometry.setIndex(Array.from(source.index.array));
    else geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, i) => i));
    if (o.isSkinnedMesh) posed(o, geometry);
    geometry.applyMatrix4(o.matrixWorld);
    if (o.matrixWorld.determinant() < 0) flipWinding(geometry); // a mirroring node: keep the faces facing out
    if (!geometry.getAttribute('normal')) geometry = creased(geometry);
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    const groups = Array.isArray(o.material) && source.groups.length ? source.groups : [{ start: 0, count: geometry.index.count, materialIndex: 0 }];
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0] ?? grey();
      const part = groups.length > 1 ? subset(geometry, g.start / 3, g.count / 3) : geometry;
      if (part.index.count) out.push({ geometry: part, material });
    }
  });
  return out;
}

/**
 * A skinned mesh's copy moved to the pose its skeleton draws it in (its own space, as a plain
 * mesh's), its normals dropped to be made again, its skinning attributes with them. A file's
 * vertices are where the skin was bound, often lying down or turned (the giraffe of Goat
 * Simulator's, read without its skeleton, lay on its back).
 */
function posed(mesh, geometry) {
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) position.setXYZ(i, ...mesh.applyBoneTransform(i, v.fromBufferAttribute(position, i)));
  for (const name of ['normal', 'tangent', 'skinIndex', 'skinWeight']) geometry.deleteAttribute(name);
}

/**
 * Normals for a geometry that has none: at each corner, the mean of the faces around its point
 * (vertices at the same place count as one) folded less than `crease` from its own face, so
 * curves are smooth and creases sharp. A vertex whose corners disagree is split. Returns an
 * indexed geometry with every attribute kept.
 */
function creased(geometry, crease = (40 * Math.PI) / 180) {
  const P = geometry.attributes.position.array;
  const index = geometry.index.array;
  const nt = index.length / 3;
  const { remap } = MeshTopology.weld(P, 1e-6);
  const fn = new Float64Array(3 * nt); // area-weighted face normals
  const un = new Float64Array(3 * nt); // unit ones
  for (let f = 0; f < nt; f++) {
    const a = 3 * index[3 * f], b = 3 * index[3 * f + 1], c = 3 * index[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    fn.set([x, y, z], 3 * f);
    un.set([x / l, y / l, z / l], 3 * f);
  }
  // the faces around each welded point (counting sort of the corners)
  const points = remap.reduce((m, w) => Math.max(m, w + 1), 0);
  const start = new Int32Array(points + 1);
  for (let c = 0; c < 3 * nt; c++) start[remap[index[c]] + 1]++;
  for (let w = 0; w < points; w++) start[w + 1] += start[w];
  const around = new Int32Array(3 * nt);
  const fill = start.slice(0, points);
  for (let c = 0; c < 3 * nt; c++) around[fill[remap[index[c]]]++] = (c / 3) | 0;
  // each corner's normal; a vertex keeps one copy per distinct normal its corners get
  const cos = Math.cos(crease);
  const source = new Int32Array(3 * nt); // per output vertex: the vertex it copies...
  const normal = new Float32Array(9 * nt); // ...and its normal
  let count = 0;
  const copies = new Map(); // source vertex -> its output vertices
  const tris = new Uint32Array(3 * nt);
  for (let c = 0; c < 3 * nt; c++) {
    const f = (c / 3) | 0, v = index[c], w = remap[v];
    let x = 0, y = 0, z = 0;
    for (let s = start[w]; s < start[w + 1]; s++) {
      const g = around[s];
      if (un[3 * g] * un[3 * f] + un[3 * g + 1] * un[3 * f + 1] + un[3 * g + 2] * un[3 * f + 2] < cos) continue;
      x += fn[3 * g]; y += fn[3 * g + 1]; z += fn[3 * g + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const list = copies.get(v) ?? [];
    let o = list.find((k) => normal[3 * k] * x + normal[3 * k + 1] * y + normal[3 * k + 2] * z > 0.9999);
    if (o === undefined) {
      o = count++;
      source[o] = v;
      normal.set([x, y, z], 3 * o);
      list.push(o);
      copies.set(v, list);
    }
    tris[c] = o;
  }
  const result = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geometry.attributes)) {
    const k = a.itemSize;
    const data = new Float32Array(count * k);
    for (let i = 0; i < count; i++) for (let j = 0; j < k; j++) data[i * k + j] = a.array[source[i] * k + j];
    result.setAttribute(name, new THREE.BufferAttribute(data, k));
  }
  result.setAttribute('normal', new THREE.BufferAttribute(normal.slice(0, 3 * count), 3));
  result.setIndex(new THREE.BufferAttribute(tris, 1));
  return result;
}

function flipWinding(geometry) {
  const index = geometry.index.array;
  for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
}

/** A float copy of an attribute (glTF may quantize, normalize or interleave them). */
function floats(a) {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

/**
 * The triangles `first` .. `first + count` of an indexed geometry (or those listed in
 * `triangles`), with only the vertices they use: every attribute copied, re-indexed.
 */
export function subset(geometry, first, count, triangles = null) {
  const index = geometry.index.array;
  const list = triangles ?? Array.from({ length: count }, (_, i) => first + i);
  const remap = new Map();
  const order = [];
  const tris = new Uint32Array(3 * list.length);
  list.forEach((t, i) => {
    for (let c = 0; c < 3; c++) {
      const v = index[3 * t + c];
      if (!remap.has(v)) {
        remap.set(v, order.length);
        order.push(v);
      }
      tris[3 * i + c] = remap.get(v);
    }
  });
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geometry.attributes)) {
    const k = a.itemSize;
    const data = new Float32Array(order.length * k);
    order.forEach((v, i) => { for (let c = 0; c < k; c++) data[i * k + c] = a.array[v * k + c]; });
    out.setAttribute(name, new THREE.BufferAttribute(data, k));
  }
  out.setIndex(new THREE.BufferAttribute(tris, 1));
  return out;
}

/** The primitives as meshes in a group (to draw or picture them). */
export function meshGroup(primitives) {
  const g = new THREE.Group();
  for (const { geometry, material } of primitives) g.add(new THREE.Mesh(geometry, material));
  return g;
}

/** All primitives' triangles as one mesh { V (xyz), F (3 per triangle) }: what a target or a segmentation needs. */
export function triangleSoup(primitives) {
  let nv = 0, nt = 0;
  for (const { geometry } of primitives) {
    nv += geometry.attributes.position.count;
    nt += geometry.index.count;
  }
  const V = new Float32Array(3 * nv);
  const F = new Uint32Array(nt);
  let v = 0, t = 0;
  for (const { geometry } of primitives) {
    const base = v / 3;
    V.set(geometry.attributes.position.array, v);
    v += geometry.attributes.position.array.length;
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i++) F[t++] = base + index[i];
  }
  return { V, F };
}

/**
 * Scales and moves the primitives (in place) so that their largest side is `size` and they stand
 * centred over the origin on y = 0, as the models do. Returns the scale applied.
 */
export function standUp(primitives, size = 1) {
  const box = new THREE.Box3();
  for (const { geometry } of primitives) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  const extent = box.getSize(new THREE.Vector3());
  const scale = size / (Math.max(extent.x, extent.y, extent.z) || 1);
  const centre = box.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
  for (const { geometry } of primitives) geometry.applyMatrix4(m);
  return scale;
}
