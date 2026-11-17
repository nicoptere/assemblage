"""
Contact patches between parts of an assembled model.

Parts segmented from one mesh share their cut boundaries, so two parts "touch" where their surfaces
come within `tol` of each other. Each touching pair yields one patch: its centroid (joint anchor),
its normal (smallest principal axis of the patch, pointing from part a to part b), its area and
its radius. These drive the joint anchors and break strengths.
"""

from typing import Dict, List, Sequence
import numpy as np
from scipy.spatial import cKDTree


def _aabb_overlap(a_lo, a_hi, b_lo, b_hi, tol) -> bool:
    return bool(np.all(a_lo - tol <= b_hi) and np.all(b_lo - tol <= a_hi))


def _patch(points: np.ndarray, area: float, a_centre: np.ndarray, b_centre: np.ndarray) -> Dict:
    anchor = points.mean(axis=0)
    rel = points - anchor
    cov = rel.T @ rel / max(len(points), 1)
    evals, evecs = np.linalg.eigh(cov)
    normal = evecs[:, 0]
    if np.dot(normal, b_centre - a_centre) < 0:
        normal = -normal
    radius = float(np.sqrt(max(evals[1] + evals[2], 1e-12)))
    return {
        "anchor": anchor,
        "normal": normal,
        "area": float(area),
        "radius": radius,
    }


def find_contacts(
    clouds: Sequence[np.ndarray],
    weights: Sequence[np.ndarray],
    tol: float,
    min_area: float,
) -> List[Dict]:
    """
    clouds[i]: dense surface points of part i; weights[i]: area carried by each point.
    Returns patches {a, b, anchor, normal, area, radius} for all touching pairs a < b.
    """
    trees = [cKDTree(c) for c in clouds]
    lo = [c.min(axis=0) for c in clouds]
    hi = [c.max(axis=0) for c in clouds]
    centres = [np.average(c, axis=0, weights=w) for c, w in zip(clouds, weights)]

    out = []
    for i in range(len(clouds)):
        for j in range(i + 1, len(clouds)):
            if not _aabb_overlap(lo[i], hi[i], lo[j], hi[j], tol):
                continue
            di, _ = trees[j].query(clouds[i], distance_upper_bound=tol)
            dj, _ = trees[i].query(clouds[j], distance_upper_bound=tol)
            near_i, near_j = np.isfinite(di), np.isfinite(dj)
            area = 0.5 * (weights[i][near_i].sum() + weights[j][near_j].sum())
            if area < min_area:
                continue
            pts = np.vstack([clouds[i][near_i], clouds[j][near_j]])
            patch = _patch(pts, area, centres[i], centres[j])
            out.append({"a": i, "b": j, **patch})
    return out


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        self.parent[self.find(a)] = self.find(b)


def _closest_pair(ci: np.ndarray, cj: np.ndarray, tree_j: cKDTree):
    d, k = tree_j.query(ci, k=1)
    m = int(np.argmin(d))
    return float(d[m]), ci[m], cj[int(k[m])]


def ensure_connected(clouds: Sequence[np.ndarray], patches: List[Dict], max_points: int = 2000) -> List[Dict]:
    """
    Links every disconnected island of parts to the rest with bridge patches at the closest pair
    of points, so the assembly holds together as one piece. Islands are joined along a minimum
    spanning tree of part-to-part distances, measured once on decimated clouds; only the chosen
    bridges are refined on the full clouds.
    """
    n = len(clouds)
    uf = _UnionFind(n)
    for p in patches:
        uf.union(p["a"], p["b"])
    if len({uf.find(i) for i in range(n)}) <= 1:
        return patches

    coarse = [c[:: max(1, len(c) // max_points)] for c in clouds]
    trees = [cKDTree(c) for c in coarse]
    lo = [c.min(axis=0) for c in clouds]
    hi = [c.max(axis=0) for c in clouds]
    edges = []
    for i in range(n):
        for j in range(i + 1, n):
            if uf.find(i) == uf.find(j):
                continue
            gap = float(np.linalg.norm(np.maximum(0.0, np.maximum(lo[i] - hi[j], lo[j] - hi[i]))))
            edges.append((gap, i, j))
    # exact coarse distance only for the nearest candidates by box gap
    edges.sort()
    refined = []
    for gap, i, j in edges[: max(64, 4 * n)]:
        d, _, _ = _closest_pair(coarse[i], coarse[j], trees[j])
        refined.append((d, i, j))
    refined.sort()

    bridges = []
    for _, i, j in refined:
        if uf.find(i) == uf.find(j):
            continue
        _, pi, pj = _closest_pair(clouds[i], clouds[j], cKDTree(clouds[j]))
        a, b = min(i, j), max(i, j)
        normal = (pj - pi) if a == i else (pi - pj)
        normal = normal / max(np.linalg.norm(normal), 1e-9)
        bridges.append({"a": a, "b": b, "anchor": 0.5 * (pi + pj), "normal": normal, "area": 0.0, "radius": 0.0, "bridge": True})
        uf.union(i, j)
    return patches + bridges
