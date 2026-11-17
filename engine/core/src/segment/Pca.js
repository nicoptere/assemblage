/**
 * Principal axes of points: their weighted centre and the eigenvectors of their covariance, the
 * axis of largest spread first.
 *   points    xyz, flat
 *   weights   per point (default 1)
 * Returns { centre, axes: [[x, y, z] x 3], spread: the three eigenvalues, largest first }.
 */
export function principalAxes(points, weights = null) {
  const n = Math.floor(points.length / 3);
  const c = [0, 0, 0];
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a = weights ? weights[i] : 1;
    w += a;
    for (let k = 0; k < 3; k++) c[k] += a * points[3 * i + k];
  }
  for (let k = 0; k < 3; k++) c[k] /= w || 1;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = weights ? weights[i] : 1;
    const d = [points[3 * i] - c[0], points[3 * i + 1] - c[1], points[3 * i + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) m[3 * r + s] += (a * d[r] * d[s]) / (w || 1);
  }
  return { centre: c, ...eigen(m) };
}

/** Eigenvectors and eigenvalues of a symmetric 3x3 matrix (row-major), by Jacobi rotations, largest first. */
export function eigen(m) {
  const a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1), sin = t * cos;
        for (let k = 0; k < 3; k++) {
          const x = a[k][p], y = a[k][q];
          a[k][p] = cos * x - sin * y;
          a[k][q] = sin * x + cos * y;
        }
        for (let k = 0; k < 3; k++) {
          const x = a[p][k], y = a[q][k];
          a[p][k] = cos * x - sin * y;
          a[q][k] = sin * x + cos * y;
        }
        for (let k = 0; k < 3; k++) {
          const x = v[k][p], y = v[k][q];
          v[k][p] = cos * x - sin * y;
          v[k][q] = sin * x + cos * y;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return { axes: order.map((j) => [v[0][j], v[1][j], v[2][j]]), spread: order.map((j) => a[j][j]) };
}
