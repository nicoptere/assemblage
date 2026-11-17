"""
Packs rebuild targets: keeps only the triangle geometry of a GLB (every mode-4 primitive, node
transforms applied, a skinned mesh posed by its joints as viewers draw it, vertices welded),
dropping textures, UVs, colours and line primitives (the feature curves of the decomposed
reconstruction targets). A 5 MB target becomes ~0.5 MB.
With --max-triangles, a heavier mesh is simplified by vertex clustering (vertices snapped to a
grid over its bounds, merged, collapsed triangles dropped), the grid coarsened until it fits: a
target is voxelised at a few cm, so a few hundred cells across keep every detail that counts.

  python3 pack_targets.py in1.glb [in2.glb ...] -o ../engine/app/public/targets [--max-triangles 60000]

Output files keep their names. List them in the output folder's index.json to offer them.
"""

import argparse
import json
import os
import struct

import numpy as np

COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


def read_glb(path):
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path}: not a GLB")
    jlen, _ = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen, _ = struct.unpack_from("<II", data, off)
    return gltf, data[off + 8: off + 8 + blen]


def accessor(gltf, binary, index):
    a = gltf["accessors"][index]
    view = gltf["bufferViews"][a["bufferView"]]
    n, dtype = COMPONENTS[a["type"]], np.dtype(DTYPES[a["componentType"]])
    start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride", n * dtype.itemsize)
    rows = np.ndarray((a["count"], n), dtype=dtype, buffer=binary, offset=start, strides=(stride, dtype.itemsize))
    return np.array(rows)


def node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = np.array(node.get("translation", [0, 0, 0]), dtype=np.float64)
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    s = np.array(node.get("scale", [1, 1, 1]), dtype=np.float64)
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


def world_matrices(gltf, scene):
    """Every node of `scene`'s world matrix, by node index."""
    world = {}

    def visit(i, parent):
        world[i] = parent @ node_matrix(gltf["nodes"][i])
        for c in gltf["nodes"][i].get("children", []):
            visit(c, world[i])

    for i in scene["nodes"]:
        visit(i, np.eye(4))
    return world


def skinned(gltf, binary, prim, skin, world):
    """A skinned primitive's positions in world space, posed by its joints (the skinned node's own
    transform does not count, as glTF has it): each vertex moved by its joints' world matrices
    times their inverse bind matrices, weighted."""
    p = accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(np.float64)
    joints = accessor(gltf, binary, prim["attributes"]["JOINTS_0"]).astype(np.int64)
    weights = accessor(gltf, binary, prim["attributes"]["WEIGHTS_0"]).astype(np.float64)
    if gltf["accessors"][prim["attributes"]["WEIGHTS_0"]].get("normalized"):
        weights /= np.iinfo(DTYPES[gltf["accessors"][prim["attributes"]["WEIGHTS_0"]]["componentType"]]).max
    if "inverseBindMatrices" in skin:
        inverse = accessor(gltf, binary, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
    else:
        inverse = np.repeat(np.eye(4)[None], len(skin["joints"]), axis=0)
    matrices = np.stack([world[j] @ inverse[k] for k, j in enumerate(skin["joints"])])
    h = np.c_[p, np.ones(len(p))]
    out = np.zeros_like(p)
    for k in range(joints.shape[1]):
        out += weights[:, k:k + 1] * np.einsum("nij,nj->ni", matrices[joints[:, k]], h)[:, :3]
    return out


def triangles(gltf, binary):
    """All triangles of the default scene, in world space: (V float32 n x 3, F uint32 m x 3)."""
    Vs, Fs, base = [], [], 0
    scene = gltf["scenes"][gltf.get("scene", 0)]
    world = world_matrices(gltf, scene)
    for i, m in world.items():
        node = gltf["nodes"][i]
        for prim in gltf["meshes"][node["mesh"]]["primitives"] if "mesh" in node else []:
            if prim.get("mode", 4) != 4:
                continue
            if "skin" in node and "JOINTS_0" in prim["attributes"]:
                p = skinned(gltf, binary, prim, gltf["skins"][node["skin"]], world)
            else:
                p = accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(np.float64)
                p = p @ m[:3, :3].T + m[:3, 3]
            f = accessor(gltf, binary, prim["indices"]).reshape(-1, 3) if "indices" in prim else np.arange(len(p)).reshape(-1, 3)
            Vs.append(p)
            Fs.append(f.astype(np.int64) + base)
            base += len(p)
    V, F = np.vstack(Vs).astype(np.float32), np.vstack(Fs)
    # weld identical positions, drop triangles that collapse
    V, inverse = np.unique(V, axis=0, return_inverse=True)
    F = inverse.reshape(-1)[F]
    keep = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
    return V, F[keep].astype(np.uint32)


def cluster(V, F, cells):
    """V, F with vertices merged on a grid of `cells` along the longest side (each cluster at its
    vertices' mean); collapsed and repeated triangles dropped."""
    lo = V.min(axis=0)
    size = (V.max(axis=0) - lo).max() / cells
    keys = np.floor((V - lo) / size).astype(np.int64)
    _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(-1)
    W = np.zeros((len(counts), 3))
    np.add.at(W, inverse, V)
    W /= counts[:, None]
    G = inverse[F]
    G = G[(G[:, 0] != G[:, 1]) & (G[:, 1] != G[:, 2]) & (G[:, 0] != G[:, 2])]
    _, first = np.unique(np.sort(G, axis=1), axis=0, return_index=True)
    return W.astype(np.float32), G[np.sort(first)].astype(np.uint32)


def simplify(V, F, max_triangles):
    """Clusters on a coarser and coarser grid until at most `max_triangles` remain."""
    cells = 1024
    while len(F) > max_triangles and cells >= 32:
        V, F = cluster(V, F, cells)
        cells = int(cells * 0.8)
    return V, F


def write_glb(path, V, F):
    pos, idx = V.astype("<f4").tobytes(), F.astype("<u4").tobytes()
    binary = pos + idx
    binary += b"\0" * (-len(binary) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "sdfphys pack_targets.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "target"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(V), "type": "VEC3",
             "min": V.min(axis=0).tolist(), "max": V.max(axis=0).tolist()},
            {"bufferView": 1, "componentType": 5125, "count": int(F.size), "type": "SCALAR"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as out:
        out.write(struct.pack("<III", 0x46546C67, 2, total))
        out.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        out.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


def main():
    ap = argparse.ArgumentParser(description="Keep only the triangles of GLB rebuild targets")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--max-triangles", type=int, default=0, help="simplify heavier meshes to at most this many")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for path in args.inputs:
        V, F = triangles(*read_glb(path))
        if args.max_triangles and len(F) > args.max_triangles:
            V, F = simplify(V, F, args.max_triangles)
        out = os.path.join(args.out, os.path.basename(path))
        write_glb(out, V, F)
        print(f"{os.path.basename(path)}: {len(F)} triangles, {len(V)} vertices, "
              f"{os.path.getsize(path) / 1e6:.1f} MB -> {os.path.getsize(out) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
