import { TargetVolume, ShapeFit } from '@sdfphys/core/fit';

/**
 * Builds rebuild targets and fits parts into them, off the main thread (see FitWorker).
 *   { type: 'mesh', name, V, F }                      keeps a target mesh
 *   { type: 'target', id, name, place }               -> 'target' (TargetVolume.place settings)
 *   { type: 'fit', id, name, place, stencils, fit }   -> 'target', then 'place' for every part placed
 *                                                       (as found), 'progress', and 'done'
 * Errors come back as 'error'. The last target is kept, so fitting what was just previewed does
 * not build it again.
 */
const meshes = new Map();
let last = { key: '', target: null };

function target(name, place) {
  const key = JSON.stringify([name, place]);
  if (key !== last.key) {
    const mesh = meshes.get(name);
    if (!mesh) throw new Error(`no mesh '${name}'`);
    last = { key, target: TargetVolume.place(mesh, place) };
  }
  return last.target;
}

function describe(id, t) {
  const vertices = Float32Array.from(t.vertices);
  const surface = t.surface();
  const { centre, size } = TargetVolume.bounds(t.vertices);
  postMessage({ type: 'target', id, vertices, surface, voxel: t.voxel, grid: [t.nx, t.ny, t.nz], count: t.count, volume: t.volume, centre, size, transform: t.transform }, [vertices.buffer, surface.buffer]);
}

function fit(id, t, stencils, options) {
  const run = new ShapeFit(t, options).run(stencils);
  let quiet = performance.now();
  for (let r = run.next(); ; r = run.next()) {
    if (r.done) {
      postMessage({ type: 'done', id, placed: r.value.placements.length, stats: r.value.stats });
      return;
    }
    const { done, total, placed, placement } = r.value;
    if (placement) postMessage({ type: 'place', id, done, total, placed, placement });
    else if (performance.now() - quiet > 100) postMessage({ type: 'progress', id, done, total, placed });
    else continue;
    quiet = performance.now();
  }
}

onmessage = ({ data: m }) => {
  try {
    if (m.type === 'mesh') {
      meshes.set(m.name, { V: m.V, F: m.F });
      return;
    }
    const t = target(m.name, m.place);
    describe(m.id, t);
    if (m.type === 'fit') fit(m.id, t, m.stencils, m.fit);
  } catch (e) {
    postMessage({ type: 'error', id: m.id, message: e.message });
  }
};
