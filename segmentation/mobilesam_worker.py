"""Persistent JSON-lines worker for Photoshop Agent v9.7 MobileSAM.

The Node bridge serializes requests, so this process intentionally handles one
message at a time. Keeping the process alive preserves ONNX sessions and the
small image-embedding LRU in mobilesam_segment.py. Killing the worker is the
cancellation boundary for an active native inference call.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from mobilesam_segment import segment


def require_list(value: object, label: str) -> list:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array.")
    return value


def run_segment(args: dict, default_models: Path) -> dict:
    if not isinstance(args, dict):
        raise ValueError("Worker segment args must be an object.")
    return segment(
        Path(str(args["image"])),
        [float(value) for value in require_list(args["box"], "box")],
        Path(str(args["output"])),
        Path(str(args.get("models") or default_models)),
        target_width=int(args["targetWidth"]),
        target_height=int(args["targetHeight"]),
        source_crop=[int(value) for value in require_list(args.get("sourceCrop"), "sourceCrop")],
        include_rle=bool(args.get("includeRle", True)),
        include_preview=bool(args.get("includePreview", True)),
        clip_box=[float(value) for value in require_list(args["clipBox"], "clipBox")],
        positive_points=[
            [float(point[0]), float(point[1])]
            for point in require_list(args.get("positivePoints", []), "positivePoints")
        ],
        negative_points=[
            [float(point[0]), float(point[1])]
            for point in require_list(args.get("negativePoints", []), "negativePoints")
        ],
        color_refine=str(args.get("colorRefine", "none")),
        color_families=[str(value) for value in require_list(args.get("colorFamilies", []), "colorFamilies")],
        color_hints=[str(value) for value in require_list(args.get("colorHints", []), "colorHints")],
        color_tolerance=float(args.get("colorTolerance", 52)),
        semantic_scope=str(args.get("semanticScope", "unknown")),
        image_key=str(args.get("imageKey") or "") or None,
    )


def respond(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True, type=Path)
    parsed = parser.parse_args()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("Worker request must be an object.")
            request_id = str(message.get("id") or "")
            if not request_id:
                raise ValueError("Worker request id is required.")
            if message.get("command") != "segment":
                raise ValueError("Unsupported worker command.")
            result = run_segment(message.get("args"), parsed.models)
            respond({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            respond({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
