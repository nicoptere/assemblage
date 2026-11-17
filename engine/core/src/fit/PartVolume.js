const cache = new WeakMap(); // shape -> Map(key -> stencil)

/**
 * A part as the fit sees it: weighted points filling its shape on a grid of spacing `h`, in the
 * body frame (centred on the centre of mass `com`). A point's weight is the share of its cell
 * inside the shape, estimated from the distance (1/2 - phi / h, clamped), so a plate thinner
 * than a cell still counts with its true volume. Cached per shape.
 */
export function partStencil(shape, com, h) {
  const key = `${h}|${com.x},${com.y},${com.z}`;
  let byKey = cache.get(shape);
  if (!byKey) cache.set(shape, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key);

  const { min, max } = shape.localAabb;
  const points = [];
  const weights = [];
  for (let z = min.z + h / 2; z < max.z; z += h)
    for (let y = min.y + h / 2; y < max.y; y += h)
      for (let x = min.x + h / 2; x < max.x; x += h) {
        const w = Math.min(1, 0.5 - shape.distance(x, y, z) / h);
        if (w <= 0) continue;
        points.push(x - com.x, y - com.y, z - com.z);
        weights.push(w);
      }
  const total = weights.reduce((s, w) => s + w, 0);
  const stencil = {
    points: Float32Array.from(points),
    weights: Float32Array.from(weights),
    weight: total, // sum of weights = volume / h^3
    volume: total * h ** 3,
  };
  byKey.set(key, stencil);
  return stencil;
}
