#!/usr/bin/env python3
"""Local, deterministic document/reference correspondence check.

The annotation image may be resized, contain a Photoshop frame, or have a few
drawn boxes/arrows.  We combine feature geometry with edge-template matching;
the result is only an authorization gate and never supplies edit coordinates.
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import cv2
import numpy as np


MAX_PIXELS = 12 * 1024 * 1024
MAX_EDGE = 4096


def load_image(path: str) -> np.ndarray:
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("image cannot be decoded")
    height, width = image.shape[:2]
    if width < 2 or height < 2 or width > MAX_EDGE or height > MAX_EDGE or width * height > MAX_PIXELS:
        raise ValueError("decoded image dimensions exceed the safety limit")
    return image


def resize_max(image: np.ndarray, maximum: int) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, float(maximum) / float(max(width, height)))
    if scale >= 0.999:
        return image.copy()
    return cv2.resize(image, (max(2, round(width * scale)), max(2, round(height * scale))), interpolation=cv2.INTER_AREA)


def normalized_correlation(left: np.ndarray, right: np.ndarray) -> float:
    a = left.astype(np.float32).reshape(-1)
    b = right.astype(np.float32).reshape(-1)
    a -= float(a.mean())
    b -= float(b.mean())
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator < 1e-6:
        return 0.0
    return float(np.clip(np.dot(a, b) / denominator, -1.0, 1.0))


def histogram_similarity(left: np.ndarray, right: np.ndarray) -> float:
    def histogram(image: np.ndarray) -> np.ndarray:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        value = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
        return cv2.normalize(value, value).flatten()

    return float(np.clip(cv2.compareHist(histogram(left), histogram(right), cv2.HISTCMP_CORREL), -1.0, 1.0))


def edge_image(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.Canny(gray, 45, 135)


def direct_score(document: np.ndarray, reference: np.ndarray) -> dict:
    doc_ratio = document.shape[1] / document.shape[0]
    ref_ratio = reference.shape[1] / reference.shape[0]
    ratio_delta = abs(math.log(max(1e-6, doc_ratio / ref_ratio)))
    if ratio_delta > 0.20:
        return {"score": 0.0, "edge": 0.0, "gray": 0.0, "histogram": 0.0}
    size = (128, 128)
    doc = cv2.resize(document, size, interpolation=cv2.INTER_AREA)
    ref = cv2.resize(reference, size, interpolation=cv2.INTER_AREA)
    edge = max(0.0, normalized_correlation(edge_image(doc), edge_image(ref)))
    gray = max(0.0, normalized_correlation(cv2.cvtColor(doc, cv2.COLOR_BGR2GRAY), cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)))
    hist = max(0.0, histogram_similarity(doc, ref))
    return {"score": edge * 0.48 + gray * 0.34 + hist * 0.18, "edge": edge, "gray": gray, "histogram": hist}


def orb_score(document: np.ndarray, reference: np.ndarray) -> dict:
    doc = resize_max(document, 1200)
    ref = resize_max(reference, 1200)
    doc_gray = cv2.cvtColor(doc, cv2.COLOR_BGR2GRAY)
    ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    detector = cv2.ORB_create(nfeatures=2200, scaleFactor=1.2, nlevels=8, fastThreshold=9)
    key_doc, desc_doc = detector.detectAndCompute(doc_gray, None)
    key_ref, desc_ref = detector.detectAndCompute(ref_gray, None)
    if desc_doc is None or desc_ref is None or len(key_doc) < 10 or len(key_ref) < 10:
        return {"score": 0.0, "inliers": 0, "inlierRatio": 0.0, "geometryValid": False}
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(desc_doc, desc_ref, k=2)
    good = [first for first, second in matches if first.distance < 0.76 * second.distance]
    if len(good) < 8:
        return {"score": 0.0, "inliers": 0, "inlierRatio": 0.0, "geometryValid": False}
    source = np.float32([key_doc[item.queryIdx].pt for item in good]).reshape(-1, 1, 2)
    target = np.float32([key_ref[item.trainIdx].pt for item in good]).reshape(-1, 1, 2)
    matrix, mask = cv2.findHomography(source, target, cv2.RANSAC, 4.0)
    if matrix is None or mask is None:
        return {"score": 0.0, "inliers": 0, "inlierRatio": 0.0, "geometryValid": False}
    inliers = int(mask.ravel().sum())
    ratio = inliers / max(1, len(good))
    corners = np.float32([[[0, 0]], [[doc.shape[1], 0]], [[doc.shape[1], doc.shape[0]]], [[0, doc.shape[0]]]])
    projected = cv2.perspectiveTransform(corners, matrix).reshape(-1, 2)
    area = abs(float(cv2.contourArea(projected.astype(np.float32))))
    reference_area = float(ref.shape[0] * ref.shape[1])
    finite = bool(np.isfinite(projected).all())
    geometry_valid = finite and cv2.isContourConvex(projected.astype(np.float32)) and 0.025 <= area / max(1.0, reference_area) <= 1.35
    score = min(1.0, inliers / 32.0) * 0.56 + min(1.0, ratio / 0.62) * 0.44 if geometry_valid else 0.0
    return {"score": float(score), "inliers": inliers, "inlierRatio": float(ratio), "geometryValid": bool(geometry_valid)}


def template_score(document: np.ndarray, reference: np.ndarray) -> dict:
    ref = resize_max(reference, 320)
    ref_edges = edge_image(ref)
    best = {"score": 0.0, "edge": 0.0, "gray": 0.0, "histogram": 0.0, "scale": 0.0}
    doc_ratio = document.shape[1] / document.shape[0]
    for fraction in np.linspace(0.28, 1.0, 19):
        width = int(round(ref.shape[1] * float(fraction)))
        height = int(round(width / max(1e-6, doc_ratio)))
        if width < 24 or height < 24 or width > ref.shape[1] or height > ref.shape[0]:
            continue
        candidate = cv2.resize(document, (width, height), interpolation=cv2.INTER_AREA)
        candidate_edges = edge_image(candidate)
        if float(candidate_edges.std()) < 5.0:
            continue
        response = cv2.matchTemplate(ref_edges, candidate_edges, cv2.TM_CCOEFF_NORMED)
        _minimum, edge, _min_location, location = cv2.minMaxLoc(response)
        crop = ref[location[1]:location[1] + height, location[0]:location[0] + width]
        if crop.shape[:2] != candidate.shape[:2]:
            continue
        gray = max(0.0, normalized_correlation(cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY), cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)))
        hist = max(0.0, histogram_similarity(candidate, crop))
        combined = max(0.0, float(edge)) * 0.60 + gray * 0.27 + hist * 0.13
        if combined > best["score"]:
            best = {"score": float(combined), "edge": max(0.0, float(edge)), "gray": gray, "histogram": hist, "scale": float(fraction)}
    return best


def compare(document: np.ndarray, reference: np.ndarray) -> dict:
    direct = direct_score(document, reference)
    orb = orb_score(document, reference)
    template = template_score(document, reference)
    orb_match = orb["geometryValid"] and orb["inliers"] >= 12 and orb["inlierRatio"] >= 0.28 and orb["score"] >= 0.52
    template_match = template["score"] >= 0.56 and template["edge"] >= 0.43
    direct_match = direct["score"] >= 0.64 and direct["edge"] >= 0.48
    matched = bool(orb_match or template_match or direct_match)
    method = "orb" if orb_match else "template" if template_match else "direct" if direct_match else "none"
    confidence = max(float(direct["score"]), float(orb["score"]), float(template["score"]))
    return {"ok": True, "match": matched, "method": method, "confidence": round(confidence, 6), "direct": direct, "orb": orb, "template": template}


def self_test() -> None:
    rng = np.random.default_rng(9182)
    document = np.zeros((360, 640, 3), dtype=np.uint8)
    document[:] = (42, 65, 94)
    for index in range(42):
        x = int(rng.integers(10, 610)); y = int(rng.integers(10, 330))
        color = tuple(int(value) for value in rng.integers(30, 245, size=3))
        cv2.circle(document, (x, y), int(rng.integers(4, 23)), color, -1)
    cv2.putText(document, "REFERENCE 98", (95, 185), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (245, 245, 245), 3, cv2.LINE_AA)
    annotated = cv2.resize(document, (960, 540), interpolation=cv2.INTER_AREA)
    cv2.rectangle(annotated, (420, 150), (760, 430), (0, 0, 255), 9)
    framed = np.full((700, 1100, 3), 28, dtype=np.uint8)
    framed[105:555, 145:945] = cv2.resize(document, (800, 450), interpolation=cv2.INTER_AREA)
    cv2.arrowedLine(framed, (985, 90), (790, 260), (0, 0, 255), 10)
    different = rng.integers(0, 256, size=document.shape, dtype=np.uint8)
    assert compare(document, annotated)["match"], "resized annotation should match"
    assert compare(document, framed)["match"], "framed annotation should match"
    assert not compare(document, different)["match"], "different poster must not match"
    print(json.dumps({"ok": True, "selfTest": True}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--document")
    parser.add_argument("--reference")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.document or not args.reference:
        raise ValueError("document and reference paths are required")
    print(json.dumps(compare(load_image(args.document), load_image(args.reference)), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # fail closed with one machine-readable line
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
