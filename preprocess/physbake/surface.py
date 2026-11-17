"""Mesh orientation, dense surface clouds and evenly spread collision samples."""

from dataclasses import dataclass
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def triangle_areas(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def orient_outward(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    """
    Flips the winding of every connected component whose signed volume is negative, so face
    normals point outward. Generated meshes are often consistently wound but globally inverted.
    """
    f = np.asarray(f, dtype=np.int64).copy()
    key = np.round(v / max(float(np.ptp(v)), 1e-9) * 1e6).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    rows = np.repeat(np.arange(len(f)), 3)
    incidence = coo_matrix((np.ones(len(rows)), (rows, weld[f].ravel())), shape=(len(f), int(weld.max()) + 1)).tocsr()
    _, label = connected_components(incidence @ incidence.T, directed=False)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    signed = np.einsum("ij,ij->i", a, np.cross(b, c))
    volume = np.bincount(label, weights=signed)
    flip = volume[label] < 0
    f[flip] = f[flip][:, [0, 2, 1]]
    return f


@dataclass
class SurfaceCloud:
    points: np.ndarray  # (M, 3)
    normals: np.ndarray  # (M, 3) outward unit normals
    weights: np.ndarray  # (M,) surface area carried by each point


def _cell_keys(points: np.ndarray, cell: float) -> np.ndarray:
    return np.floor(points / cell).astype(np.int64)


def _cell_dedup(points: np.ndarray, cell: float) -> np.ndarray:
    """Indices keeping, for each occupied cubic cell, the point closest to the cell centre."""
    key = _cell_keys(points, cell)
    d2 = np.sum((points - (key + 0.5) * cell) ** 2, axis=1)
    order = np.lexsort((d2, key[:, 2], key[:, 1], key[:, 0]))
    k = key[order]
    first = np.ones(len(order), dtype=bool)
    first[1:] = np.any(k[1:] != k[:-1], axis=1)
    return order[first]


def densify_surface(v: np.ndarray, f: np.ndarray, spacing: float) -> SurfaceCloud:
    """
    Samples every triangle on a barycentric lattice, then merges samples per `spacing` cell
    (summing area, averaging normals). No surface point is farther than ~spacing from a sample.
    """
    v = np.asarray(v, dtype=np.float64)
    f = np.asarray(f, dtype=np.int64)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cross = np.cross(b - a, c - a)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    face_n = cross / np.maximum(2.0 * areas[:, None], 1e-20)
    longest = np.max(
        np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)]),
        axis=0,
    )
    subdiv = np.clip(np.ceil(longest / spacing), 1, 48).astype(np.int64)

    pts, nrm, wts = [], [], []
    for n in np.unique(subdiv):
        idx = np.nonzero(subdiv == n)[0]
        ij = np.array([(i, j) for i in range(n + 1) for j in range(n + 1 - i)], dtype=np.float64) / n
        w0, w1 = ij[:, 0], ij[:, 1]
        w2 = 1.0 - w0 - w1
        p = w0[None, :, None] * a[idx, None, :] + w1[None, :, None] * b[idx, None, :] + w2[None, :, None] * c[idx, None, :]
        pts.append(p.reshape(-1, 3))
        nrm.append(np.repeat(face_n[idx], len(ij), axis=0))
        wts.append(np.repeat(areas[idx] / len(ij), len(ij)))
    pts, nrm, wts = np.vstack(pts), np.vstack(nrm), np.concatenate(wts)

    key = _cell_keys(pts, spacing)
    _, group = np.unique(key, axis=0, return_inverse=True)
    group = group.ravel()
    keep = _cell_dedup(pts, spacing)
    keep = keep[np.argsort(group[keep])]
    w_sum = np.bincount(group, weights=wts)
    n_sum = np.stack([np.bincount(group, weights=nrm[:, k] * wts) for k in range(3)], axis=1)
    n_sum /= np.maximum(np.linalg.norm(n_sum, axis=1, keepdims=True), 1e-20)
    return SurfaceCloud(points=pts[keep], normals=n_sum, weights=w_sum)


def _support_points(points: np.ndarray) -> np.ndarray:
    """Extreme points along the 26 lattice directions: corners and tips are always sampled."""
    dirs = np.array(
        [(x, y, z) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1) if (x, y, z) != (0, 0, 0)],
        dtype=np.float64,
    )
    return np.unique(np.argmax(points @ dirs.T, axis=0))


def pick_samples(points: np.ndarray, area: float, spacing: float, min_count: int, max_count: int) -> np.ndarray:
    """
    Picks evenly spread collision samples from a dense cloud. The target count follows surface
    area (one sample per spacing^2), clamped to [min_count, max_count].
    """
    target = int(np.clip(round(area / (spacing * spacing)), min_count, max_count))
    extent = float(np.max(np.ptp(points, axis=0)))
    lo, hi = extent * 1e-3, extent
    for _ in range(18):  # bisection on the cell size until the count matches the target
        mid = 0.5 * (lo + hi)
        if len(_cell_dedup(points, mid)) > target:
            lo = mid
        else:
            hi = mid
    keep = np.union1d(_cell_dedup(points, hi), _support_points(points))
    return points[keep].astype(np.float32)
