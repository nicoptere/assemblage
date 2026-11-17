/**
 * Mesh in, assembly out: a triangle mesh split into parts along its creases (Segmenter), each
 * part closed and baked into a distance grid and samples, the touching ones jointed
 * (bakeAssembly), all in plain JS: what physbake does offline, for meshes dropped in a browser.
 */
import { MeshTopology } from './MeshTopology.js';
import { Segmenter } from './Segmenter.js';
import { bakeAssembly } from './AssemblyBaker.js';

export { MeshTopology } from './MeshTopology.js';
export { Segmenter, SEGMENT_DEFAULTS } from './Segmenter.js';
export { bakeAssembly, BAKE_DEFAULTS } from './AssemblyBaker.js';
export { bakeSdf } from './SdfBake.js';
export { capBorders, closedPart } from './Caps.js';
export { TrapSplitter, TRAP_DEFAULTS } from './TrapSplitter.js';
export { pocketOf } from './Pocket.js';
export { ConvexHull } from './ConvexHull.js';

/**
 * The whole pipeline on `positions` (xyz) and `indices` (3 per triangle), in metres:
 * { segment: Segmenter options, bake: bakeAssembly options (name...) }. `report(fraction)` hears
 * how far it is. Returns { labels (part per input triangle, -1: dropped), manifest, buffer, caps, stats }.
 */
export function segmentMesh(positions, indices, { segment = {}, bake = {} } = {}, report = () => {}) {
  const t0 = Date.now();
  const topology = new MeshTopology(positions, indices);
  report(0.05);
  const { labels, count, stats } = new Segmenter(topology, segment).run((f) => report(0.05 + 0.1 * f));
  const t1 = Date.now();
  const { manifest, buffer, caps } = bakeAssembly(topology, labels, count, bake, (f) => report(0.15 + 0.85 * f));
  Object.assign(stats, { faces: topology.faceCount, vertices: topology.vertexCount, shells: topology.shells, joints: manifest.joints.length, segmentMs: t1 - t0, bakeMs: Date.now() - t1 });
  return { labels, manifest, buffer, caps, stats };
}
