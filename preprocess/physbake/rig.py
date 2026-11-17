"""
Rig rules: which contacts are rigid welds and which are articulations.

Part labels come from the semantic segmenter, e.g. `part_012_FRONT_SHIN_L`, `part_006_HULL_CORE`,
or roles such as `THIGH_FEMUR`. A label maps to a kinematic chain (TORSO, FRONT_L, ...)
and a level along it (0 = torso, 1 = hip/shoulder segment, 2 = knee/elbow segment, 3 = foot/hand).

  same chain, same level             -> fixed (one rigid limb segment split into several parts)
  adjacent levels on the same chain  -> ball  (an articulation, held by a soft angular drive)
  torso level 0 to any level 1       -> ball  (hip / shoulder)
  anything else                      -> fixed (labelling noise: keep the model in one piece)
"""

import re
from typing import Dict

# Segment keyword -> level along a limb chain
_LEVELS = {
    "HULL": 0, "CORE": 0, "DORSAL": 0, "TORSO": 0, "CHEST": 0, "PELVIS": 0, "WAIST": 0,
    "COCKPIT": 0, "HEAD": 0, "BACKPACK": 0, "SKIRT": 0, "WEAPON": 0, "SHIELD": 0,
    "THIGH": 1, "UPPER": 1, "SHOULDER": 1, "HIP": 1, "PAULDRON": 1,
    "SHIN": 2, "KNEE": 2, "FOREARM": 2, "ELBOW": 2, "TIBIA": 2,
    "PAW": 3, "FOOT": 3, "ANKLE": 3, "HAND": 3,
}


def classify_label(name: str) -> Dict:
    """`part_012_FRONT_SHIN_L` -> {role: FRONT_SHIN_L, chain: FRONT_L, level: 2, side: L}."""
    role = re.sub(r"^part_\d+_", "", name).upper()
    tokens = role.split("_")
    side = tokens[-1] if tokens[-1] in ("L", "R") else "C"
    level = next((_LEVELS[t] for t in tokens if t in _LEVELS), 0)
    zone = next((t for t in tokens if t in ("FRONT", "REAR", "ARM", "LEG")), "")
    if not zone and level > 0:
        zone = "ARM" if any(t in tokens for t in ("UPPER", "SHOULDER", "FOREARM", "ELBOW", "HAND")) else "LEG"
    chain = "TORSO" if level == 0 else f"{zone}_{side}".strip("_")
    return {"role": role, "chain": chain, "level": level, "side": side}


def joint_kind(a: Dict, b: Dict) -> str:
    if a["level"] == b["level"] and a["chain"] == b["chain"]:
        return "fixed"
    lo, hi = (a, b) if a["level"] < b["level"] else (b, a)
    if hi["level"] - lo["level"] != 1:
        return "fixed"
    if lo["level"] == 0 or lo["chain"] == hi["chain"]:
        return "ball"
    return "fixed"
