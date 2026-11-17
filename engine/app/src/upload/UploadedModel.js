import * as THREE from 'three';
import { Assembly } from '@sdfphys/core';
import { AssemblyModel } from '../model/AssemblyModel.js';
import { PartSkin } from '../render/PartSkin.js';
import { snapshotObject } from '../model/Thumbnail.js';
import { readMeshFile, primitivesOf, triangleSoup, standUp, subset, meshGroup } from './MeshFile.js';
import { segmentInWorker } from './SegmentWorker.js';
import { opaqueIfSolid } from './SeeThrough.js';

export const MAX_TRIANGLES = 600000;
export const SEGMENT_ANGLE = 75; // deg: creases sharper than this split an upload into parts (Segmenter's `angle`; the mechs were split at 90°)

// a textured part's cut faces, closing it: hidden while it holds (mostly), dark once it comes off
const CAP = new THREE.MeshStandardMaterial({ color: 0x34373d, roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide });
// untextured surfaces, and their parts' caps, by the size of their part (finishes()): glazed ceramic, white
// for the large ones and black for the middle ones (the studio's softboxes in their glaze), copper for the small ones
const WHITE = ceramic(0xd2cec6);
const BLACK = ceramic(0x1d1d20);
const COPPER = new THREE.MeshPhysicalMaterial({ color: 0xd98c5f, metalness: 1, roughness: 0.3 }); // richer than copper's measured reflectance, which reads pale pink in the white studio

/**
 * A mesh file (GLB, glTF, OBJ, STL, PLY) turned into a model the scene can drop, rain and
 * rebuild from: read, stood up (largest side `size` m, centred on the ground), pictured, then
 * segmented (creases over SEGMENT_ANGLE) and baked into parts in a worker (@sdfphys/core/segment); the parts are drawn with
 * the file's own materials, cut out along the same faces as their physics. `report(fraction,
 * note)` hears how far it is, `onThumb(url)` gets the picture as soon as it is made. Resolves to
 * an AssemblyModel, its `stats` saying what the segmentation did.
 */
export async function loadUploadedModel(file, { name = file.name, size = 1, report = () => {}, onThumb = () => {} } = {}) {
  report(0, `reading ${name}`);
  const primitives = primitivesOf(await readMeshFile(file));
  const triangles = primitives.reduce((n, p) => n + p.geometry.index.count / 3, 0);
  if (!triangles) throw new Error('no triangles in it');
  if (triangles > MAX_TRIANGLES) throw new Error(`${Math.round(triangles / 1000)}k triangles: at most ${MAX_TRIANGLES / 1000}k`);
  standUp(primitives, size);
  onThumb(await snapshotObject(meshGroup(primitives)));
  const { V, F } = triangleSoup(primitives);
  const note = `segmenting ${name}`;
  report(0.05, note);
  const result = await segmentInWorker(V, F, { segment: { angle: SEGMENT_ANGLE }, bake: { name } }, (f) => report(0.05 + 0.9 * f, note));
  const assembly = new Assembly(result.manifest, result.buffer);
  const model = new AssemblyModel(assembly, new PartSkin(renderParts(primitives, result, assembly)));
  model.stats = result.stats;
  report(1, note);
  return model;
}

/**
 * Each part's primitives for PartSkin: the triangles of every file primitive labelled with it
 * (in the file's material, made opaque where the part does not show through it, or the part's
 * finish if the material has neither texture nor vertex colours and is not see-through), plus its caps (in its finish on a plain part, where a cap
 * poking through the surface then hardly shows; dark on a textured one).
 */
function renderParts(primitives, { labels, caps }, assembly) {
  const parts = new Map(assembly.parts.map((p) => [p.name, []]));
  const nameOf = (l) => assembly.parts[l].name;
  const finish = finishes(assembly.parts);
  const plainParts = new Set();
  let face = 0;
  for (const { geometry, material } of primitives) {
    const n = geometry.index.count / 3;
    const byPart = new Map();
    for (let t = 0; t < n; t++) {
      const l = labels[face + t];
      if (l < 0) continue;
      if (!byPart.has(l)) byPart.set(l, []);
      byPart.get(l).push(t);
    }
    face += n;
    for (const [l, tris] of byPart) {
      const shown = opaqueIfSolid(material, geometry, tris); // see-through only where it shows through
      const plain = !shown.map && !geometry.getAttribute('color') && !shown.transparent; // a see-through one keeps its look
      if (plain) plainParts.add(l);
      parts.get(nameOf(l)).push({ geometry: subset(geometry, 0, 0, tris), material: plain ? finish[l] : shown });
    }
    geometry.dispose();
  }
  caps.forEach((tris, l) => {
    if (!tris.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from({ length: tris.length / 3 }, (_, i) => i), 1)); // indexed, as the parts are
    g.computeVertexNormals();
    parts.get(nameOf(l)).push({ geometry: g, material: plainParts.has(l) ? finish[l] : CAP });
  });
  return parts;
}

/**
 * The finish of each part by its surface area: from the largest down, the parts that make the first
 * half of the model's area are white ceramic, those up to 85% black ceramic, the small rest copper.
 */
function finishes(parts) {
  const total = parts.reduce((sum, p) => sum + p.area, 0);
  const finish = new Array(parts.length);
  let sum = 0;
  for (const i of parts.map((_, i) => i).sort((a, b) => parts[b].area - parts[a].area)) {
    finish[i] = sum < 0.5 * total ? WHITE : sum < 0.85 * total ? BLACK : COPPER;
    sum += parts[i].area;
  }
  return finish;
}

/** A glazed ceramic: a physical material under a glossy clear coat. */
function ceramic(color) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
}
