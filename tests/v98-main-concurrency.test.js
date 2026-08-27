"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "uxp-v9.8", "main.js"), "utf8");

assert(
  source.includes('"executePlan", "cancelPlan", "refreshState"'),
  "busy mode must disable plan cancellation while execution owns the transaction"
);
assert(
  /async function cancelPlan\(\) \{\s+if \(runtime\.busy\)/.test(source),
  "cancelPlan must reject programmatic/event races while the runtime is busy"
);
assert(
  source.includes("const executionPlan = cloneValue(runtime.plan);"),
  "execution must freeze the approved plan before awaiting the Photoshop baseline"
);
assert(source.includes("executionPlan.restoreSelectionHadSelection = runtime.prePlanSelection.hadSelection === true"));
assert(source.includes("executionPlan.restoreSelectionSessionToken = runtime.prePlanSelection.token || null"));
assert(source.includes("executionPlan.restoreSelectionDocumentId = Number(runtime.prePlanSelection.documentID)"));
assert(source.includes("engine.assertSafeSelectionRestoreBaseline(executionPlan, executionBaseline)"));
assert(source.includes("engine.execute(executionPlan, { executionBaseline })"));
assert(source.includes("engine.stateEvidenceRequirements(plan)"), "strict state reads must follow compiled plan dependencies");
assert(source.includes("stateEngine.buildEvidenceFingerprint(current, requirements)"), "stability must ignore state the plan does not read");
assert(source.includes('readStableStrictSnapshot("pre_execute_baseline", executionPlan)'), "the frozen approved plan must determine its evidence tier");
assert(source.includes("runtime.plan.sourceEvidenceFingerprint = stateEngine.buildEvidenceFingerprint"), "the post-analysis baseline must be rebound with the same dependency-tiered evidence contract");
assert(source.includes('const transport = "proxy";'), "managed v9.8 model calls must use the authenticated local bridge");
assert(!source.includes('const transport = runtime.proxyConfigured ? "proxy" : "direct"'), "bridge failure must not silently bypass endpoint policy and duplicate a paid request");

console.log("v9.8 plan execution/cancellation race regression checks passed");
