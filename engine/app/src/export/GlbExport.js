import * as THREE from 'three';

/**
 * Parts as they are drawn now, in one GLB (binary glTF, metres, Y up): a node per part, named
 * after it, in its pose. A part's triangles are cut out of its model's merged geometry (PartSkin:
 * the vertices whose `part` is its index), one mesh per material, in that material (the file's
 * textures, or the ceramic and copper finishes: GLTFExporter keeps the clear coat as
 * KHR_materials_clearcoat); vertex colours only where the model has some. The whole stands on the
 * origin: its bounds centred over it, its lowest point on the ground. Nothing in it requires an
 * extension, so any glTF reader opens it (portable()): the mechs' textures are WebP, which glTF only
 * has as an extension (EXT_texture_webp) many readers lack (F3D, MeshLab, Exhibit refused the file).
 * `parts`: PartSkin handles ({ owner: the PartSkin, index: the part, matrix: its pose }).
 * Resolves to the GLB's bytes (an ArrayBuffer).
 */
export async function exportGlb(parts) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js'); // only when asked for
  const scene = new THREE.Group();
  scene.name = 'assemblage';
  const materials = new Map(); // drawn material -> its exported copy (one per material, so textures are written once)
  for (const { owner, index, matrix } of parts) {
    const node = new THREE.Group();
    node.name = owner.names[index];
    node.applyMatrix4(matrix);
    for (const mesh of owner.meshes) {
      const geometry = partGeometry(mesh.geometry, index);
      if (!geometry) continue;
      if (!materials.has(mesh.material)) materials.set(mesh.material, plainCopy(mesh.material));
      const material = materials.get(mesh.material);
      if (!material.vertexColors) geometry.deleteAttribute('color');
      node.add(new THREE.Mesh(geometry, material));
    }
    scene.add(node);
  }
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const centre = box.getCenter(new THREE.Vector3());
  for (const node of scene.children) node.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
  return new GLTFExporter().parseAsync(scene, { binary: true });
}

/** Saves `blob` as a file named `name` (the browser's download). */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Part `index`'s triangles of a merged PartSkin geometry, as a geometry of their own (null: none there). */
function partGeometry(merged, index) {
  const part = merged.getAttribute('part');
  const source = merged.index.array;
  const remap = new Map(); // merged vertex -> its own
  const triangles = [];
  for (let t = 0; t < source.length; t += 3) {
    if (part.getX(source[t]) !== index) continue; // a triangle's vertices are all one part's
    for (let k = 0; k < 3; k++) {
      const v = source[t + k];
      if (!remap.has(v)) remap.set(v, remap.size);
      triangles.push(remap.get(v));
    }
  }
  if (!triangles.length) return null;
  const vertices = [...remap.keys()];
  const geometry = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(merged.attributes)) {
    if (name === 'part') continue;
    const values = new a.array.constructor(vertices.length * a.itemSize);
    vertices.forEach((v, i) => { for (let c = 0; c < a.itemSize; c++) values[i * a.itemSize + c] = a.array[v * a.itemSize + c]; });
    geometry.setAttribute(name, new THREE.BufferAttribute(values, a.itemSize, a.normalized));
  }
  geometry.setIndex(triangles);
  return geometry;
}

/**
 * A drawn part material as a plain one to export: PartSkin's copy carries the vertex colours for
 * its tints (white where the model has none); they are kept only if the model has some.
 */
function plainCopy(material) {
  const copy = material.clone();
  copy.vertexColors = material.userData.vertexColors ?? false;
  copy.userData = {}; // GLTFExporter writes it out as extras
  const seeThrough = copy.transparent || copy.alphaTest > 0;
  for (const [name, value] of Object.entries(copy)) {
    if (value?.isTexture) copy[name] = portable(value, name === 'alphaMap' || (name === 'map' && seeThrough) ? 'image/png' : 'image/jpeg');
  }
  return copy;
}

const portables = new WeakMap(); // texture -> { mimeType: its copy }

/**
 * A copy of `texture` written as `mimeType`, a format every glTF reader takes (core glTF has only
 * PNG and JPEG): PNG where its alpha counts (a see-through or cut-out colour map), JPEG otherwise.
 * GLTFExporter re-encodes the image as the texture's `userData.mimeType` says.
 */
function portable(texture, mimeType) {
  if (!portables.has(texture)) portables.set(texture, {});
  const copies = portables.get(texture);
  copies[mimeType] ??= Object.assign(texture.clone(), { userData: { ...texture.userData, mimeType } });
  return copies[mimeType];
}
