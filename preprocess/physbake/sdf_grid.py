"""
Isotropic metric SDF grids.

Physics needs true distances (penetration depth) and true gradients (contact normals), so:
  - one voxel size on all axes, grid dims follow the part's box,
  - unsigned distance = nearest point of a dense surface cloud (KD-tree),
  - sign = inside test by ray parity, voted over 3 axes x 2 directions (robust to small holes),
  - values sampled at grid nodes (vertex-centred), x varying fastest when serialised.
"""

from dataclasses import dataclass
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from .surface import SurfaceCloud, densify_surface

_JITTER = (0.1234567, 0.2718281)  # irrational ray offsets avoid edge/vertex hits


@dataclass
class SdfGrid:
    origin: np.ndarray  # (3,) position of node (0,0,0)
    dims: np.ndarray  # (3,) node counts (nx, ny, nz)
    voxel: float  # node spacing
    values: np.ndarray  # (nx, ny, nz) float32 signed distances
    inside: np.ndarray  # (nx, ny, nz) bool

    def node_positions(self) -> np.ndarray:
        axes = [self.origin[i] + self.voxel * np.arange(self.dims[i]) for i in range(3)]
        gx, gy, gz = np.meshgrid(*axes, indexing="ij")
        return np.stack([gx, gy, gz], axis=-1)

    def serialised(self) -> np.ndarray:
        """int16 in 1/256 voxel units, x fastest (index = x + nx * (y + ny * z))."""
        q = np.clip(np.round(self.values / self.voxel * 256.0), -32767, 32767).astype("<i2")
        return np.ascontiguousarray(q.transpose(2, 1, 0))


def _grid_frame(lo: np.ndarray, hi: np.ndarray, voxel: float, pad: int):
    dims = np.ceil((hi - lo) / voxel).astype(np.int64) + 1 + 2 * pad
    extra = (dims - 1) * voxel - (hi - lo)
    return lo - 0.5 * extra, dims


def _parity_votes(v_idx: np.ndarray, f: np.ndarray, dims: np.ndarray) -> np.ndarray:
    """Counts, per node, how many of the 6 axis-aligned rays see an odd number of crossings."""
    votes = np.zeros(tuple(dims), dtype=np.uint8)
    for a in range(3):
        b, c = [k for k in range(3) if k != a]
        nb, nc, na = int(dims[b]), int(dims[c]), int(dims[a])
        P = v_idx[f]  # (F, 3 verts, 3 coords) in index space
        B, C, A = P[:, :, b] - _JITTER[0], P[:, :, c] - _JITTER[1], P[:, :, a]

        jb0 = np.clip(np.ceil(B.min(1)), 0, nb).astype(np.int64)
        jb1 = np.clip(np.floor(B.max(1)), -1, nb - 1).astype(np.int64)
        jc0 = np.clip(np.ceil(C.min(1)), 0, nc).astype(np.int64)
        jc1 = np.clip(np.floor(C.max(1)), -1, nc - 1).astype(np.int64)
        cb = np.maximum(jb1 - jb0 + 1, 0)
        cc = np.maximum(jc1 - jc0 + 1, 0)
        count = cb * cc
        tri = np.repeat(np.arange(len(f)), count)
        if len(tri) == 0:
            continue
        local = np.arange(len(tri)) - np.repeat(np.cumsum(count) - count, count)
        qb = jb0[tri] + local // cc[tri]
        qc = jc0[tri] + local % cc[tri]

        e1b, e1c = B[tri, 1] - B[tri, 0], C[tri, 1] - C[tri, 0]
        e2b, e2c = B[tri, 2] - B[tri, 0], C[tri, 2] - C[tri, 0]
        wb, wc = qb - B[tri, 0], qc - C[tri, 0]
        det = e1b * e2c - e1c * e2b
        ok = np.abs(det) > 1e-12
        det = np.where(ok, det, 1.0)
        s = (wb * e2c - wc * e2b) / det
        t = (e1b * wc - e1c * wb) / det
        hit = ok & (s >= 0) & (t >= 0) & (s + t <= 1)
        depth = A[tri, 0] + s * (A[tri, 1] - A[tri, 0]) + t * (A[tri, 2] - A[tri, 0])

        qb, qc, depth = qb[hit], qc[hit], depth[hit]
        first_above = np.clip(np.floor(depth).astype(np.int64) + 1, 0, na)
        hist = np.zeros((nb, nc, na + 1), dtype=np.int32)
        np.add.at(hist, (qb, qc, first_above), 1)
        below = np.cumsum(hist, axis=2)[:, :, :na]
        total = hist.sum(axis=2, keepdims=True)
        odd = (below % 2) + ((total - below) % 2)  # 0..2 votes from this axis
        votes += np.moveaxis(odd.astype(np.uint8), (0, 1, 2), (b, c, a))
    return votes


def bake_sdf(vertices: np.ndarray, faces: np.ndarray, voxel: float, pad: int = 3, cloud: SurfaceCloud = None) -> SdfGrid:
    """
    Bakes an outward-oriented triangle mesh into an isotropic SDF grid.
    `cloud` is an optional dense surface cloud (spacing <= voxel / 4) to reuse.

    Sign = parity votes (6 rays) blended with a nearest-surface normal test (robust near the
    surface and around holes), weighted towards the normal test close to the surface where
    contacts happen; then made spatially consistent (see `_consistent_inside`). Distances are then
    clamped to the sign boundary, so the field changes by at most one voxel between neighbouring
    nodes (a true distance field), and faces buried inside the solid do not count as surface.
    """
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    lo, hi = v.min(axis=0), v.max(axis=0)
    origin, dims = _grid_frame(lo, hi, voxel, pad)
    if cloud is None:
        cloud = densify_surface(v, f, spacing=0.25 * voxel)

    grid = SdfGrid(origin=origin, dims=dims, voxel=float(voxel), values=None, inside=None)
    nodes = grid.node_positions().reshape(-1, 3)
    dist, idx = cKDTree(cloud.points).query(nodes, k=4, workers=-1)
    unsigned = dist[:, 0]

    # Normal test: is the node behind the nearby surface? (+1 inside ... -1 outside)
    rel = nodes[:, None, :] - cloud.points[idx]
    facing = np.einsum("nkc,nkc->nk", rel, cloud.normals[idx]) / np.maximum(dist, 1e-12)
    w = 1.0 / np.maximum(dist, 0.05 * voxel)
    normal_vote = -np.sum(facing * w, axis=1) / np.sum(w, axis=1)

    parity_vote = (_parity_votes((v - origin) / voxel, f, dims).reshape(-1).astype(np.float64) - 3.0) / 3.0
    trust = np.clip(2.0 - unsigned / voxel, 0.35, 2.0)  # normals dominate within ~1.5 voxels
    vote = ((parity_vote + trust * normal_vote) > 0.0).reshape(tuple(dims))
    unsigned = unsigned.reshape(tuple(dims))

    inside = _consistent_inside(unsigned, vote, voxel)
    # Distances to the sign boundary, which lies between an inside node and its outside neighbour
    # (0.5 - 1.5 voxels from the node). Clamping the surface distance by them keeps the field
    # 1-Lipschitz where the sign boundary is not on the mesh (vote changes, buried faces).
    to_out = ndimage.distance_transform_edt(inside) * voxel  # inside nodes: to the nearest outside node
    to_in = ndimage.distance_transform_edt(~inside) * voxel  # outside nodes: to the nearest inside node
    depth = np.clip(unsigned, to_out - 1.5 * voxel, to_out - 0.5 * voxel)
    gap = np.minimum(unsigned, to_in - 0.5 * voxel)
    grid.inside = inside
    grid.values = np.where(inside, -depth, gap).astype(np.float32)
    return grid


def _consistent_inside(unsigned: np.ndarray, vote: np.ndarray, voxel: float, band: float = 2.0) -> np.ndarray:
    """
    Per-node votes go wrong where a part's shells overlap or leave small gaps (parity counts an
    even number of crossings), which leaves 'inside' streaks far from any surface and 'outside'
    pockets deep in the solid: sign flips that a distance field cannot have. Farther than `band`
    voxels from the surface the sign is decided by connectivity instead: nodes reachable from
    the grid border without coming within `band` of the surface are outside, the rest inside
    (so gaps in a shell narrower than about 2 x band voxels are bridged).
    Nodes within the band keep their vote, which follows the nearby surface normals, except
    that nodes surrounded by solid are solid (faces buried inside the part).
    """
    far = unsigned > band * voxel
    labels, _ = ndimage.label(far)  # 6-connected
    faces = [labels[0], labels[-1], labels[:, 0], labels[:, -1], labels[:, :, 0], labels[:, :, -1]]
    border = np.unique(np.concatenate([f.ravel() for f in faces]))
    outside_far = np.isin(labels, border[border > 0])
    inside_far = far & ~outside_far
    cube = np.ones((3, 3, 3), dtype=bool)
    buried = ndimage.binary_dilation(inside_far, cube) & ~ndimage.binary_dilation(outside_far, cube)
    return np.where(far, inside_far, vote | buried)
