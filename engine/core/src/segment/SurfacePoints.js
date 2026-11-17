/** A small seeded random generator (mulberry32): the same seed, the same points. */
export function random(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area of every triangle (9 coordinates each) and their total. */
export function triangleAreas(tris) {
  const n = tris.length / 9;
  const areas = new Float64Array(n);
  let total = 0;
  for (let i = 0, t = 0; i < n; i++, t += 9) {
    const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
    const vx = tris[t + 6] - tris[t], vy = tris[t + 7] - tris[t + 1], vz = tris[t + 8] - tris[t + 2];
    areas[i] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    total += areas[i];
  }
  return { areas, total };
}

/**
 * Points spread over triangles in proportion to their area, about one per `spacing`² (at most
 * `max`): each triangle gets its share (fractions carried over to the next), at random places in
 * it. Returns { points (xyz), weight: the area each stands for }.
 */
export function surfacePoints(tris, spacing, rand, max = 40000) {
  const { areas, total } = triangleAreas(tris);
  const count = Math.max(1, Math.min(max, Math.round(total / (spacing * spacing))));
  const out = new Float64Array(3 * (count + areas.length)); // room for the rounding
  let n = 0, carry = 0;
  for (let i = 0, t = 0; i < areas.length; i++, t += 9) {
    carry += (areas[i] / (total || 1)) * count;
    for (; carry >= 1; carry--) {
      let r = rand(), s = rand();
      if (r + s > 1) { r = 1 - r; s = 1 - s; }
      for (let a = 0; a < 3; a++) out[3 * n + a] = tris[t + a] + r * (tris[t + 3 + a] - tris[t + a]) + s * (tris[t + 6 + a] - tris[t + a]);
      n++;
    }
  }
  return { points: out.slice(0, 3 * n), weight: n ? total / n : 0 };
}

/** Indices of the points kept when each, in turn, is kept only if none kept so far is within `radius`. */
export function thin(points, radius) {
  const cells = new Map();
  const kept = [];
  const r2 = radius * radius;
  const key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let p = 0; p < points.length / 3; p++) {
    const x = points[3 * p], y = points[3 * p + 1], z = points[3 * p + 2];
    const ci = Math.floor(x / radius), cj = Math.floor(y / radius), ck = Math.floor(z / radius);
    let free = true;
    for (let i = ci - 1; i <= ci + 1 && free; i++) for (let j = cj - 1; j <= cj + 1 && free; j++) for (let k = ck - 1; k <= ck + 1 && free; k++) {
      for (const q of cells.get(key(i, j, k)) ?? []) {
        if ((points[3 * q] - x) ** 2 + (points[3 * q + 1] - y) ** 2 + (points[3 * q + 2] - z) ** 2 < r2) { free = false; break; }
      }
    }
    if (!free) continue;
    kept.push(p);
    const c = key(ci, cj, ck);
    if (!cells.has(c)) cells.set(c, []);
    cells.get(c).push(p);
  }
  return kept;
}
