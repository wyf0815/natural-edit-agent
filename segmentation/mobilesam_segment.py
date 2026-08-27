import argparse
import base64
import json
import time
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


MODEL_HEIGHT = 684
MODEL_WIDTH = 1024
MAX_POINTS = 16
MAX_TOTAL_POINTS = MAX_POINTS * 2
EMBEDDING_CACHE_LIMIT = 3
LEGACY_RLE_MAX_PIXELS = 4_000_000
MAX_RLE_COUNTS = 1_000_000

_SESSION_CACHE: dict[str, ort.InferenceSession] = {}
_EMBEDDING_CACHE: OrderedDict[str, np.ndarray] = OrderedDict()


def session(path: Path) -> ort.InferenceSession:
    key = str(path.resolve())
    cached = _SESSION_CACHE.get(key)
    if cached is not None:
        return cached
    value = ort.InferenceSession(key, providers=["CPUExecutionProvider"])
    _SESSION_CACHE[key] = value
    return value


def letterbox_image(image: np.ndarray) -> tuple[np.ndarray, dict[str, float | int]]:
    """Resize without distortion and pad into the encoder's fixed canvas."""
    original_height, original_width = image.shape[:2]
    scale = min(MODEL_WIDTH / float(original_width), MODEL_HEIGHT / float(original_height))
    resized_width = max(1, min(MODEL_WIDTH, int(round(original_width * scale))))
    resized_height = max(1, min(MODEL_HEIGHT, int(round(original_height * scale))))
    resized = cv2.resize(
        cv2.cvtColor(image, cv2.COLOR_BGR2RGB),
        (resized_width, resized_height),
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
    )
    offset_x = (MODEL_WIDTH - resized_width) // 2
    offset_y = (MODEL_HEIGHT - resized_height) // 2
    canvas = np.zeros((MODEL_HEIGHT, MODEL_WIDTH, 3), dtype=np.float32)
    canvas[offset_y:offset_y + resized_height, offset_x:offset_x + resized_width] = resized.astype(np.float32)
    return canvas, {
        "originalWidth": original_width,
        "originalHeight": original_height,
        "resizedWidth": resized_width,
        "resizedHeight": resized_height,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "scale": scale,
    }


def cached_embeddings(
    encoder: ort.InferenceSession,
    encoder_input: np.ndarray,
    image_key: str | None,
) -> tuple[np.ndarray, bool]:
    if image_key and image_key in _EMBEDDING_CACHE:
        value = _EMBEDDING_CACHE.pop(image_key)
        _EMBEDDING_CACHE[image_key] = value
        return value, True
    value = encoder.run(None, {"input_image": encoder_input})[0]
    if image_key:
        _EMBEDDING_CACHE[image_key] = value
        while len(_EMBEDDING_CACHE) > EMBEDDING_CACHE_LIMIT:
            _EMBEDDING_CACHE.popitem(last=False)
    return value, False


def encode_rle(mask: np.ndarray) -> list[int]:
    flat = (mask.reshape(-1) > 0).astype(np.uint8)
    counts: list[int] = []
    current = 0
    count = 0
    for value in flat:
        bit = int(value)
        if bit == current:
            count += 1
        else:
            counts.append(count)
            if len(counts) > MAX_RLE_COUNTS:
                raise RuntimeError("The segmentation mask is too fragmented to transport safely.")
            current = bit
            count = 1
    counts.append(count)
    if len(counts) > MAX_RLE_COUNTS:
        raise RuntimeError("The segmentation mask is too fragmented to transport safely.")
    return counts


def encode_cropped_rle(
    mask: np.ndarray,
    canvas_width: int,
    canvas_height: int,
    source_crop: list[int] | None = None,
) -> tuple[dict, int]:
    """Scale and encode only the selected bounding rectangle.

    A full 8K boolean canvas is mostly zeros for a local edit. Encoding the
    crop keeps transport and UXP memory proportional to the selected object.
    """
    source_height, source_width = mask.shape
    crop_left, crop_top, crop_right, crop_bottom = source_crop or [0, 0, canvas_width, canvas_height]
    document_crop_width = crop_right - crop_left
    document_crop_height = crop_bottom - crop_top
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise RuntimeError("Cannot encode an empty segmentation mask.")
    source_left = int(xs.min())
    source_top = int(ys.min())
    source_right = int(xs.max()) + 1
    source_bottom = int(ys.max()) + 1
    origin_x = max(crop_left, min(crop_right - 1, crop_left + int(np.floor(source_left / source_width * document_crop_width))))
    origin_y = max(crop_top, min(crop_bottom - 1, crop_top + int(np.floor(source_top / source_height * document_crop_height))))
    right = max(origin_x + 1, min(crop_right, crop_left + int(np.ceil(source_right / source_width * document_crop_width))))
    bottom = max(origin_y + 1, min(crop_bottom, crop_top + int(np.ceil(source_bottom / source_height * document_crop_height))))
    crop_width = right - origin_x
    crop_height = bottom - origin_y
    source_crop = mask[source_top:source_bottom, source_left:source_right]
    target_crop = source_crop if source_crop.shape == (crop_height, crop_width) else cv2.resize(
        source_crop,
        (crop_width, crop_height),
        interpolation=cv2.INTER_NEAREST,
    )
    selected = int(np.count_nonzero(target_crop))
    return {
        "encoding": "rle-cropped-v1",
        "order": "row-major",
        "startsWith": 0,
        "originX": origin_x,
        "originY": origin_y,
        "width": crop_width,
        "height": crop_height,
        "canvasWidth": canvas_width,
        "canvasHeight": canvas_height,
        "counts": encode_rle(target_crop),
    }, selected


def parse_points(raw: str | None) -> list[list[float]]:
    if not raw:
        return []
    value = json.loads(raw)
    if not isinstance(value, list) or len(value) > MAX_POINTS:
        raise ValueError(f"Points must be an array with at most {MAX_POINTS} items.")
    points: list[list[float]] = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            raise ValueError("Each point must be [x,y].")
        x, y = float(item[0]), float(item[1])
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError("Points must use normalized 0..1 coordinates.")
        points.append([x, y])
    return points


def parse_strings(raw: str | None, label: str, limit: int) -> list[str]:
    if not raw:
        return []
    value = json.loads(raw)
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"{label} must be an array with at most {limit} items.")
    return [str(item) for item in value]


def color_family_mask(image: np.ndarray, families: list[str]) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, saturation, value = cv2.split(hsv)
    selected = np.zeros(hue.shape, dtype=bool)
    for family in families:
        if family == "red":
            current = ((hue <= 10) | (hue >= 170)) & (saturation >= 70) & (value >= 40)
        elif family == "orange":
            current = (hue >= 8) & (hue <= 24) & (saturation >= 65) & (value >= 45)
        elif family == "yellow":
            current = (hue >= 20) & (hue <= 38) & (saturation >= 55) & (value >= 55)
        elif family == "green":
            current = (hue >= 35) & (hue <= 95) & (saturation >= 40) & (value >= 28)
        elif family == "cyan":
            current = (hue >= 80) & (hue <= 105) & (saturation >= 38) & (value >= 45)
        elif family == "blue":
            current = (hue >= 95) & (hue <= 135) & (saturation >= 45) & (value >= 35)
        elif family == "purple":
            current = (hue >= 125) & (hue <= 165) & (saturation >= 38) & (value >= 35)
        elif family == "pink":
            current = ((hue >= 155) | (hue <= 6)) & (saturation >= 38) & (value >= 100)
        elif family == "black":
            current = value <= 78
        elif family == "white":
            current = (saturation <= 48) & (value >= 188)
        elif family == "gray":
            current = (saturation <= 52) & (value >= 55) & (value <= 225)
        elif family == "brown":
            current = (hue >= 5) & (hue <= 26) & (saturation >= 55) & (value >= 35) & (value <= 195)
        else:
            raise ValueError(f"Unsupported color family: {family}")
        selected |= current
    return selected.astype(np.uint8) * 255


def hinted_color_mask(image: np.ndarray, color_hints: list[str], tolerance: float) -> np.ndarray:
    if not color_hints:
        return np.zeros(image.shape[:2], dtype=np.uint8)
    image_lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    selected = np.zeros(image.shape[:2], dtype=bool)
    threshold = max(9.0, min(52.0, float(tolerance) * 0.72))
    for hint in color_hints:
        value = hint.lstrip("#")
        rgb = np.array([[[int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)]]], dtype=np.uint8)
        hint_lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)[0, 0]
        distance = np.linalg.norm(image_lab - hint_lab, axis=2)
        selected |= distance <= threshold
    return selected.astype(np.uint8) * 255


def seeded_color_mask(image: np.ndarray, points: list[list[float]], tolerance: float) -> np.ndarray:
    if not points:
        raise RuntimeError("Source-color refinement needs a color description, color hint, or target click.")
    height, width = image.shape[:2]
    image_lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    selected = np.zeros((height, width), dtype=bool)
    threshold = max(9.0, min(48.0, float(tolerance) * 0.68))
    radius = max(2, int(round(min(width, height) * 0.006)))
    for x_value, y_value in points:
        x = max(0, min(width - 1, int(round(x_value * (width - 1)))))
        y = max(0, min(height - 1, int(round(y_value * (height - 1)))))
        patch = image_lab[max(0, y - radius):min(height, y + radius + 1), max(0, x - radius):min(width, x + radius + 1)]
        reference = np.median(patch.reshape(-1, 3), axis=0)
        selected |= np.linalg.norm(image_lab - reference, axis=2) <= threshold
    return selected.astype(np.uint8) * 255


def rectangle_mask(shape: tuple[int, int], box: list[float]) -> np.ndarray:
    height, width = shape
    left = max(0, int(np.floor(box[0] * width)))
    top = max(0, int(np.floor(box[1] * height)))
    right = min(width, int(np.ceil(box[2] * width)))
    bottom = min(height, int(np.ceil(box[3] * height)))
    result = np.zeros((height, width), dtype=np.uint8)
    result[top:bottom, left:right] = 255
    return result


def retain_anchored_color_components(
    source_mask: np.ndarray,
    semantic_mask: np.ndarray,
    target_box: list[float],
    clip_box: list[float],
    positive_points: list[list[float]],
) -> np.ndarray:
    clip_mask = rectangle_mask(source_mask.shape, clip_box)
    target_mask = rectangle_mask(source_mask.shape, target_box)
    candidates = cv2.bitwise_and(source_mask, clip_mask)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((candidates > 0).astype(np.uint8), 8)
    retained = np.zeros_like(candidates)
    height, width = candidates.shape
    minimum_area = max(4, int(round(width * height * 0.000006)))
    eligible: list[dict] = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < minimum_area:
            continue
        component = labels == label
        target_overlap = int(np.count_nonzero(component & (target_mask > 0)))
        semantic_overlap = int(np.count_nonzero(component & (semantic_mask > 0)))
        clicked = False
        for x_value, y_value in positive_points:
            x = max(0, min(width - 1, int(round(x_value * (width - 1)))))
            y = max(0, min(height - 1, int(round(y_value * (height - 1)))))
            if component[y, x]:
                clicked = True
                break
        target_ratio = target_overlap / float(max(1, area))
        semantic_ratio = semantic_overlap / float(max(1, area))
        if clicked or target_overlap >= max(3, int(area * 0.015)) or semantic_overlap >= max(4, int(area * 0.18)):
            eligible.append({
                "label": label,
                "area": area,
                "target_overlap": target_overlap,
                "target_ratio": target_ratio,
                "semantic_overlap": semantic_overlap,
                "semantic_ratio": semantic_ratio,
                "clicked": clicked,
                "center_x": float(stats[label, cv2.CC_STAT_LEFT] + stats[label, cv2.CC_STAT_WIDTH] / 2) / float(width),
                "center_y": float(stats[label, cv2.CC_STAT_TOP] + stats[label, cv2.CC_STAT_HEIGHT] / 2) / float(height),
            })

    if not eligible:
        return retained

    # A broad search box may contain several unrelated regions with the same
    # colour (for example green hair and a nearby green cape). Pick one primary
    # component first, then admit only strongly related companions. This makes
    # source-colour refinement a local part selector instead of a colour-wide
    # selection while still supporting disconnected details such as beard tips.
    clicked_components = [item for item in eligible if item["clicked"]]
    primary_pool = clicked_components or eligible
    primary = max(
        primary_pool,
        key=lambda item: (
            item["target_overlap"] + item["semantic_overlap"] * 2,
            item["area"],
        ),
    )
    retained[labels == primary["label"]] = 255

    target_width = max(0.02, target_box[2] - target_box[0])
    target_height = max(0.02, target_box[3] - target_box[1])
    related_distance = max(0.08, min(0.24, float(np.hypot(target_width, target_height)) * 0.72))
    for item in eligible:
        if item["label"] == primary["label"]:
            continue
        distance = float(np.hypot(
            item["center_x"] - primary["center_x"],
            item["center_y"] - primary["center_y"],
        ))
        manually_anchored = item["clicked"]
        semantically_strong = item["semantic_ratio"] >= 0.45 and item["semantic_overlap"] >= 12
        substantial_companion = (
            item["area"] >= max(24, int(primary["area"] * 0.18))
            and item["target_ratio"] >= 0.08
            and distance <= related_distance
        )
        if manually_anchored or semantically_strong or substantial_companion:
            retained[labels == item["label"]] = 255
    return retained


def protected_point_leakage(mask: np.ndarray, points: list[list[float]]) -> float:
    if not points:
        return 0.0
    height, width = mask.shape
    radius = max(2, int(round(min(width, height) * 0.006)))
    leaks: list[float] = []
    for x_value, y_value in points:
        x = max(0, min(width - 1, int(round(x_value * (width - 1)))))
        y = max(0, min(height - 1, int(round(y_value * (height - 1)))))
        patch = mask[max(0, y - radius):min(height, y + radius + 1), max(0, x - radius):min(width, x + radius + 1)]
        leaks.append(float(np.count_nonzero(patch)) / float(max(1, patch.size)))
    return max(leaks)


def protected_point_mask(shape: tuple[int, int], points: list[list[float]]) -> np.ndarray:
    """Build a hard safety area around every explicit exclusion click."""
    height, width = shape
    result = np.zeros((height, width), dtype=np.uint8)
    radius = max(3, int(round(min(width, height) * 0.008)))
    for x_value, y_value in points:
        x = max(0, min(width - 1, int(round(x_value * (width - 1)))))
        y = max(0, min(height - 1, int(round(y_value * (height - 1)))))
        cv2.circle(result, (x, y), radius, 255, -1)
    return result


def apply_protected_regions(
    mask: np.ndarray,
    segmented_protection: np.ndarray,
    points: list[list[float]],
) -> tuple[np.ndarray, int, float, str, bool]:
    """Apply exclusions after every union/refinement step.

    Source-colour refinement can reintroduce pixels removed by the semantic
    decoder. Protection therefore has to be the final mask operation. If an
    independently segmented exclusion would erase most of the target, keep the
    hard point guards and surface the conflict for human review instead of
    discarding an otherwise useful candidate.
    """
    if not points:
        return mask, 0, 0.0, "none", False

    before = int(np.count_nonzero(mask))
    if before < 1:
        return mask, 0, 0.0, "none", False

    point_guards = protected_point_mask(mask.shape, points)
    full_protection = cv2.bitwise_or(segmented_protection, point_guards)
    has_segmented_protection = bool(np.any(segmented_protection))
    full_removed = int(np.count_nonzero(cv2.bitwise_and(mask, full_protection)))
    full_ratio = full_removed / float(before)
    full_result = cv2.bitwise_and(mask, cv2.bitwise_not(full_protection))
    minimum_remaining = max(24, int(round(before * 0.20)))

    if full_ratio <= 0.55 and int(np.count_nonzero(full_result)) >= minimum_remaining:
        return full_result, full_removed, full_ratio, "segmented" if has_segmented_protection else "point_guard", False

    guarded_result = cv2.bitwise_and(mask, cv2.bitwise_not(point_guards))
    guarded_removed = int(np.count_nonzero(cv2.bitwise_and(mask, point_guards)))
    guarded_ratio = guarded_removed / float(before)
    return guarded_result, guarded_removed, guarded_ratio, "point_guard", True


def decode_mask(
    decoder: ort.InferenceSession,
    embeddings: np.ndarray,
    prompts: list[list[float]],
    labels: list[int],
    transform: dict[str, float | int],
    previous_low_res_logits: np.ndarray | None = None,
) -> tuple[np.ndarray, float, np.ndarray]:
    point_coords = np.array([prompts], dtype=np.float32)
    point_labels = np.array([labels], dtype=np.float32)
    mask_input = np.zeros((1, 1, 256, 256), dtype=np.float32)
    has_mask_input = np.zeros((1,), dtype=np.float32)
    if previous_low_res_logits is not None:
        candidate = np.asarray(previous_low_res_logits, dtype=np.float32)
        if candidate.shape == (1, 1, 256, 256):
            mask_input = candidate
            has_mask_input = np.ones((1,), dtype=np.float32)
    outputs = decoder.run(None, {
        "image_embeddings": embeddings,
        "point_coords": point_coords,
        "point_labels": point_labels,
        "mask_input": mask_input,
        "has_mask_input": has_mask_input,
        "orig_im_size": np.array([MODEL_HEIGHT, MODEL_WIDTH], dtype=np.float32),
    })
    canvas_logits = np.squeeze(outputs[0])
    offset_x = int(transform["offsetX"])
    offset_y = int(transform["offsetY"])
    resized_width = int(transform["resizedWidth"])
    resized_height = int(transform["resizedHeight"])
    original_width = int(transform["originalWidth"])
    original_height = int(transform["originalHeight"])
    content_logits = canvas_logits[
        offset_y:offset_y + resized_height,
        offset_x:offset_x + resized_width,
    ]
    if content_logits.size == 0:
        raise RuntimeError("MobileSAM produced an empty letterbox content area.")
    original_logits = cv2.resize(
        content_logits,
        (original_width, original_height),
        interpolation=cv2.INTER_LINEAR,
    )
    mask = (original_logits > 0).astype(np.uint8) * 255
    return mask, float(np.ravel(outputs[1])[0]), np.asarray(outputs[2], dtype=np.float32)


def model_point(point: list[float], transform: dict[str, float | int]) -> list[float]:
    original_width = float(transform["originalWidth"])
    original_height = float(transform["originalHeight"])
    scale = float(transform["scale"])
    return [
        float(transform["offsetX"]) + point[0] * original_width * scale,
        float(transform["offsetY"]) + point[1] * original_height * scale,
    ]


def box_prompt(
    box: list[float],
    transform: dict[str, float | int],
) -> tuple[list[list[float]], list[int]]:
    return [
        model_point([box[0], box[1]], transform),
        model_point([box[2], box[3]], transform),
    ], [2, 3]


def mask_geometry(mask: np.ndarray, target_box: list[float]) -> dict[str, float | int | list[int]]:
    height, width = mask.shape
    left = max(0, min(width - 1, int(np.floor(target_box[0] * width))))
    top = max(0, min(height - 1, int(np.floor(target_box[1] * height))))
    right = max(left + 1, min(width, int(np.ceil(target_box[2] * width))))
    bottom = max(top + 1, min(height, int(np.ceil(target_box[3] * height))))
    selected = int(np.count_nonzero(mask))
    inside = int(np.count_nonzero(mask[top:bottom, left:right]))
    target_area = max(1, (right - left) * (bottom - top))
    ys, xs = np.nonzero(mask[top:bottom, left:right])
    span_x = (int(xs.max()) - int(xs.min()) + 1) / float(max(1, right - left)) if xs.size else 0.0
    span_y = (int(ys.max()) - int(ys.min()) + 1) / float(max(1, bottom - top)) if ys.size else 0.0
    return {
        "selected": selected,
        "inside": inside,
        "targetCoverage": inside / float(target_area),
        "targetContainment": inside / float(max(1, selected)),
        "targetSpanX": span_x,
        "targetSpanY": span_y,
        "targetSpanScore": (span_x * span_y) ** 0.5,
        "targetPixelBounds": [left, top, right, bottom],
    }


def segment(
    image_path: Path,
    box: list[float],
    output_path: Path,
    model_dir: Path,
    target_width: int | None = None,
    target_height: int | None = None,
    source_crop: list[int] | None = None,
    include_rle: bool = False,
    include_preview: bool = False,
    clip_box: list[float] | None = None,
    positive_points: list[list[float]] | None = None,
    negative_points: list[list[float]] | None = None,
    color_refine: str = "none",
    color_families: list[str] | None = None,
    color_hints: list[str] | None = None,
    color_tolerance: float = 52,
    semantic_scope: str = "unknown",
    image_key: str | None = None,
) -> dict:
    started = time.time()
    semantic_scope = "subpart" if semantic_scope == "part" else semantic_scope
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Cannot read image: {image_path}")

    original_height, original_width = image.shape[:2]
    encoder_input, transform = letterbox_image(image)

    encoder = session(model_dir / "mobile_sam_image_encoder.onnx")
    embeddings, embedding_cache_hit = cached_embeddings(encoder, encoder_input, image_key)

    decoder = session(model_dir / "sam_mask_decoder_single.onnx")
    left, top, right, bottom = box
    positives = positive_points or []
    negatives = negative_points or []
    families = color_families or []
    hints = color_hints or []

    if len(positives) + len(negatives) > MAX_TOTAL_POINTS:
        raise RuntimeError(
            f"Positive and negative points together must contain at most {MAX_TOTAL_POINTS} items."
        )

    # MobileSAM's decoder is designed to interpret positive and negative clicks
    # together. Earlier versions segmented every click independently and then
    # unioned/subtracted whole objects, which made a small correction jump. In
    # v9.7 every correction is one joint prompt against one candidate.
    prompts, labels = box_prompt(box, transform)
    prompts.extend(model_point(point, transform) for point in positives)
    labels.extend([1] * len(positives))
    prompts.extend(model_point(point, transform) for point in negatives)
    labels.extend([0] * len(negatives))
    mask, base_iou, _ = decode_mask(decoder, embeddings, prompts, labels, transform)
    candidate_mode = "box_points_joint" if positives or negatives else "box"
    initial_geometry = mask_geometry(mask, box)
    iou_scores = [base_iou]

    # Keep only a tiny deterministic guard around explicit negative clicks as a
    # final safety invariant. No independently segmented exclusion is used.
    protected_mask = np.zeros_like(mask)

    kernel = np.ones((3, 3), dtype=np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    clip_left, clip_top, clip_right, clip_bottom = clip_box or [
        max(0, left - 0.08),
        max(0, top - 0.08),
        min(1, right + 0.08),
        min(1, bottom + 0.08),
    ]
    left_px = max(0, int(clip_left * original_width))
    top_px = max(0, int(clip_top * original_height))
    right_px = min(original_width, int(np.ceil(clip_right * original_width)))
    bottom_px = min(original_height, int(np.ceil(clip_bottom * original_height)))
    limited = np.zeros_like(mask)
    limited[top_px:bottom_px, left_px:right_px] = mask[top_px:bottom_px, left_px:right_px]
    mask = limited

    semantic_pixels = int(np.count_nonzero(mask))
    color_retained_ratio = 1.0
    if color_refine == "source":
        source_mask = np.zeros_like(mask)
        if families:
            source_mask = cv2.bitwise_or(source_mask, color_family_mask(image, families))
        if hints:
            source_mask = cv2.bitwise_or(source_mask, hinted_color_mask(image, hints, color_tolerance))
        if not np.any(source_mask):
            source_mask = seeded_color_mask(image, positives, color_tolerance)
        source_mask = cv2.morphologyEx(source_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        refined = retain_anchored_color_components(source_mask, mask, box, [clip_left, clip_top, clip_right, clip_bottom], positives)
        refined = cv2.morphologyEx(refined, cv2.MORPH_CLOSE, kernel, iterations=1)
        refined_pixels = int(np.count_nonzero(refined))
        minimum_refined_pixels = max(24, int(original_width * original_height * 0.00005))
        if refined_pixels < minimum_refined_pixels:
            raise RuntimeError("Source-color refinement did not find a reliable target part. Correct the target point or source color.")
        color_expansion_constrained = False
        if semantic_pixels > 0 and (negatives or refined_pixels > int(semantic_pixels * 1.35)):
            support_radius = max(2, int(round(min(original_width, original_height) * (0.004 if negatives else 0.008))))
            support_kernel = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE,
                (support_radius * 2 + 1, support_radius * 2 + 1),
            )
            semantic_support = cv2.dilate(mask, support_kernel, iterations=1)
            constrained = cv2.bitwise_and(refined, semantic_support)
            if int(np.count_nonzero(constrained)) >= minimum_refined_pixels:
                refined = constrained
                refined_pixels = int(np.count_nonzero(refined))
                color_expansion_constrained = True
        mask = refined
    else:
        color_expansion_constrained = False

    mask, protected_pixels_removed, protected_removal_ratio, protection_mode, protection_conflict = apply_protected_regions(
        mask,
        protected_mask,
        negatives,
    )
    if color_refine == "source":
        color_retained_ratio = int(np.count_nonzero(mask)) / float(max(1, semantic_pixels))

    protected_leakage = protected_point_leakage(mask, negatives)
    if protected_leakage > 0.02:
        raise RuntimeError("The final candidate could not enforce an explicitly protected point.")

    if not np.any(mask):
        raise RuntimeError("The segmentation mask is empty. Refine the target box and try again.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), mask):
        raise RuntimeError(f"Cannot write mask: {output_path}")

    pixels = int(np.count_nonzero(mask))
    target_left_px = max(0, int(left * original_width))
    target_top_px = max(0, int(top * original_height))
    target_right_px = min(original_width, int(np.ceil(right * original_width)))
    target_bottom_px = min(original_height, int(np.ceil(bottom * original_height)))
    box_pixels = max(1, (target_right_px - target_left_px) * (target_bottom_px - target_top_px))
    pixels_in_box = int(np.count_nonzero(mask[target_top_px:target_bottom_px, target_left_px:target_right_px]))
    fill_ratio = pixels_in_box / float(box_pixels)
    if fill_ratio < 0.015:
        raise RuntimeError("The segmentation result is too small to be reliable.")

    final_geometry = mask_geometry(mask, box)
    completeness = min(1.0, float(final_geometry["targetCoverage"]) / (0.45 if semantic_scope == "whole_object" else 0.18))
    geometric_integrity = (
        max(0.0, min(1.0, float(sum(iou_scores) / max(1, len(iou_scores))))) * 0.28
        + float(final_geometry["targetContainment"]) * 0.24
        + completeness * 0.22
        + float(final_geometry["targetSpanScore"]) * 0.26
    )
    result = {
        "ok": True,
        "selectedPixels": pixels,
        "selectedRatio": pixels / float(original_width * original_height),
        "boxFillRatio": fill_ratio,
        "targetContainment": pixels_in_box / float(max(1, pixels)),
        "targetCoverage": float(final_geometry["targetCoverage"]),
        "targetSpanX": float(final_geometry["targetSpanX"]),
        "targetSpanY": float(final_geometry["targetSpanY"]),
        "targetSpanScore": float(final_geometry["targetSpanScore"]),
        "geometricIntegrity": float(max(0.0, min(1.0, geometric_integrity))),
        "iouScore": float(sum(iou_scores) / max(1, len(iou_scores))),
        "promptPointCount": len(positives) + len(negatives),
        "addedComponentCount": 0,
        "excludedComponentCount": len(negatives),
        "compositionMode": "joint_positive_negative_prompt_then_source_color_then_point_guard" if color_refine == "source" else "joint_positive_negative_prompt_then_point_guard",
        "candidateMode": candidate_mode,
        "candidateCount": 1,
        "initialTargetCoverage": float(initial_geometry["targetCoverage"]),
        "semanticScope": semantic_scope,
        "colorRefined": color_refine == "source",
        "sourceColorFamilies": families,
        "sourceColorHints": hints,
        # Source-colour completion may legitimately add disconnected pixels
        # that the semantic seed missed, so this ratio can be greater than 1.
        # Keep the legacy field for older bridge clients and expose the
        # unambiguous name for v9.7 diagnostics.
        "colorRetainedRatio": color_retained_ratio,
        "colorPixelRatioToSemanticMask": color_retained_ratio,
        "colorExpandedBeyondSemantic": color_retained_ratio > 1.0,
        "colorExpansionConstrained": color_expansion_constrained,
        "protectedLeakage": protected_leakage,
        "protectedPixelsRemoved": protected_pixels_removed,
        "protectedRemovalRatio": protected_removal_ratio,
        "protectionMode": protection_mode,
        "protectionConflict": protection_conflict,
        "engine": "MobileSAM",
        "preprocessMode": "aspect_ratio_letterbox",
        "embeddingCacheHit": embedding_cache_hit,
        "sourceImageWidth": original_width,
        "sourceImageHeight": original_height,
        "modelInputWidth": MODEL_WIDTH,
        "modelInputHeight": MODEL_HEIGHT,
        "letterboxContentWidth": int(transform["resizedWidth"]),
        "letterboxContentHeight": int(transform["resizedHeight"]),
        "letterboxOffsetX": int(transform["offsetX"]),
        "letterboxOffsetY": int(transform["offsetY"]),
        "elapsedMs": int((time.time() - started) * 1000),
    }

    if include_preview:
        overlay = image.copy()
        green = np.zeros_like(overlay)
        green[:, :, 1] = 255
        selected = mask > 0
        overlay[selected] = cv2.addWeighted(image[selected], 0.45, green[selected], 0.55, 0)
        cv2.rectangle(overlay, (target_left_px, target_top_px), (max(target_left_px, target_right_px - 1), max(target_top_px, target_bottom_px - 1)), (80, 210, 255), 2)
        ok, encoded = cv2.imencode(".jpg", overlay, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if not ok:
            raise RuntimeError("Cannot encode mask preview.")
        result["previewBase64"] = base64.b64encode(encoded.tobytes()).decode("ascii")
        result["previewMime"] = "image/jpeg"
        result["previewWidth"] = original_width
        result["previewHeight"] = original_height

        # Verification must see the whole allowed search region, otherwise a
        # leak outside the tight target box is invisible to the reviewer.
        mask_preview = mask[top_px:bottom_px, left_px:right_px]
        if mask_preview.size == 0:
            raise RuntimeError("Cannot crop mask preview.")
        ok_mask, encoded_mask = cv2.imencode(
            ".png",
            mask_preview,
            [cv2.IMWRITE_PNG_COMPRESSION, 3],
        )
        if not ok_mask:
            raise RuntimeError("Cannot encode cropped mask preview.")
        result["maskPreviewBase64"] = base64.b64encode(encoded_mask.tobytes()).decode("ascii")
        result["maskPreviewMime"] = "image/png"
        result["maskPreviewWidth"] = int(mask_preview.shape[1])
        result["maskPreviewHeight"] = int(mask_preview.shape[0])
        result["maskPreviewBounds"] = [left_px, top_px, right_px, bottom_px]
        if source_crop and target_width and target_height:
            document_crop_width = source_crop[2] - source_crop[0]
            document_crop_height = source_crop[3] - source_crop[1]
            result["maskPreviewCanvasBounds"] = [
                source_crop[0] + int(np.floor(left_px / original_width * document_crop_width)),
                source_crop[1] + int(np.floor(top_px / original_height * document_crop_height)),
                source_crop[0] + int(np.ceil(right_px / original_width * document_crop_width)),
                source_crop[1] + int(np.ceil(bottom_px / original_height * document_crop_height)),
            ]

    if include_rle:
        width = int(target_width or original_width)
        height = int(target_height or original_height)
        if width < 1 or height < 1 or width * height > 80_000_000:
            raise RuntimeError("Requested mask size is invalid or too large.")
        document_crop = source_crop or [0, 0, width, height]
        if len(document_crop) != 4 or not (
            0 <= document_crop[0] < document_crop[2] <= width
            and 0 <= document_crop[1] < document_crop[3] <= height
        ):
            raise RuntimeError("Source crop must be inside the target document canvas.")
        result["width"] = width
        result["height"] = height
        cropped_rle, selected_target_pixels = encode_cropped_rle(mask, width, height, document_crop)
        result["croppedRle"] = cropped_rle
        result["maskEncoding"] = "rle-cropped-v1"
        result["sourceCrop"] = {
            "left": int(document_crop[0]),
            "top": int(document_crop[1]),
            "right": int(document_crop[2]),
            "bottom": int(document_crop[3]),
            "canvasWidth": width,
            "canvasHeight": height,
        }
        result["selectedPixels"] = selected_target_pixels
        result["selectedRatio"] = result["selectedPixels"] / float(width * height)
        # Small documents keep the old field during the v9.7 transition. Large
        # documents never allocate or transport a full-canvas RLE.
        if width * height <= LEGACY_RLE_MAX_PIXELS:
            target_mask = np.zeros((height, width), dtype=np.uint8)
            crop_width = int(document_crop[2] - document_crop[0])
            crop_height = int(document_crop[3] - document_crop[1])
            crop_mask = mask if mask.shape == (crop_height, crop_width) else cv2.resize(
                mask,
                (crop_width, crop_height),
                interpolation=cv2.INTER_NEAREST,
            )
            target_mask[document_crop[1]:document_crop[3], document_crop[0]:document_crop[2]] = crop_mask
            result["rle"] = encode_rle(target_mask)
            result["legacyRle"] = True
        else:
            result["legacyRle"] = False
    else:
        result["width"] = original_width
        result["height"] = original_height

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--box", required=True, help="Normalized left,top,right,bottom")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--image-key", help="Stable image hash used by the persistent embedding cache")
    parser.add_argument("--target-width", type=int)
    parser.add_argument("--target-height", type=int)
    parser.add_argument("--source-crop", help="Target-document pixel crop represented by the input image")
    parser.add_argument("--rle", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--clip-box", help="Normalized safety clip left,top,right,bottom")
    parser.add_argument("--positive-points", help="JSON array of normalized [x,y] points")
    parser.add_argument("--negative-points", help="JSON array of normalized [x,y] points")
    parser.add_argument("--color-refine", choices=["none", "source"], default="none")
    parser.add_argument("--color-families", help="JSON array of source color-family names")
    parser.add_argument("--color-hints", help="JSON array of source #RRGGBB colors")
    parser.add_argument("--color-tolerance", type=float, default=52)
    parser.add_argument("--semantic-scope", choices=["unknown", "whole_object", "subpart", "part"], default="unknown")
    args = parser.parse_args()

    try:
        box = [float(value) for value in args.box.split(",")]
        if len(box) != 4 or not (0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
            raise ValueError("Box must be normalized left,top,right,bottom.")
        clip_box = [float(value) for value in args.clip_box.split(",")] if args.clip_box else None
        if clip_box is not None and (len(clip_box) != 4 or not (0 <= clip_box[0] < clip_box[2] <= 1 and 0 <= clip_box[1] < clip_box[3] <= 1)):
            raise ValueError("Clip box must be normalized left,top,right,bottom.")
        source_crop = [int(value) for value in args.source_crop.split(",")] if args.source_crop else None
        if source_crop is not None and len(source_crop) != 4:
            raise ValueError("Source crop must be pixel-space left,top,right,bottom.")
        print(json.dumps(segment(
            args.image,
            box,
            args.output,
            args.models,
            target_width=args.target_width,
            target_height=args.target_height,
            source_crop=source_crop,
            include_rle=args.rle,
            include_preview=args.preview,
            clip_box=clip_box,
            positive_points=parse_points(args.positive_points),
            negative_points=parse_points(args.negative_points),
            color_refine=args.color_refine,
            color_families=parse_strings(args.color_families, "Color families", 4),
            color_hints=parse_strings(args.color_hints, "Color hints", 6),
            color_tolerance=args.color_tolerance,
            semantic_scope=args.semantic_scope,
            image_key=args.image_key,
        ), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        raise


if __name__ == "__main__":
    main()
