"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "uxp-v9.8", "state-engine.js"), "utf8");
const context = {
  console, Date, Math, Number, String, Object, Array, Boolean, JSON,
  require(name) {
    if (name === "photoshop") return { app: {}, action: {}, constants: {} };
    throw new Error(`unexpected require: ${name}`);
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "state-engine.js" });
const state = context.PhotoshopAssistantV8State;

const base = {
  hasDocument: true,
  fingerprint: "full-fingerprint",
  contentFingerprint: "content-fingerprint",
  document: {
    id: 7,
    width: 100,
    height: 80,
    resolution: 300,
    historyStateId: 12,
    compositeDigest: null
  },
  activeLayers: [{ id: 3 }],
  flatLayers: [],
  selectionBounds: { left: 10, top: 20, right: 14, bottom: 23 },
  selectionDigest: null,
  integrity: {
    consistentRead: true,
    compositeDigestAvailable: false,
    selectionDigestAvailable: false
  }
};

const metadataRequirements = {
  needsCompositeDigest: false,
  needsSelectionDigest: false,
  needsActiveLayers: false,
  needsLayerTree: true
};
assert.strictEqual(
  state.isCompleteIntegritySnapshot(base, metadataRequirements),
  true,
  "metadata plans must not fail solely because Photoshop imaging digests are unavailable"
);
assert.strictEqual(
  state.isCompleteIntegritySnapshot(base, { ...metadataRequirements, needsCompositeDigest: true }),
  false,
  "pixel plans still require a live composite digest"
);
assert.strictEqual(
  state.isCompleteIntegritySnapshot(base, { ...metadataRequirements, needsSelectionDigest: true }),
  false,
  "selection-dependent plans still require a live selection digest"
);
assert.strictEqual(
  state.isCompleteIntegritySnapshot({ ...base, integrity: { ...base.integrity, consistentRead: false } }, metadataRequirements),
  false,
  "every tier must reject a torn Photoshop state read"
);

const metadataFingerprint = state.buildEvidenceFingerprint(base, metadataRequirements);
const unrelatedSelectionChanged = {
  ...base,
  selectionBounds: { left: 40, top: 30, right: 60, bottom: 50 },
  selectionDigest: "other-selection"
};
assert.strictEqual(
  state.buildEvidenceFingerprint(unrelatedSelectionChanged, metadataRequirements),
  metadataFingerprint,
  "an unrelated selection change must not invalidate a plan that never reads the selection"
);
assert.notStrictEqual(
  state.buildEvidenceFingerprint(unrelatedSelectionChanged, { ...metadataRequirements, needsSelectionDigest: true }),
  state.buildEvidenceFingerprint({ ...base, selectionDigest: "original-selection" }, { ...metadataRequirements, needsSelectionDigest: true }),
  "selection-dependent evidence must continue to detect selection changes"
);

const fullGateState = {
  ...base,
  document: { ...base.document, historyStateName: "Before write" },
  activeLayers: [{ id: 3 }],
  selectionBounds: { left: 1, top: 2, right: 3, bottom: 4 },
  flatLayers: []
};
const lightweightChangedUi = {
  hasDocument: true,
  complete: true,
  document: { ...fullGateState.document },
  activeLayers: [{ id: 99 }],
  selectionBounds: { left: 40, top: 30, right: 60, bottom: 50 },
  flatLayers: []
};
assert.strictEqual(
  state.lightweightGateMatches(fullGateState, lightweightChangedUi, metadataRequirements),
  true,
  "the modal gate must ignore active-layer and selection UI state when a compiled plan reads neither"
);
assert.strictEqual(
  state.lightweightGateMatches(
    { ...fullGateState, document: { ...fullGateState.document, historyStateName: "" } },
    { ...lightweightChangedUi, document: { ...lightweightChangedUi.document, historyStateName: "" } },
    metadataRequirements
  ),
  true,
  "a valid history state ID must not be rejected only because Photoshop returned an empty display name"
);
assert.strictEqual(
  state.lightweightGateMatches(fullGateState, lightweightChangedUi, { ...metadataRequirements, needsSelectionDigest: true }),
  false,
  "a selection consumer must still stop when the live selection bounds changed"
);
assert.strictEqual(
  state.lightweightGateMatches(fullGateState, lightweightChangedUi, { ...metadataRequirements, needsActiveLayers: true }),
  false,
  "an active-layer consumer must still stop when Photoshop focus changed"
);

console.log("v9.8 dependency-tiered Photoshop state evidence tests passed");
