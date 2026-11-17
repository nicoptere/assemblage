"""
Usage (from the `preprocess` folder):

  python3 -m physbake ../models/mecha_01.glb -o ../engine/app/public/models/mecha_01 --name mecha_01

The input GLB must have one node per part (in assembled position). It is also copied as the
render model, so a textured GLB gives textured parts in the app.
"""

import argparse
import time

from .pack import bake_assembly, write_assembly


def main() -> None:
    ap = argparse.ArgumentParser(prog="physbake", description="Bake a part-segmented GLB into an SDF physics assembly")
    ap.add_argument("glb", help="assembled GLB, one node per part")
    ap.add_argument("-o", "--out", required=True, help="output folder")
    ap.add_argument("--name", default=None)
    ap.add_argument("--scale", type=float, default=1.0, help="uniform scale applied to the model (metres)")
    ap.add_argument("--voxels", type=int, default=160, help="voxels across the whole model (sets the coarsest voxel)")
    ap.add_argument("--min-cells", type=int, default=24, help="minimum voxels across a part's longest side")
    ap.add_argument("--samples", type=int, default=60, help="sample spacing = model size / this")
    ap.add_argument("--no-render", action="store_true", help="do not copy the GLB as render model")
    args = ap.parse_args()

    t0 = time.time()
    print(f"[physbake] {args.glb}")
    baked = bake_assembly(
        args.glb,
        scale=args.scale,
        voxels_per_model=args.voxels,
        min_cells=args.min_cells,
        samples_per_model=args.samples,
    )
    name = args.name or "assembly"
    path = write_assembly(baked, args.out, name, render_glb=None if args.no_render else args.glb)
    print(f"[physbake] wrote {path} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
