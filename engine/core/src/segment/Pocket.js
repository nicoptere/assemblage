import { ConvexHull } from './ConvexHull.js';
import { bakeSdf } from './SdfBake.js';
import { closedPart } from './Caps.js';

const RAYS = fibonacci(64);

/**
 * The biggest ball a part can hold: the largest ball inside the part's convex hull that stays out
 * of the part's solid, as the bake closes it (caps over its cuts, inside where a flood from
 * outside cannot get). A plate or a block holds none; a bowl, a gutter, a cup or a shell with a
 * hole in it holds one about as big as the room inside, and other parts can end up in there:
 * a trap. It is the interior half of the concavity of approximate convex decompositions (CoACD:
 * the distance between a shape and its hull, from the boundary and from the interior), local
 * rather than by volume, so a thin curved plate does not count for more than its sag.
 *   faces    the part's faces in `topo`; inPart(g): whether face g is one of them
 *   voxel    the grid the solid is measured on (pockets come out to about a voxel)
 * Returns { radius, centre: [x, y, z] (null when there is no room), wrap: the share of the
 * directions from the centre along which the part is met (how far it surrounds the ball) }.
 */
export function pocketOf(topo, faces, inPart, voxel) {
  const none = { radius: 0, centre: null, wrap: 0 };
  const hull = new ConvexHull(hullPoints(topo, faces, voxel / 2));
  if (hull.flat) return none;
  const { tris } = closedPart(topo, faces, inPart);
  const grid = bakeSdf(tris, { voxel, grow: 0, pad: 1, band: 1 });
  const { origin, dims: [nx, ny], phi } = grid;
  // the node outside the solid farthest from both the surface and the hull's boundary: by
  // decreasing distance to the surface, until that is no farther than the best found
  const order = [];
  for (let n = 0; n < phi.length; n++) if (phi[n] > voxel) order.push(n);
  order.sort((a, b) => phi[b] - phi[a]);
  const P = hull.planes;
  let best = 0, at = -1;
  for (const n of order) {
    if (phi[n] <= best) break;
    const i = n % nx, j = ((n / nx) | 0) % ny, k = (n / (nx * ny)) | 0;
    const x = origin[0] + i * voxel, y = origin[1] + j * voxel, z = origin[2] + k * voxel;
    let r = phi[n];
    for (let p = 0; p < P.length && r > best; p += 4) r = Math.min(r, P[p + 3] - (P[p] * x + P[p + 1] * y + P[p + 2] * z));
    if (r > best) { best = r; at = n; }
  }
  if (at < 0) return none;
  const centre = [origin[0] + (at % nx) * voxel, origin[1] + (((at / nx) | 0) % ny) * voxel, origin[2] + ((at / (nx * ny)) | 0) * voxel];
  return { radius: best, centre, wrap: wrapAround(grid, centre) };
}

/**
 * The part's vertices, one per cell of `cell` (the one farthest from their centre: the hull
 * keeps its extent), so that a dense convex surface does not make a hull of thousands of faces.
 */
function hullPoints(topo, faces, cell) {
  const { V, F } = topo;
  const c = [0, 0, 0];
  for (const f of faces) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c[a] += V[3 * F[3 * f + k] + a] / (3 * faces.length);
  const kept = new Map(); // cell -> [vertex, distance²]
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k];
      const x = V[3 * v], y = V[3 * v + 1], z = V[3 * v + 2];
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      const d = (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2;
      const was = kept.get(key);
      if (!was || d > was[1]) kept.set(key, [v, d]);
    }
  }
  const out = new Float64Array(3 * kept.size);
  let i = 0;
  for (const [v] of kept.values()) out.set(V.subarray(3 * v, 3 * v + 3), 3 * i++);
  return out;
}

/** The share of RAYS from `from` that meet the surface before they leave the grid (sphere tracing). */
function wrapAround({ origin, dims, voxel, phi }, from) {
  const [nx, ny, nz] = dims;
  const at = (x, y, z) => {
    const fx = (x - origin[0]) / voxel, fy = (y - origin[1]) / voxel, fz = (z - origin[2]) / voxel;
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return null;
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
    const u = fx - i, v = fy - j, w = fz - k;
    const n = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const lerp = (a, b, t) => a + (b - a) * t;
    return lerp(
      lerp(lerp(phi[n], phi[n + 1], u), lerp(phi[n + sy], phi[n + sy + 1], u), v),
      lerp(lerp(phi[n + sz], phi[n + sz + 1], u), lerp(phi[n + sz + sy], phi[n + sz + sy + 1], u), v),
      w,
    );
  };
  let hits = 0;
  for (const [dx, dy, dz] of RAYS) {
    for (let t = 0; ;) {
      const d = at(from[0] + t * dx, from[1] + t * dy, from[2] + t * dz);
      if (d === null) break;
      if (d < 0.5 * voxel) { hits++; break; }
      t += Math.max(d, 0.5 * voxel);
    }
  }
  return hits / RAYS.length;
}

/** `n` directions spread evenly over the sphere (a Fibonacci spiral). */
function fibonacci(n) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    return [r * Math.cos(golden * i), y, r * Math.sin(golden * i)];
  });
}
