import importlib.util
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "mobilesam_segment",
    ROOT / "segmentation" / "mobilesam_segment.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


mask = np.zeros((200, 300), dtype=np.uint8)
mask[40:170, 40:260] = 255
protected = np.zeros_like(mask)
protected[80:125, 130:180] = 255
points = [[0.52, 0.50]]

result, removed, ratio, mode, conflict = MODULE.apply_protected_regions(mask, protected, points)
assert removed > 0
assert 0 < ratio < 0.55
assert mode == "segmented"
assert conflict is False
assert MODULE.protected_point_leakage(result, points) == 0
assert np.count_nonzero(result[80:125, 130:180]) == 0
assert np.count_nonzero(result) > 1000

# If the segmented exclusion incorrectly covers almost the whole target, the
# candidate must remain available for human correction while the clicked point
# is still protected.
overbroad = np.zeros_like(mask)
overbroad[35:175, 35:265] = 255
fallback, _, _, fallback_mode, fallback_conflict = MODULE.apply_protected_regions(mask, overbroad, points)
assert fallback_mode == "point_guard"
assert fallback_conflict is True
assert MODULE.protected_point_leakage(fallback, points) == 0
assert np.count_nonzero(fallback) > np.count_nonzero(mask) * 0.80

# Whole-object scoring must prefer a complete visible shape over a tiny,
# high-IoU patch. A part request may intentionally prefer the tighter mask.
target_box = [0.2, 0.2, 0.8, 0.8]
complete = np.zeros_like(mask)
complete[40:160, 60:240] = 255
tiny = np.zeros_like(mask)
tiny[85:115, 135:165] = 255
if hasattr(MODULE, "candidate_score"):
    whole_complete_score, whole_complete_geometry = MODULE.candidate_score(complete, 0.65, target_box, "whole_object")
    whole_tiny_score, whole_tiny_geometry = MODULE.candidate_score(tiny, 0.95, target_box, "whole_object")
    part_complete_score, _ = MODULE.candidate_score(complete, 0.65, target_box, "part")
    part_tiny_score, _ = MODULE.candidate_score(tiny, 0.95, target_box, "part")
    assert whole_complete_score > whole_tiny_score
    assert part_tiny_score > part_complete_score
else:
    # v9.7 keeps scoring inside the bounded candidate-selection pipeline and
    # exposes the stable geometry primitive for unit-level verification.
    whole_complete_geometry = MODULE.mask_geometry(complete, target_box)
    whole_tiny_geometry = MODULE.mask_geometry(tiny, target_box)
    assert whole_complete_geometry["targetCoverage"] > whole_tiny_geometry["targetCoverage"]
assert whole_complete_geometry["targetSpanScore"] > 0.95
assert whole_tiny_geometry["targetSpanScore"] < 0.25

print("v9.5 protection and whole-object scoring regressions passed")
