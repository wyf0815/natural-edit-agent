"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.3";
const source = fs.readFileSync(path.resolve(__dirname, `../uxp-${testVersion}/state-engine.js`), "utf8");
const context = {
  console,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  Boolean,
  JSON,
  require(name) {
    if (name === "photoshop") return { app: {}, action: {}, constants: {} };
    throw new Error(`unexpected require ${name}`);
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "state-engine.js" });
const state = context.PhotoshopAssistantV8State;

if (testVersion === "v9.7") {
  const completeIntegrityState = {
    hasDocument: true,
    fingerprint: "fingerprint",
    contentFingerprint: "content",
    document: { historyStateId: 12, compositeDigest: "composite" },
    activeLayers: [],
    selectionBounds: { left: 1, top: 2, right: 3, bottom: 4 },
    selectionDigest: "selection",
    integrity: {
      compositeDigestAvailable: true,
      selectionDigestAvailable: true,
      consistentRead: true,
      safetyStateComplete: false
    }
  };
  assert.strictEqual(state.isCompleteIntegritySnapshot(completeIntegrityState), true,
    "unknown complex-layer safety details must not block a complete gate snapshot");
  assert.strictEqual(state.isCompleteIntegritySnapshot({
    ...completeIntegrityState,
    selectionDigest: null,
    integrity: { ...completeIntegrityState.integrity, selectionDigestAvailable: false }
  }), false);
  assert.strictEqual(state.isCompleteIntegritySnapshot({
    ...completeIntegrityState,
    document: { ...completeIntegrityState.document, compositeDigest: null },
    integrity: { ...completeIntegrityState.integrity, compositeDigestAvailable: false }
  }), false);
  assert.strictEqual(state.isCompleteIntegritySnapshot({
    ...completeIntegrityState,
    selectionBounds: null,
    selectionDigest: "none"
  }), true);
  assert.strictEqual(state.isCompleteIntegritySnapshot({
    ...completeIntegrityState,
    selectionBounds: null,
    selectionDigest: null
  }), false);
  assert.strictEqual(state.isCompleteIntegritySnapshot({
    ...completeIntegrityState,
    integrity: { ...completeIntegrityState.integrity, consistentRead: false }
  }), false);
}

const text = state.describeText({
  textItem: {
    contents: "300ppi",
    orientation: "horizontal",
    isParagraphText: true,
    characterStyle: {
      font: "ArialMT",
      size: 200,
      leading: 200,
      tracking: 0,
      baselineShift: 12.5,
      horizontalScale: 100,
      verticalScale: 100
    },
    paragraphStyle: {
      justification: "left",
      hyphenation: false,
      firstLineIndent: 25,
      leftIndent: 16.6666667,
      rightIndent: 16.6666667,
      spaceBefore: 8.3333333,
      spaceAfter: 12.5
    }
  }
}, 300);

assert.ok(Math.abs(text.leading - 48) < 0.001);
assert.ok(Math.abs(text.baselineShift - 3) < 0.001);
assert.ok(Math.abs(text.firstLineIndent - 6) < 0.001);
assert.ok(Math.abs(text.leftIndent - 4) < 0.001);
assert.ok(Math.abs(text.rightIndent - 4) < 0.001);
assert.ok(Math.abs(text.spaceBefore - 2) < 0.001);
assert.ok(Math.abs(text.spaceAfter - 3) < 0.001);

const descriptor = {
  textKey: {
    textStyleRange: [{
      from: 0,
      to: 6,
      textStyle: {
        size: { _unit: "pointsUnit", _value: 48 },
        leading: { _unit: "pointsUnit", _value: 30 },
        baselineShift: { _unit: "pointsUnit", _value: 3 }
      }
    }],
    paragraphStyleRange: [{
      from: 0,
      to: 6,
      paragraphStyle: {
        firstLineIndent: { _unit: "pointsUnit", _value: 6 },
        startIndent: { _unit: "pointsUnit", _value: 4 },
        endIndent: { _unit: "pointsUnit", _value: 4 },
        spaceBefore: { _unit: "pointsUnit", _value: 2 },
        spaceAfter: { _unit: "pointsUnit", _value: 3 }
      }
    }]
  }
};

const impliedUiDescriptor = {
  textKey: {
    transform: { xx: 1, xy: 0, yx: 0, yy: 1.1041975 },
    textStyleRange: [{
      from: 0,
      to: 6,
      textStyle: {
        size: { _unit: "pointsUnit", _value: 72.45 },
        impliedFontSize: { _unit: "pointsUnit", _value: 80 },
        leading: { _unit: "pointsUnit", _value: 27.17 },
        impliedLeading: { _unit: "pointsUnit", _value: 30 },
        baselineShift: { _unit: "pointsUnit", _value: 2.72 },
        impliedBaselineShift: { _unit: "pointsUnit", _value: 3 }
      }
    }],
    paragraphStyleRange: [{
      from: 0,
      to: 6,
      paragraphStyle: {
        firstLineIndent: { _unit: "pointsUnit", _value: 5.43 },
        impliedFirstLineIndent: { _unit: "pointsUnit", _value: 6 },
        startIndent: { _unit: "pointsUnit", _value: 3.62 },
        impliedStartIndent: { _unit: "pointsUnit", _value: 4 },
        endIndent: { _unit: "pointsUnit", _value: 3.62 },
        impliedEndIndent: { _unit: "pointsUnit", _value: 4 },
        spaceBefore: { _unit: "pointsUnit", _value: 1.81 },
        impliedSpaceBefore: { _unit: "pointsUnit", _value: 2 },
        spaceAfter: { _unit: "pointsUnit", _value: 2.72 },
        impliedSpaceAfter: { _unit: "pointsUnit", _value: 3 }
      }
    }]
  }
};
const impliedUiRange = state.actionTextStyleRanges(impliedUiDescriptor, { resolution: 300, scaleY: 1.1041975 })[0];
const impliedUiParagraph = state.actionParagraphStyleRanges(impliedUiDescriptor, { resolution: 300, scaleX: 1.1041975, scaleY: 1.1041975 })[0];
assert.strictEqual(impliedUiRange.sizePoints, 80, "80 pt must not be reported as 88.3358 pt after transform resolution");
assert.strictEqual(impliedUiRange.leading, 30, "leading must use Photoshop's final implied point value");
assert.strictEqual(impliedUiRange.baselineShift, 3);
assert.strictEqual(impliedUiParagraph.firstLineIndent, 6);
assert.strictEqual(impliedUiParagraph.leftIndent, 4);
assert.strictEqual(impliedUiParagraph.rightIndent, 4);
assert.strictEqual(impliedUiParagraph.spaceBefore, 2);
assert.strictEqual(impliedUiParagraph.spaceAfter, 3);

const characterRanges = state.actionTextStyleRanges(descriptor);
const paragraphRanges = state.actionParagraphStyleRanges(descriptor);
assert.strictEqual(characterRanges[0].leading, 30);
assert.strictEqual(characterRanges[0].baselineShift, 3);
assert.strictEqual(paragraphRanges[0].firstLineIndent, 6);
assert.strictEqual(paragraphRanges[0].leftIndent, 4);
assert.strictEqual(paragraphRanges[0].rightIndent, 4);
assert.strictEqual(paragraphRanges[0].spaceBefore, 2);
assert.strictEqual(paragraphRanges[0].spaceAfter, 3);
assert.strictEqual(state.uniformRangeValue(paragraphRanges, "firstLineIndent"), 6);
assert.strictEqual(state.actionUnitValue(undefined), null, "missing native values must stay missing instead of becoming a false zero");
assert.ok(
  Math.abs(state.actionUnitValue(
    { _unit: "pixelsUnit", _value: 17.448 },
    null,
    { resolution: 300, scale: 0.69792 }
  ) - 6) < 0.000001,
  "pixel-unit ActionJSON readback must normalize to UI points through resolution and text transform"
);

const transformedPixelDescriptor = {
  textKey: {
    transform: { xx: 0.69792, xy: 0, yx: 0, yy: 1.25 },
    textStyleRange: [{
      from: 0,
      to: 2,
      textStyle: {
        leading: { _unit: "pixelsUnit", _value: 156.25 },
        baselineShift: { _unit: "pixelsUnit", _value: 15.625 }
      }
    }],
    paragraphStyleRange: [{
      from: 0,
      to: 2,
      paragraphStyle: {
        firstLineIndent: { _unit: "pixelsUnit", _value: 17.448 },
        startIndent: { _unit: "pixelsUnit", _value: 11.632 },
        endIndent: { _unit: "pixelsUnit", _value: 11.632 },
        spaceBefore: { _unit: "pixelsUnit", _value: 10.4166666667 },
        spaceAfter: { _unit: "pixelsUnit", _value: 15.625 }
      }
    }]
  }
};
const transformed = state.actionTextTransform(transformedPixelDescriptor);
const transformedContext = {
  resolution: 300,
  scaleX: transformed.scaleX,
  scaleY: transformed.scaleY
};
const transformedCharacter = state.actionTextStyleRanges(transformedPixelDescriptor, transformedContext)[0];
const transformedParagraph = state.actionParagraphStyleRanges(transformedPixelDescriptor, transformedContext)[0];
assert.ok(Math.abs(transformedCharacter.leading - 30) < 0.000001);
assert.ok(Math.abs(transformedCharacter.baselineShift - 3) < 0.000001);
assert.ok(Math.abs(transformedParagraph.firstLineIndent - 6) < 0.000001);
assert.ok(Math.abs(transformedParagraph.leftIndent - 4) < 0.000001);
assert.ok(Math.abs(transformedParagraph.rightIndent - 4) < 0.000001);
assert.ok(Math.abs(transformedParagraph.spaceBefore - 2) < 0.000001);
assert.ok(Math.abs(transformedParagraph.spaceAfter - 3) < 0.000001);

const inheritedDescriptor = {
  textKey: {
    paragraphStyleRange: [{
      from: 0,
      to: 2,
      paragraphStyle: {
        baseParentStyle: {
          impliedFirstLineIndent: { _unit: "pointsUnit", _value: 9 }
        }
      }
    }]
  }
};
assert.strictEqual(state.actionParagraphStyleRanges(inheritedDescriptor)[0].firstLineIndent, 9);

const mixedParagraphRanges = state.actionParagraphStyleRanges({
  textKey: {
    paragraphStyleRange: [
      {
        from: 0,
        to: 2,
        paragraphStyle: {
          firstLineIndent: { _unit: "pointsUnit", _value: 6 }
        }
      },
      {
        from: 2,
        to: 4,
        paragraphStyle: {
          firstLineIndent: { _unit: "pointsUnit", _value: 8 }
        }
      }
    ]
  }
});
assert.strictEqual(
  state.uniformRangeValue(mixedParagraphRanges, "firstLineIndent"),
  null,
  "mixed native range values must never be reported as one verified layer value"
);

console.log(`${testVersion} state unit and native descriptor tests passed at 300ppi`);

