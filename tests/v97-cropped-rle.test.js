"use strict";

const assert = require("assert");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const {
  decodeSegmentationRleCrop,
  normalizeRlePayload,
  summarizeSegmentationRle
} = require(`../uxp-${testVersion}/mask-rle.js`);

function encodeMask(mask) {
  const counts = [];
  let bit = 0;
  let count = 0;
  for (const raw of mask) {
    const value = raw ? 1 : 0;
    if (value === bit) count += 1;
    else { counts.push(count); bit = value; count = 1; }
  }
  counts.push(count);
  return counts;
}

const canvasWidth = 8;
const canvasHeight = 6;
const cropped = {
  encoding: "rle-cropped-v1",
  order: "row-major",
  startsWith: 0,
  originX: 2,
  originY: 1,
  width: 4,
  height: 3,
  canvasWidth,
  canvasHeight,
  counts: [0, 12]
};

const normalized = normalizeRlePayload(cropped, canvasWidth, canvasHeight);
assert.deepStrictEqual(normalized.origin, { left: 2, top: 1 });
assert.strictEqual(normalized.width, 4);
assert.strictEqual(normalized.height, 3);
assert.strictEqual(normalized.expectedLength, 12);
assert.strictEqual(normalized.cropped, true);

const region = {
  bounds: { left: 1, top: 0, right: 7, bottom: 5 },
  targetBounds: { left: 2, top: 1, right: 6, bottom: 4 },
  seed: { x: 3, y: 2 }
};
const summary = summarizeSegmentationRle(cropped, canvasWidth, canvasHeight, region);
assert.deepStrictEqual(summary, {
  selected: 12,
  bounds: { left: 2, top: 1, right: 6, bottom: 4 },
  insideTarget: 12,
  outsideSearch: 0,
  seedDistance: 0
});

const decoded = decodeSegmentationRleCrop(cropped, canvasWidth, canvasHeight, summary.bounds, 1);
assert.deepStrictEqual(decoded.origin, { left: 1, top: 0 });
assert.strictEqual(decoded.width, 6);
assert.strictEqual(decoded.height, 5);
assert.strictEqual(decoded.selected, 12);
assert.strictEqual(decoded.mask.length, 30, "only the bounded selection crop should be materialized");
assert.strictEqual(Array.from(decoded.mask).filter(Boolean).length, 12);

const fullMask = new Uint8Array(canvasWidth * canvasHeight);
for (let y = 1; y < 4; y += 1) fullMask.fill(1, y * canvasWidth + 2, y * canvasWidth + 6);
const legacy = encodeMask(fullMask);
assert.strictEqual(normalizeRlePayload(legacy, canvasWidth, canvasHeight).cropped, false);
assert.deepStrictEqual(summarizeSegmentationRle(legacy, canvasWidth, canvasHeight, region), summary);

for (const operation of [
  () => normalizeRlePayload({ ...cropped, canvasWidth: 9 }, canvasWidth, canvasHeight),
  () => normalizeRlePayload({ ...cropped, originX: 6 }, canvasWidth, canvasHeight),
  () => summarizeSegmentationRle({ ...cropped, counts: [0, 11] }, canvasWidth, canvasHeight, region),
  () => summarizeSegmentationRle({ ...cropped, counts: [0, 13] }, canvasWidth, canvasHeight, region),
  () => decodeSegmentationRleCrop(cropped, canvasWidth, canvasHeight, { left: 3, top: 2, right: 4, bottom: 3 }, 0)
]) {
  assert.throws(operation);
}

console.log(`${testVersion} cropped-RLE coordinates, legacy compatibility, bounded decode, and corruption guards passed`);
