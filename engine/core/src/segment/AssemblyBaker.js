import { SdfGridShape } from '../shapes/SdfGridShape.js';
import { Vec3 } from '../math/Vec3.js';
import { bakeSdf } from './SdfBake.js';
import { closedPart } from './Caps.js';
import { random, surfacePoints, thin, triangleAreas } from './SurfacePoints.js';

export const BAKE_DEFAULTS = Object.freeze({
  voxel: 1 / 140, // share of the model's size: the distance grids' spacing
  spacing: 1 / 60, // share of the size: between two surface samples...
  minSamples: 24, // ...but at least this many per part...
  maxSamples: 346, // ...and at most this many
  grow: 0.5, // voxels: how far the solids are grown past their surface (a plate thinner than a voxel keeps some thickness)
  contact: 1.5, // voxels: a part's surface this close to another part's joins them
  minContact: 4, // points of contact a joint needs (fewer: the parts only graze)
  seed: 1,
});

/**
 * Turns segmented parts into an assembly the engine loads, as physbake does offline (the same
 * manifest and binary layout, see Assembly): for each part, its faces closed by caps over its
 * cut borders (capBorders), a signed distance grid (bakeSdf, int16 in 1/256 voxel), and a few
 * hundred surface samples evenly spread, set on the grid's zero level; then a `fixed` joint
 * between every two parts whose surfaces touch, on their contact patch (anchor, normal from the
 * first to the second, area, radius). Sizes are in the mesh's units (metres to the engine).
 *   topo, labels, count   the mesh (MeshTopology) and its parts (Segmenter: label per face)
 * Returns { manifest, buffer, caps: per part its cap triangles (9 coordinates each) }.
 */
export function bakeAssembly(topo, labels, count, { name = 'upload', ...options } = {}, report = () => {}) {
  const o = { ...BAKE_DEFAULTS, ...options };
  const h = o.voxel * topo.size;
  const spacing = o.spacing * topo.size;
  const faces = Array.from({ length: count }, () => []);
  labels.forEach((l, f) => { if (l >= 0) faces[l].push(f); });
  const rand = random(o.seed);
  const parts = [];
  const caps = [];
  for (let p = 0; p < count; p++) {
    const { tris, own, caps: cap } = closedPart(topo, faces[p], (g) => labels[g] === p);
    caps.push(Float32Array.from(cap));
    const { origin, dims, phi } = bakeSdf(tris, { voxel: h, grow: o.grow * h });
    const data = new Int16Array(phi.length);
    for (let n = 0; n < phi.length; n++) data[n] = Math.max(-32767, Math.min(32767, Math.round((phi[n] / h) * 256)));
    const shape = new SdfGridShape({ origin, dims, voxel: h, data, scale: h / 256 });
    // dense points (about one per voxel face), shuffled: contact patches, and the samples thinned out of them
    const dense = surfacePoints(tris, 0.75 * h, rand);
    shuffle(dense.points, rand);
    parts.push({
      name: `part_${String(p).padStart(3, '0')}`,
      area: triangleAreas(own).total,
      sdf: { origin, dims, data },
      shape,
      samples: samplesOf(shape, dense.points, spacing, o),
      dense,
      lo: shape.localAabb.min,
      hi: shape.localAabb.max,
    });
    report((0.85 * (p + 1)) / count);
  }
  const joints = contactJoints(parts, o.contact * h, o.minContact);
  report(1);
  return { ...layout(name, parts, joints, topo), caps };
}

function shuffle(points, rand) {
  for (let i = points.length / 3 - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    for (let a = 0; a < 3; a++) [points[3 * i + a], points[3 * j + a]] = [points[3 * j + a], points[3 * i + a]];
  }
}

/**
 * The part's samples: dense points thinned to `spacing` apart (closer or farther to keep their
 * count within bounds), each moved onto the shape's zero level along its gradient.
 */
function samplesOf(shape, dense, spacing, { minSamples, maxSamples }) {
  let kept = thin(dense, spacing);
  for (let r = spacing, tries = 0; tries < 12 && (kept.length < minSamples || kept.length > maxSamples); tries++) {
    r *= kept.length < minSamples ? 0.7 : 1.25;
    kept = thin(dense, r);
    if (kept.length < minSamples && kept.length === dense.length / 3) break; // all of them already
  }
  if (kept.length > maxSamples) kept = kept.slice(0, maxSamples);
  const out = new Float32Array(3 * kept.length);
  const g = new Vec3();
  kept.forEach((p, i) => {
    let x = dense[3 * p], y = dense[3 * p + 1], z = dense[3 * p + 2];
    for (let it = 0; it < 3; it++) {
      const d = shape.distance(x, y, z, g);
      x -= d * g.x;
      y -= d * g.y;
      z -= d * g.z;
    }
    out.set([x, y, z], 3 * i);
  });
  return out;
}

/**
 * A fixed joint between every two parts whose surfaces come within `reach` of each other (each
 * one's dense points against the other's distance, both ways): anchor the patch's centre, normal
 * from the first part into the second, area the patch's (the mean of both ways), radius its reach
 * from the anchor.
 */
function contactJoints(parts, reach, minContact) {
  const joints = [];
  const g = new Vec3();
  const overlap = (a, b) => a.lo.x <= b.hi.x + reach && b.lo.x <= a.hi.x + reach && a.lo.y <= b.hi.y + reach && b.lo.y <= a.hi.y + reach && a.lo.z <= b.hi.z + reach && b.lo.z <= a.hi.z + reach;
  const touch = (from, to, sign, acc) => {
    const P = from.dense.points;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < to.lo.x - reach || x > to.hi.x + reach || y < to.lo.y - reach || y > to.hi.y + reach || z < to.lo.z - reach || z > to.hi.z + reach) continue;
      if (to.shape.distance(x, y, z, g) > reach) continue;
      const w = from.dense.weight / 2;
      acc.area += w;
      acc.points.push(x, y, z);
      acc.anchor.addScaled(new Vec3(x, y, z), w);
      acc.normal.addScaled(g, sign * w);
      acc.count++;
    }
  };
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      if (!overlap(parts[a], parts[b])) continue;
      const acc = { area: 0, count: 0, points: [], anchor: new Vec3(), normal: new Vec3() };
      touch(parts[a], parts[b], -1, acc); // b's gradient points out of b, towards a
      touch(parts[b], parts[a], 1, acc);
      if (acc.count < minContact) continue;
      const anchor = acc.anchor.scale(1 / acc.area);
      let radius = 0;
      for (let i = 0; i < acc.points.length; i += 3) radius = Math.max(radius, Math.hypot(acc.points[i] - anchor.x, acc.points[i + 1] - anchor.y, acc.points[i + 2] - anchor.z));
      const normal = acc.normal.lengthSq() > 1e-20 ? acc.normal.normalize() : new Vec3(0, 1, 0);
      joints.push({ a, b, kind: 'fixed', anchor: round([anchor.x, anchor.y, anchor.z]), normal: round([normal.x, normal.y, normal.z], 4), area: acc.area, radius });
    }
  }
  return joints;
}

const round = (v, digits = 6) => v.map((x) => Number(x.toFixed(digits)));

/** The manifest and its binary: each part's int16 grid then its float32 samples, 4-byte aligned. */
function layout(name, parts, joints, topo) {
  let bytes = 0;
  const at = parts.map((p) => {
    const sdf = bytes;
    bytes += Math.ceil((2 * p.sdf.data.length) / 4) * 4;
    const samples = bytes;
    bytes += 4 * p.samples.length;
    return { sdf, samples };
  });
  const buffer = new ArrayBuffer(bytes);
  parts.forEach((p, i) => {
    new Int16Array(buffer, at[i].sdf, p.sdf.data.length).set(p.sdf.data);
    new Float32Array(buffer, at[i].samples, p.samples.length).set(p.samples);
  });
  const { lo, hi } = topo.bounds;
  const manifest = {
    format: 'sdfphys-assembly',
    version: 1,
    name,
    unit: 'm',
    scale: 1,
    bounds: { min: round(lo), max: round(hi) },
    data: null, // in memory
    parts: parts.map((p, i) => ({
      id: i,
      name: p.name,
      role: 'PART',
      chain: 'TORSO',
      level: 0,
      side: 'C',
      area: Number(p.area.toFixed(6)),
      sdf: { origin: round(p.sdf.origin), dims: p.sdf.dims, voxel: p.shape.voxel, encoding: 'int16-voxel/256', offset: at[i].sdf },
      samples: { count: p.samples.length / 3, offset: at[i].samples },
    })),
    joints: joints.map((j) => ({ ...j, area: Number(j.area.toFixed(7)), radius: Number(j.radius.toFixed(5)) })),
  };
  return { manifest, buffer };
}
