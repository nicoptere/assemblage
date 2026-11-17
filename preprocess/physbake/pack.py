"""
Assembly baking and serialisation.

manifest.json  — parts (label, rig info, SDF grid frame, sample range) and joints (contact patches)
shapes.bin     — concatenated little-endian blocks, 4-byte aligned:
                   SDF grid: int16 (nx*ny*nz), 1/256 voxel units, x fastest
                   samples:  float32 (count*3), model space
Everything is in model space (metres after `scale`); the engine computes mass properties and
recentres each part on its centre of mass at load time.
"""

import json
import os
import shutil
import time
from collections import defaultdict
from typing import Dict, List

import numpy as np

from .glb import parse_glb_submeshes, repair_and_cap_boundary_loops
from .sdf_grid import bake_sdf
from .surface import densify_surface, orient_outward, pick_samples, triangle_areas
from .adjacency import find_contacts, ensure_connected
from .rig import classify_label, joint_kind

FORMAT = "sdfphys-assembly"
VERSION = 1


def _merge_by_node(submeshes: List[Dict]) -> List[Dict]:
    """One part per glTF node (a node may carry several primitives)."""
    groups = defaultdict(list)
    for s in submeshes:
        groups[s["node_index"]].append(s)
    parts = []
    for node_index in sorted(groups):
        subs = groups[node_index]
        offset, verts, faces = 0, [], []
        for s in subs:
            verts.append(s["vertices"])
            faces.append(s["faces"].astype(np.int64) + offset)
            offset += len(s["vertices"])
        parts.append({"name": subs[0]["name"], "vertices": np.vstack(verts), "faces": np.vstack(faces)})
    return parts


def bake_assembly(
    glb_path: str,
    scale: float = 1.0,
    voxels_per_model: int = 160,
    min_cells: int = 24,
    samples_per_model: int = 60,
    min_samples: int = 24,
    max_samples: int = 320,
    log=print,
) -> Dict:
    parts = _merge_by_node(parse_glb_submeshes(glb_path))
    for p in parts:
        p["vertices"] = p["vertices"].astype(np.float64) * scale

    all_v = np.vstack([p["vertices"] for p in parts])
    lo, hi = all_v.min(axis=0), all_v.max(axis=0)
    extent = float(np.max(hi - lo))
    h_max = extent / voxels_per_model
    spacing = extent / samples_per_model

    clouds, weights = [], []
    t0 = time.time()
    for i, p in enumerate(parts):
        closed = repair_and_cap_boundary_loops(p["vertices"].astype(np.float32), p["faces"].astype(np.uint32))
        v = closed["vertices"].astype(np.float64)
        f = orient_outward(v, closed["faces"])
        part_extent = float(np.max(v.max(axis=0) - v.min(axis=0)))
        voxel = min(h_max, part_extent / min_cells)

        cloud = densify_surface(v, f, spacing=0.25 * voxel)
        area = float(triangle_areas(v, f).sum())
        p["grid"] = bake_sdf(v, f, voxel, cloud=cloud)
        p["samples"] = pick_samples(cloud.points, area, spacing, min_samples, max_samples)
        p["area"] = area
        p["rig"] = classify_label(p["name"])
        p["loops_capped"] = int(closed["open_loops_capped"])
        clouds.append(cloud.points)
        weights.append(cloud.weights)
        g = p["grid"]
        log(
            f"  [{i:02d}] {p['name']:<28s} grid {tuple(int(d) for d in g.dims)} @ {voxel * 1000:.1f} mm"
            f"  samples {len(p['samples']):4d}  inside {int(g.inside.sum()):6d}  caps {p['loops_capped']}"
        )

    t1 = time.time()
    tol = max(0.5 * h_max, 1e-4)
    patches = find_contacts(clouds, weights, tol=tol, min_area=(2.0 * tol) ** 2)
    t2 = time.time()
    patches = ensure_connected(clouds, patches)
    log(f"  timing: parts {t1 - t0:.1f}s, contacts {t2 - t1:.1f}s, bridges {time.time() - t2:.1f}s")
    for j in patches:
        j["kind"] = joint_kind(parts[j["a"]]["rig"], parts[j["b"]]["rig"])
    kinds = defaultdict(int)
    for j in patches:
        kinds[j["kind"]] += 1
    log(f"  joints: {len(patches)} ({dict(kinds)}), bridges: {sum(1 for j in patches if j.get('bridge'))}")

    return {"parts": parts, "joints": patches, "bounds": (lo, hi), "scale": scale}


def _r(x, nd=6):
    return [round(float(v), nd) for v in np.asarray(x).ravel()]


def write_assembly(baked: Dict, out_dir: str, name: str, render_glb: str = None) -> str:
    os.makedirs(out_dir, exist_ok=True)
    blob = bytearray()

    def append(arr: np.ndarray) -> int:
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(arr.tobytes())
        return off

    parts_json = []
    for i, p in enumerate(baked["parts"]):
        g = p["grid"]
        parts_json.append(
            {
                "id": i,
                "name": p["name"],
                **p["rig"],
                "area": round(p["area"], 6),
                "sdf": {
                    "origin": _r(g.origin),
                    "dims": [int(d) for d in g.dims],
                    "voxel": round(g.voxel, 7),
                    "encoding": "int16-voxel/256",
                    "offset": append(g.serialised()),
                },
                "samples": {
                    "count": int(len(p["samples"])),
                    "offset": append(np.ascontiguousarray(p["samples"], dtype="<f4")),
                },
            }
        )

    joints_json = [
        {
            "a": int(j["a"]),
            "b": int(j["b"]),
            "kind": j["kind"],
            "anchor": _r(j["anchor"]),
            "normal": _r(j["normal"], 4),
            "area": round(j["area"], 7),
            "radius": round(j["radius"], 5),
            **({"bridge": True} if j.get("bridge") else {}),
        }
        for j in baked["joints"]
    ]

    lo, hi = baked["bounds"]
    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "name": name,
        "unit": "m",
        "scale": baked["scale"],
        "bounds": {"min": _r(lo), "max": _r(hi)},
        "data": "shapes.bin",
        "render": None,
        "parts": parts_json,
        "joints": joints_json,
    }
    if render_glb:
        shutil.copyfile(render_glb, os.path.join(out_dir, "model.glb"))
        manifest["render"] = {"url": "model.glb", "match": "nodeName"}

    with open(os.path.join(out_dir, "shapes.bin"), "wb") as fh:
        fh.write(blob)
    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    return path
