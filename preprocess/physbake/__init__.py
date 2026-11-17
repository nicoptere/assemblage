"""
physbake — bakes a part-segmented GLB into a physics assembly for the SDF engine.

Reads the GLB and closes each part's open boundary loops (glb.py), then bakes what physics needs:
  - isotropic, metric signed distance grids (one voxel size on all axes),
  - evenly spread surface samples (the points that probe other bodies' SDFs),
  - contact-patch adjacency between parts, turned into joints by rig rules.

Output (see `pack.write_assembly`): manifest.json + shapes.bin (+ a copy of the render GLB).
"""

from .sdf_grid import SdfGrid, bake_sdf
from .surface import densify_surface, pick_samples
from .adjacency import find_contacts, ensure_connected
from .rig import classify_label, joint_kind
from .pack import bake_assembly, write_assembly

__all__ = [
    "SdfGrid",
    "bake_sdf",
    "densify_surface",
    "pick_samples",
    "find_contacts",
    "ensure_connected",
    "classify_label",
    "joint_kind",
    "bake_assembly",
    "write_assembly",
]
