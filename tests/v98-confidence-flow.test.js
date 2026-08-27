"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "uxp-v9.8", "main.js"), "utf8");
const confidencePolicy = require(path.join(root, "uxp-v9.8", "confidence-policy.js"));
const start = source.indexOf("function applyAutomaticSelectionConfirmationPolicy");
const end = source.indexOf("\nasync function captureAuthoritativeSelection", start);
assert(start >= 0 && end > start);

const steps = [
  { index: 0, step: { action: "selection.visual_object", params: { confidence: 0.92, selectionSessionToken: "high" } } },
  { index: 1, step: { action: "selection.visual_object", params: { confidence: 0.20, selectionSessionToken: "low" } } },
  { index: 2, step: { action: "selection.visual_object", params: { confidence: 0.94, selectionSessionToken: "warning" } } }
];
const sessions = {
  high: { token: "high", corrected: false, lowConfidenceAccepted: false },
  low: { token: "low", corrected: false, lowConfidenceAccepted: false },
  warning: { token: "warning", corrected: false, lowConfidenceAccepted: false }
};
const runtime = {
  selectionConfidenceByStep: new Map([
    [0, confidencePolicy.classify(0.92)],
    [1, confidencePolicy.classify(0.20)],
    [2, confidencePolicy.classify(0.94)]
  ]),
  visualConfirmedSteps: new Set(),
  visualEvidence: [
    { stepIndex: 0, requiresHumanConfirmation: false, qualityWarnings: [] },
    { stepIndex: 1, requiresHumanConfirmation: true, qualityWarnings: [] },
    { stepIndex: 2, requiresHumanConfirmation: true, qualityWarnings: ["完整对象覆盖不足"] }
  ]
};
const context = {
  confidencePolicy,
  runtime,
  selectionPlanSteps() { return steps; },
  selectionSessions: { describe(token) { return sessions[token] || null; } },
  result: null
};
vm.runInNewContext(`${source.slice(start, end)}\nresult = applyAutomaticSelectionConfirmationPolicy;`, context, { filename: "main-confidence-flow.js" });
context.result();

assert(runtime.visualConfirmedSteps.has(0), "a high-confidence executable candidate should be auto-locked");
assert(!runtime.visualConfirmedSteps.has(1), "a low-confidence candidate must wait for lasso/point/native correction or explicit acceptance");
assert(!runtime.visualConfirmedSteps.has(2), "quality warnings must override a numerically high confidence score");
assert.strictEqual(runtime.visualEvidence[0].requiresHumanConfirmation, false);
assert.strictEqual(runtime.visualEvidence[1].requiresHumanConfirmation, true);
assert.strictEqual(runtime.visualEvidence[2].requiresHumanConfirmation, true);
assert(!source.includes("params.confidence == null ? 0.70"), "missing model confidence must not be upgraded to medium");
assert(!source.includes("params.confidence == null ? 0.55"), "legacy subject-region confidence must fail low, not optimistic medium");
assert(source.includes("applyAutomaticSelectionConfirmationPolicy();"));
assert(source.includes('corrected: options.corrected === true'));
assert(source.includes('correctionSource: `point-${runtime.visualCandidateMode}`'));

console.log("v9.8 high-confidence auto-lock and low-confidence correction flow tests passed");
