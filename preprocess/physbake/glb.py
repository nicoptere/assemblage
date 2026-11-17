"""
GLB input for physbake, in plain Python and NumPy: every mesh of a binary glTF 2.0 file in world
coordinates (node transforms applied), and the open boundary loops of a part (where it was cut from
its neighbours) closed by fans, so that its distance field has an inside.
"""

import json
import math
import struct
from collections import defaultdict
from typing import Dict, Any, List, Tuple, Optional, Sequence
import numpy as np


GLTF_COMPONENT_DTYPES = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}

GLTF_TYPE_COUNTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def _quat_to_mat3(q: Sequence[float]) -> np.ndarray:
    x, y, z, w = [float(v) for v in q]
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n < 1e-12:
        return np.eye(3, dtype=np.float64)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
            [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
            [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def _node_local_matrix(node: Dict[str, Any]) -> np.ndarray:
    if "matrix" in node and len(node["matrix"]) == 16:
        # glTF matrices are column-major
        return np.asarray(node["matrix"], dtype=np.float64).reshape((4, 4), order="F")
    M = np.eye(4, dtype=np.float64)
    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    R = _quat_to_mat3(r)
    S = np.diag([float(s[0]), float(s[1]), float(s[2])])
    M[:3, :3] = R @ S
    M[:3, 3] = [float(t[0]), float(t[1]), float(t[2])]
    return M


def _read_accessor(gltf: Dict[str, Any], bin_blob: bytes, acc_idx: int) -> np.ndarray:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    dtype = GLTF_COMPONENT_DTYPES[acc["componentType"]]
    num_comp = GLTF_TYPE_COUNTS[acc["type"]]
    count = int(acc["count"])
    offset = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    stride = int(bv.get("byteStride", 0))
    item_bytes = np.dtype(dtype).itemsize * num_comp

    if stride == 0 or stride == item_bytes:
        raw = np.frombuffer(bin_blob, dtype=dtype, count=count * num_comp, offset=offset)
        arr = raw.reshape((count, num_comp)) if num_comp > 1 else raw.copy()
    else:
        out = np.empty((count, num_comp), dtype=dtype)
        for i in range(count):
            row_off = offset + i * stride
            out[i] = np.frombuffer(bin_blob, dtype=dtype, count=num_comp, offset=row_off)
        arr = out if num_comp > 1 else out[:, 0]

    if acc.get("normalized") and dtype in (np.uint8, np.uint16):
        max_val = 255.0 if dtype == np.uint8 else 65535.0
        arr = arr.astype(np.float32) / max_val
    return arr.copy()


def _extract_texture_bytes(
    gltf: Dict[str, Any],
    bin_blob: bytes,
    tex_info: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    if not tex_info or "index" not in tex_info:
        return None
    tex_idx = int(tex_info["index"])
    textures = gltf.get("textures", [])
    images = gltf.get("images", [])
    buffer_views = gltf.get("bufferViews", [])
    if tex_idx < 0 or tex_idx >= len(textures):
        return None
    src_idx = textures[tex_idx].get("source")
    if src_idx is None:
        src_idx = (
            textures[tex_idx]
            .get("extensions", {})
            .get("EXT_texture_webp", {})
            .get("source")
        )
    if src_idx is None or src_idx < 0 or src_idx >= len(images):
        return None
    img = images[src_idx]
    bv_idx = img.get("bufferView")
    if bv_idx is None or bv_idx < 0 or bv_idx >= len(buffer_views):
        return None
    bv = buffer_views[bv_idx]
    off = int(bv.get("byteOffset", 0))
    ln = int(bv.get("byteLength", 0))
    mime = img.get("mimeType", "image/jpeg")
    return {
        "mimeType": mime,
        "bytes": bytes(bin_blob[off : off + ln]),
    }


def parse_glb_submeshes(glb_path: str) -> List[Dict[str, Any]]:
    """
    Parses a binary glTF 2.0 (`.glb`) file and extracts all sub-meshes in world coordinates,
    including vertex positions, normals, UVs, triangle indices, material factors, and
    self-contained PBR texture blobs.
    """
    with open(glb_path, "rb") as f:
        data = f.read()

    if len(data) < 20:
        raise ValueError(f"File too short to be a valid GLB: {glb_path}")
    magic, version, total_len = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"Invalid GLB magic in {glb_path}")

    offset = 12
    gltf: Dict[str, Any] = {}
    bin_blob = b""

    while offset + 8 <= len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk_bytes = data[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:  # JSON
            gltf = json.loads(chunk_bytes.decode("utf-8"))
        elif chunk_type == 0x004E4942:  # BIN
            bin_blob = chunk_bytes

    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    materials = gltf.get("materials", [])

    # Determine root nodes
    child_set = set()
    for n in nodes:
        for c in n.get("children", []):
            child_set.add(int(c))
    roots = [i for i in range(len(nodes)) if i not in child_set]

    extracted: List[Dict[str, Any]] = []

    def _walk(node_idx: int, parent_mat: np.ndarray):
        node = nodes[node_idx]
        world_mat = parent_mat @ _node_local_matrix(node)
        mesh_idx = node.get("mesh")
        if mesh_idx is not None and 0 <= int(mesh_idx) < len(meshes):
            mesh_obj = meshes[int(mesh_idx)]
            node_name = node.get("name") or mesh_obj.get("name") or f"part_{node_idx}"
            for prim_i, prim in enumerate(mesh_obj.get("primitives", [])):
                attrs = prim.get("attributes", {})
                if "POSITION" not in attrs:
                    continue
                pos_local = _read_accessor(gltf, bin_blob, int(attrs["POSITION"])).astype(np.float64)
                if len(pos_local) < 3:
                    continue

                # Transform positions to world space
                R_world = world_mat[:3, :3]
                t_world = world_mat[:3, 3]
                pos_world = (pos_local @ R_world.T) + t_world[None, :]

                if "indices" in prim:
                    faces = _read_accessor(gltf, bin_blob, int(prim["indices"])).astype(np.uint32).reshape((-1, 3))
                else:
                    faces = np.arange(len(pos_world), dtype=np.uint32).reshape((-1, 3))

                # Filter out degenerate triangles
                valid_f = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])
                faces = faces[valid_f]
                if len(faces) == 0:
                    continue

                # Flip winding if determinant of R_world is negative
                if np.linalg.det(R_world) < 0:
                    faces = faces[:, [0, 2, 1]]

                normals_world = None
                if "NORMAL" in attrs:
                    n_local = _read_accessor(gltf, bin_blob, int(attrs["NORMAL"])).astype(np.float64)
                    try:
                        inv_t = np.linalg.inv(R_world).T
                    except np.linalg.LinAlgError:
                        inv_t = R_world
                    n_w = n_local @ inv_t.T
                    norms = np.linalg.norm(n_w, axis=1, keepdims=True)
                    normals_world = (n_w / np.maximum(norms, 1e-8)).astype(np.float32)

                uvs = None
                if "TEXCOORD_0" in attrs:
                    uvs = _read_accessor(gltf, bin_blob, int(attrs["TEXCOORD_0"])).astype(np.float32)

                colors = None
                if "COLOR_0" in attrs:
                    colors = _read_accessor(gltf, bin_blob, int(attrs["COLOR_0"])).astype(np.float32)

                mat_info: Dict[str, Any] = {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.35,
                    "roughnessFactor": 0.45,
                    "baseColorTexture": None,
                    "metallicRoughnessTexture": None,
                    "normalTexture": None,
                }
                mat_idx = prim.get("material")
                if mat_idx is not None and 0 <= int(mat_idx) < len(materials):
                    mat = materials[int(mat_idx)]
                    pbr = mat.get("pbrMetallicRoughness", {})
                    if "baseColorFactor" in pbr:
                        mat_info["baseColorFactor"] = [float(x) for x in pbr["baseColorFactor"]]
                    if "metallicFactor" in pbr:
                        mat_info["metallicFactor"] = float(pbr["metallicFactor"])
                    if "roughnessFactor" in pbr:
                        mat_info["roughnessFactor"] = float(pbr["roughnessFactor"])
                    mat_info["baseColorTexture"] = _extract_texture_bytes(
                        gltf, bin_blob, pbr.get("baseColorTexture")
                    )
                    mat_info["metallicRoughnessTexture"] = _extract_texture_bytes(
                        gltf, bin_blob, pbr.get("metallicRoughnessTexture")
                    )
                    mat_info["normalTexture"] = _extract_texture_bytes(
                        gltf, bin_blob, mat.get("normalTexture")
                    )

                part_name = node_name if prim_i == 0 else f"{node_name}_p{prim_i}"
                extracted.append(
                    {
                        "name": part_name,
                        "node_index": node_idx,
                        "vertices": pos_world.astype(np.float32),
                        "normals": normals_world,
                        "uvs": uvs,
                        "colors": colors,
                        "faces": faces.astype(np.uint32),
                        "material": mat_info,
                    }
                )

        for child_idx in node.get("children", []):
            _walk(int(child_idx), world_mat)

    for r in roots:
        _walk(r, np.eye(4, dtype=np.float64))

    return extracted


def compute_vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Computes area-weighted smooth vertex normals for a triangle mesh."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    vnorms = np.zeros_like(v, dtype=np.float64)
    if len(f) == 0:
        vnorms[:, 1] = 1.0
        return vnorms.astype(np.float32)
    t0, t1, t2 = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    fn = np.cross(t1 - t0, t2 - t0)
    np.add.at(vnorms, f[:, 0], fn)
    np.add.at(vnorms, f[:, 1], fn)
    np.add.at(vnorms, f[:, 2], fn)
    lens = np.linalg.norm(vnorms, axis=1, keepdims=True)
    default_n = np.zeros_like(vnorms)
    default_n[:, 1] = 1.0
    vnorms = np.where(lens > 1e-10, vnorms / np.maximum(lens, 1e-10), default_n)
    return vnorms.astype(np.float32)


def repair_and_cap_boundary_loops(
    vertices: np.ndarray,
    faces: np.ndarray,
    normals: Optional[np.ndarray] = None,
    uvs: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """
    Closes a part:
      - Welds coincident vertices (tolerance 1e-5) to detect topological connectivity
      - Finds open boundary half-edges \\partial M_P (created where a limb was severed from a joint)
      - Chains them into closed boundary loops and caps them via centroid fan triangulation
      - Records the centroid & outward normal of the largest capped boundary loop as the
        part's Primary Cut-Plane Socket Candidate (p_cut, n_cut).
    """
    verts = np.asarray(vertices, dtype=np.float32)
    tris = np.asarray(faces, dtype=np.uint32)
    if len(verts) < 3 or len(tris) < 1:
        return {
            "vertices": verts,
            "faces": tris,
            "normals": normals if normals is not None else compute_vertex_normals(verts, tris),
            "uvs": uvs,
            "open_loops_capped": 0,
            "primary_cut_socket": None,
        }

    # Quantize positions to weld duplicate vertices for topological edge pairing
    vmin = verts.min(axis=0)
    span = max(float((verts.max(axis=0) - vmin).max()), 1e-4)
    q_verts = np.round((verts - vmin[None, :]) / (span * 1e-5)).astype(np.int64)
    _, unique_inv = np.unique(q_verts, axis=0, return_inverse=True)
    # Map each welded group back to its first original vertex index
    first_orig = {}
    for orig_i, w_i in enumerate(unique_inv):
        w_id = int(w_i)
        if w_id not in first_orig:
            first_orig[w_id] = orig_i

    edge_counts: Dict[Tuple[int, int], int] = defaultdict(int)
    directed_orig: Dict[Tuple[int, int], Tuple[int, int]] = {}
    for f in tris:
        w0, w1, w2 = int(unique_inv[f[0]]), int(unique_inv[f[1]]), int(unique_inv[f[2]])
        if w0 == w1 or w1 == w2 or w2 == w0:
            continue
        for a, b, oa, ob in ((w0, w1, f[0], f[1]), (w1, w2, f[1], f[2]), (w2, w0, f[2], f[0])):
            edge_counts[(a, b)] += 1
            directed_orig[(a, b)] = (int(oa), int(ob))

    # Open boundary half-edges have (a, b) present but (b, a) missing
    next_map: Dict[int, List[int]] = defaultdict(list)
    for (a, b), cnt in edge_counts.items():
        if edge_counts.get((b, a), 0) == 0:
            next_map[a].append(b)

    visited_edges = set()
    loops: List[List[int]] = []
    for start_u in list(next_map.keys()):
        for nxt_v in next_map[start_u]:
            if (start_u, nxt_v) in visited_edges:
                continue
            loop = [start_u]
            curr = nxt_v
            visited_edges.add((start_u, nxt_v))
            steps = 0
            while curr != start_u and steps < 2048:
                loop.append(curr)
                candidates = [w for w in next_map.get(curr, []) if (curr, w) not in visited_edges]
                if not candidates:
                    break
                nxt = candidates[0]
                visited_edges.add((curr, nxt))
                curr = nxt
                steps += 1
            if curr == start_u and len(loop) >= 3:
                loops.append(loop)

    if not loops:
        out_normals = normals if (normals is not None and len(normals) == len(verts)) else compute_vertex_normals(verts, tris)
        return {
            "vertices": verts,
            "faces": tris,
            "normals": out_normals,
            "uvs": uvs,
            "open_loops_capped": 0,
            "primary_cut_socket": None,
        }

    mesh_center = verts.mean(axis=0)
    new_verts = [verts]
    new_uvs = [uvs] if (uvs is not None and len(uvs) == len(verts)) else None
    new_faces = [tris]
    next_v_idx = len(verts)

    best_cut_socket: Optional[Dict[str, Any]] = None
    best_loop_radius = -1.0
    capped_count = 0

    # Sort loops largest-first so best_cut_socket records the primary anatomical cut plane,
    # and cap ALL open boundary loops so 100% of holes and cut boundaries are sealed.
    for loop in loops:
        orig_indices = [first_orig[w] for w in loop]
        loop_pts = verts[orig_indices]
        centroid = loop_pts.mean(axis=0)
        radii = np.linalg.norm(loop_pts - centroid[None, :], axis=1)
        mean_r = float(radii.mean())

        # Compute loop normal via Newell's method
        normal_vec = np.zeros(3, dtype=np.float64)
        for i in range(len(loop_pts)):
            p_curr = loop_pts[i].astype(np.float64)
            p_next = loop_pts[(i + 1) % len(loop_pts)].astype(np.float64)
            normal_vec[0] += (p_curr[1] - p_next[1]) * (p_curr[2] + p_next[2])
            normal_vec[1] += (p_curr[2] - p_next[2]) * (p_curr[0] + p_next[0])
            normal_vec[2] += (p_curr[0] - p_next[0]) * (p_curr[1] + p_next[1])
        norm_len = float(np.linalg.norm(normal_vec))
        if norm_len < 1e-8:
            out_dir = centroid - mesh_center
            n_hat = out_dir / max(float(np.linalg.norm(out_dir)), 1e-8)
        else:
            n_hat = normal_vec / norm_len
            if np.dot(n_hat, centroid - mesh_center) < 0:
                n_hat = -n_hat

        if mean_r > best_loop_radius:
            best_loop_radius = mean_r
            best_cut_socket = {
                "pos": [round(float(x), 5) for x in centroid],
                "normal": [round(float(x), 5) for x in n_hat],
                "radius": round(float(mean_r), 5),
                "loop_vertices": len(loop),
            }

        max_r_ratio = 0.55
        max_loop_len = 512
        if mean_r > max_r_ratio * span or len(loop) > max_loop_len:
            continue

        # Duplicate loop vertices + centroid with a single constant UV so cap triangles
        # never stretch across disconnected 2D UV islands in a radial starburst
        n_loop = len(orig_indices)
        ring_start = next_v_idx
        c_idx = ring_start + n_loop
        next_v_idx += n_loop + 1
        new_verts.append(loop_pts.astype(np.float32))
        new_verts.append(centroid[None, :].astype(np.float32))
        if new_uvs is not None:
            anchor_uv = uvs[orig_indices[0] : orig_indices[0] + 1].astype(np.float32)
            new_uvs.append(np.repeat(anchor_uv, n_loop + 1, axis=0))

        cap_tris = []
        for i in range(n_loop):
            u_cap = ring_start + i
            v_cap = ring_start + ((i + 1) % n_loop)
            cap_tris.append([v_cap, u_cap, c_idx])
        new_faces.append(np.asarray(cap_tris, dtype=np.uint32))
        capped_count += 1

    all_verts = np.vstack(new_verts).astype(np.float32)
    all_faces = np.vstack(new_faces).astype(np.uint32)
    all_uvs = np.vstack(new_uvs).astype(np.float32) if new_uvs is not None else None
    all_normals = compute_vertex_normals(all_verts, all_faces)

    return {
        "vertices": all_verts,
        "faces": all_faces,
        "normals": all_normals,
        "uvs": all_uvs,
        "open_loops_capped": capped_count,
        "primary_cut_socket": best_cut_socket,
    }
