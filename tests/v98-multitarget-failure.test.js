"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "uxp-v9.8", "main.js"), "utf8");
const start = source.indexOf("function planStepIndexesForRequirementGroupRemoval");
const end = source.indexOf("\nfunction remapIndexedRuntimeMap", start);
assert(start >= 0 && end > start, "multi-target removal helper is missing");
const context = { result: null, Set, Array };
vm.runInNewContext(`${source.slice(start, end)}\nresult = planStepIndexesForRequirementGroupRemoval;`, context);

const steps = [
  { id: "trophy-select", operationId: "trophy-select", requirementIds: ["req_trophy"], action: "selection.visual_object", target: {} },
  { id: "trophy-edit", operationId: "trophy-edit", requirementIds: ["req_trophy"], action: "adjustment.hue_saturation", target: {} },
  { id: "hat-select", operationId: "hat-select", requirementIds: ["req_hat"], action: "selection.visual_object", target: {} },
  { id: "hat-edit", operationId: "hat-edit", requirementIds: ["req_hat"], action: "adjustment.colorize", target: {} },
  { id: "umbrella-select", operationId: "umbrella-select", requirementIds: ["req_umbrella"], action: "selection.visual_object", target: {} },
  { id: "umbrella-edit", operationId: "umbrella-edit", requirementIds: ["req_umbrella"], action: "adjustment.colorize", target: {} },
  { id: "umbrella-dependent", operationId: "umbrella-dependent", requirementIds: ["req_followup"], action: "layer.rename", target: { resultOf: "umbrella-edit" } }
];
assert.deepStrictEqual(Array.from(context.result(steps, 4)), [4, 5, 6]);
assert.deepStrictEqual(Array.from(context.result(steps, 0)), [0, 1]);
assert.deepStrictEqual(Array.from(context.result(steps, 99)), []);
const overLinked = steps.map((step) => ({ ...step, requirementIds: ["req_all"] }));
assert.deepStrictEqual(Array.from(context.result(overLinked, 4)), [4, 5, 6], "over-linked model requirement ids must fall back to the failed contiguous target block");
assert(source.includes("没有重新调用定位或分割"));
assert(source.includes('bindEvent("removeFailedTarget"'));

console.log("v9.8 failed-target removal preserves successful multi-target candidates");
