import { snapshotObject } from '../model/Thumbnail.js';
import { readMeshFile, primitivesOf, triangleSoup, meshGroup } from './MeshFile.js';

/**
 * A mesh file as a rebuild target, as it is (the rebuild sizes and voxelises it): its triangles
 * { V, F } (as TargetMesh gives them) and its picture for the gallery.
 */
export async function loadUploadedTarget(file) {
  const primitives = primitivesOf(await readMeshFile(file));
  const { V, F } = triangleSoup(primitives);
  if (!F.length) throw new Error('no triangles in it');
  const picture = await snapshotObject(meshGroup(primitives));
  for (const { geometry } of primitives) geometry.dispose();
  return { mesh: { V: Float64Array.from(V), F: Int32Array.from(F) }, picture };
}
