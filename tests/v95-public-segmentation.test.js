"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.5";
const croppedRleRelease = /^v9\.(?:[7-9]|\d{2,})$/.test(testVersion);
const script = path.join(root, "segmentation", "mobilesam_segment.py");
const image = path.join(root, "tests", "visual-object-fixture.png");
const models = path.join(root, "models", "mobilesam");
const output = path.join(root, "runtime", `${testVersion.replace(/[^a-z0-9.-]/gi, "-")}-public-object.png`);
const requiredModels = {
  "mobile_sam_image_encoder.onnx": {
    size: 28157093,
    sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
  },
  "sam_mask_decoder_single.onnx": {
    size: 16501323,
    sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d"
  }
};
const width = 400;
const height = 300;

function pythonRuntime() {
  const candidates = [
    process.env.PHOTOSHOP_ASSISTANT_PYTHON,
    "python"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "";
}

function decodeRle(rle, expectedLength) {
  assert(Array.isArray(rle) && rle.length > 1, "segmentation must return a non-empty RLE mask");
  const mask = new Uint8Array(expectedLength);
  let cursor = 0;
  let value = 0;
  for (const rawCount of rle) {
    const count = Number(rawCount);
    assert(Number.isInteger(count) && count >= 0 && cursor + count <= expectedLength, "invalid mask RLE");
    if (value === 1) mask.fill(1, cursor, cursor + count);
    cursor += count;
    value = value === 0 ? 1 : 0;
  }
  assert.strictEqual(cursor, expectedLength, "RLE must cover the complete output canvas");
  return mask;
}

function regionRatio(mask, box) {
  const left = Math.floor(box[0] * width);
  const top = Math.floor(box[1] * height);
  const right = Math.ceil(box[2] * width);
  const bottom = Math.ceil(box[3] * height);
  let selected = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      selected += mask[y * width + x];
      total += 1;
    }
  }
  return selected / Math.max(1, total);
}

const python = pythonRuntime();
assert(python, "Python runtime is required for the deterministic mask-protection regression");

const protection = spawnSync(python, [path.join(root, "tests", "v95-protection-unit.py")], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 5 * 1024 * 1024,
  timeout: 30000
});
assert.strictEqual(protection.status, 0, protection.stderr || protection.stdout || "mask-protection regression failed");

const missingModels = Object.keys(requiredModels)
  .map((name) => path.join(models, name))
  .filter((file) => !fs.existsSync(file));
if (missingModels.length) {
  if (process.env.PS_AGENT_REQUIRE_MODELS === "1" || process.env.PS_AGENT_REQUIRE_SEGMENTATION === "1") {
    throw new Error(`MobileSAM model files are required but missing: ${missingModels.join(", ")}`);
  }
  console.log(`${testVersion} deterministic mask tests passed; SKIP MobileSAM fixture (models missing). Set PS_AGENT_REQUIRE_MODELS=1 for fail-closed strict mode.`);
  process.exit(0);
}

for (const [name, expected] of Object.entries(requiredModels)) {
  const file = path.join(models, name);
  const bytes = fs.readFileSync(file);
  assert.strictEqual(bytes.length, expected.size, `${name} size does not match the approved v9.7 baseline`);
  assert.strictEqual(crypto.createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name} SHA-256 does not match the approved v9.7 baseline`);
}

assert(fs.existsSync(script), "MobileSAM segmentation script is missing");
assert(fs.existsSync(image), "public visual-object fixture is missing");
fs.mkdirSync(path.dirname(output), { recursive: true });

const args = [
  script,
  "--image", image,
  "--box", "0.53,0.18,0.90,0.84",
  "--clip-box", "0.48,0.12,0.91,0.87",
  "--positive-points", "[[0.70,0.30],[0.56,0.36],[0.86,0.36],[0.70,0.70]]",
  "--negative-points", "[[0.22,0.31],[0.21,0.68],[0.92,0.50]]",
  "--semantic-scope", "whole_object",
  "--target-width", String(width),
  "--target-height", String(height),
  "--output", output,
  "--models", models,
  "--rle",
  "--preview"
];

try {
  const result = spawnSync(python, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180000
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout || "MobileSAM fixture process failed");
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.engine, "MobileSAM");
  assert.strictEqual(payload.semanticScope, "whole_object");
  if (croppedRleRelease) {
    assert.strictEqual(payload.compositionMode, "joint_positive_negative_prompt_then_point_guard");
    assert(payload.candidateCount >= 1, `${testVersion} joint prompt must return a candidate`);
  } else {
    assert.strictEqual(payload.compositionMode, "complete_candidates_union_then_single_protection");
    assert(payload.candidateCount >= 2, "whole-object selection must compare multiple candidates");
  }
  assert(payload.targetContainment >= 0.98, "selected pixels escaped the target object region");
  assert(payload.targetCoverage >= 0.45, "selection covers too little of the complete object");
  assert(payload.targetSpanX >= 0.90 && payload.targetSpanY >= 0.85, "selection collapsed to an object fragment");
  assert(payload.geometricIntegrity >= 0.90, "selection geometry is incomplete");
  assert(payload.iouScore >= 0.90, "model confidence is below the public fixture threshold");
  assert(typeof payload.previewBase64 === "string" && payload.previewBase64.length > 1000);
  assert.strictEqual(payload.maskPreviewMime, "image/png");
  assert(payload.maskPreviewWidth > 0 && payload.maskPreviewHeight > 0, "cropped mask preview dimensions are missing");
  const maskPreview = Buffer.from(payload.maskPreviewBase64, "base64");
  assert(maskPreview.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "mask preview must be a valid PNG");
  if (croppedRleRelease) {
    assert.strictEqual(payload.maskEncoding, "rle-cropped-v1");
    assert(payload.croppedRle && Array.isArray(payload.croppedRle.counts), `${testVersion} must return cropped RLE`);
    assert.strictEqual(payload.croppedRle.canvasWidth, width);
    assert.strictEqual(payload.croppedRle.canvasHeight, height);
    assert(payload.croppedRle.width > 0 && payload.croppedRle.width <= width);
    assert(payload.croppedRle.height > 0 && payload.croppedRle.height <= height);
  }

  const mask = decodeRle(payload.rle, width * height);
  const requiredRegions = [
    [0.61, 0.21, 0.80, 0.55],
    [0.50, 0.27, 0.64, 0.52],
    [0.79, 0.27, 0.91, 0.52],
    [0.66, 0.54, 0.75, 0.72],
    [0.61, 0.70, 0.80, 0.83]
  ];
  for (const region of requiredRegions) {
    assert(regionRatio(mask, region) >= 0.18, `complete object component is missing: ${region.join(",")}`);
  }

  const protectedRegions = [
    [0.10, 0.17, 0.32, 0.46],
    [0.10, 0.55, 0.32, 0.79],
    [0.20, 0.86, 0.80, 0.96]
  ];
  for (const region of protectedRegions) {
    assert(regionRatio(mask, region) <= 0.01, `selection leaked into a protected distractor: ${region.join(",")}`);
  }
} finally {
  if (process.env.PS_AGENT_KEEP_ARTIFACTS !== "1" && fs.existsSync(output)) fs.unlinkSync(output);
}

console.log(`${testVersion} public complete-object segmentation regression passed`);
