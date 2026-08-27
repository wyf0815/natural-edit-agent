"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "uxp-v9.8");
const protocol = require(path.join(sourceRoot, "protocol.js"));
const planner = require(path.join(sourceRoot, "planner.js"));
const confidencePolicy = require(path.join(sourceRoot, "confidence-policy.js"));

function loadEngine(overrides = {}) {
  const source = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");
  const stateEngine = overrides.stateEngine || {
    compactForModel: (value) => value,
    snapshot: async () => ({})
  };
  const capabilities = overrides.capabilities || {
    catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
    get: (id) => ({ id, label: id, risk: "low", reversible: true, documentWide: true, authorizedScope: "none", preflight() {} }),
    stateLayer() { return null; },
    subtreeIds() { return []; }
  };
  const photoshop = overrides.photoshop || {
    app: { documents: [] },
    core: {},
    action: { batchPlay: async () => [] },
    constants: {}
  };
  const context = {
    console, Date, Set, Map, JSON, Math, Number, String, Object, Array, Boolean, Promise, setTimeout,
    PhotoshopAssistantV8Protocol: protocol,
    PhotoshopAssistantV9Planner: planner,
    PhotoshopAssistantV8State: stateEngine,
    PhotoshopAssistantV8Capabilities: capabilities,
    PhotoshopAssistantV97SelectionSession: overrides.selectionSessions || null,
    require(name) {
      if (name === "photoshop") return photoshop;
      if (name === "uxp" && overrides.uxp) return overrides.uxp;
      throw new Error(`unexpected require ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "v98-engine.js" });
  return context.PhotoshopAssistantV8Engine;
}

const engine = loadEngine();

function fastCase(instruction, expectedActions) {
  const intent = engine.parseFastInstruction(instruction);
  assert.ok(intent, `deterministic parser returned null: ${instruction}`);
  assert.ok(intent.operations.every((item) => item.requirementIds.length), `${instruction}: every action must retain requirementIds`);
  const requirements = planner.buildRequirements(instruction);
  const audit = engine.auditPlanningCompleteness(instruction, intent, requirements);
  assert.strictEqual(audit.complete, true, `${instruction}: ${audit.missing.join(";")}`);
  assert.strictEqual(
    intent.operations.map((item) => item.action).join(","),
    expectedActions.join(","),
    instruction
  );
  return intent.operations;
}

let operations = fastCase("图中所有#BAA5A6改成#231A36", ["selection.color_range", "adjustment.colorize"]);
assert.strictEqual(operations[0].params.color, "#BAA5A6");
assert.strictEqual(operations[0].params.tolerance, 24);
assert.strictEqual(operations[0].params.softness, 8);
assert.strictEqual(operations[1].params.color, "#231A36");
assert.strictEqual(operations[1].params.opacity, 100);
assert.strictEqual(engine.requiresVisualGrounding("图中所有#BAA5A6改成#231A36"), false);

assert.strictEqual(
  protocol.normalizeIntent({
    operations: [{
      id: "version-check",
      action: "selection.select_all",
      target: { scope: "document" },
      params: {},
      requirementIds: ["req_1"]
    }]
  }).version,
  "9.8",
  "v9.8 must not emit a stale v9.7 protocol version"
);

fastCase("选择整个画布", ["selection.select_all"]);
fastCase("扩展画布显示全部内容", ["document.reveal_all"]);
operations = fastCase("把整个文档顺时针旋转90度", ["document.rotate"]);
assert.strictEqual(operations[0].params.angle, 90);
operations = fastCase("把当前图层等比缩放放入选区，四周留20像素", ["layer.fit_to_reference"]);
assert.strictEqual(operations[0].params.reference, "selection");
assert.strictEqual(operations[0].params.padding, 20);
assert.strictEqual(operations[0].params.allowUpscale, false);
operations = fastCase("把当前文字基线偏移改为3点", ["text.set_baseline_shift"]);
assert.strictEqual(operations[0].params.baselineShift, 3);
operations = fastCase("给当前图层应用数量80%、半径1.5像素、阈值2的USM锐化", ["filter.unsharp_mask"]);
assert.strictEqual(operations[0].params.amount, 80);
assert.strictEqual(operations[0].params.radius, 1.5);
assert.strictEqual(operations[0].params.threshold, 2);
operations = fastCase("给当前图层添加数量5%的单色高斯杂色", ["filter.add_noise"]);
assert.strictEqual(operations[0].params.amount, 5);
assert.strictEqual(operations[0].params.distribution, "gaussian");
assert.strictEqual(operations[0].params.monochromatic, true);

operations = fastCase("新建一个名为标题的文字图层", ["text.create"]);
assert.strictEqual(operations[0].params.name, "标题");
assert.strictEqual(operations[0].params.content, "文字");
operations = fastCase("新建一个文字图层", ["text.create"]);
assert.strictEqual(operations[0].params.name, "新建文字");
assert.strictEqual(operations[0].params.content, "文字");
operations = fastCase("新建一个文字图层，文字是“拼合文档”", ["text.create"]);
assert.strictEqual(operations[0].params.content, "拼合文档");
operations = fastCase("新建一个名为修图层的空白像素图层", ["layer.create_pixel"]);
assert.strictEqual(operations[0].params.name, "修图层");
operations = fastCase("给当前图层加高斯模糊", ["filter.gaussian_blur"]);
assert.strictEqual(operations[0].params.radius, 2);
operations = fastCase("给当前图层添加5像素高斯模糊", ["filter.gaussian_blur"]);
assert.strictEqual(operations[0].params.radius, 5);

function normalizedOperation(action, params) {
  return protocol.normalizeIntent({
    operations: [{
      id: "operation_1",
      action,
      target: { scope: action.startsWith("selection.") || action.startsWith("adjustment.") ? "document" : "active_layer" },
      params,
      requirementIds: ["req_1"]
    }]
  }).operations[0];
}

assert.throws(() => normalizedOperation("adjustment.hue_saturation", {}), /不能同时为0/);
assert.throws(() => normalizedOperation("adjustment.colorize", { color: "#FF0000", opacity: 0 }), /不会产生可见调整/);
assert.strictEqual(normalizedOperation("selection.color_range", { color: "#112233", tolerance: 24 }).params.softness, 8);
assert.strictEqual(normalizedOperation("selection.color_range", { color: "#112233", tolerance: 24, softness: 6 }).params.softness, 6);
assert.strictEqual(protocol.parameterCategory("filter.gaussian_blur", "radius"), "effect");
assert.strictEqual(protocol.parameterCategory("selection.color_range", "softness"), "policy_default");

const subjectRegion = normalizedOperation("selection.subject_region", {
  description: "测试主体",
  unit: "percent",
  searchRegion: { left: 10, top: 10, right: 90, bottom: 90 }
});
assert.strictEqual(subjectRegion.params.confidence, 0);
assert.strictEqual(subjectRegion.params.confidenceBand, "low");
assert.strictEqual(subjectRegion.params.requiresHumanConfirmation, true);
for (const value of [0.4999, 0.5, 0.7799, 0.78]) {
  assert.strictEqual(protocol.classifyConfidence(value).level, confidencePolicy.classify(value).level);
}

const gaussianText = "给当前图层加高斯模糊";
const gaussianRequirement = planner.buildRequirements(gaussianText);
const arbitraryGaussian = protocol.normalizeIntent({
  operations: [{
    id: "blur",
    action: "filter.gaussian_blur",
    target: { scope: "active_layer" },
    params: { radius: 250 },
    requirementIds: gaussianRequirement.map((item) => item.id)
  }]
});
assert.strictEqual(
  engine.auditPlanningCompleteness(gaussianText, arbitraryGaussian, gaussianRequirement).complete,
  false,
  "effect parameters invented by a model must not be treated as equivalent to shared conservative defaults"
);

const metadataEvidence = engine.stateEvidenceRequirements({ steps: [{ action: "layer.rename", target: { id: 8 }, params: {} }] });
assert.strictEqual(metadataEvidence.needsCompositeDigest, false);
assert.strictEqual(metadataEvidence.needsSelectionDigest, false);
assert.strictEqual(metadataEvidence.needsLayerTree, true);
assert.strictEqual(metadataEvidence.needsActiveLayers, false);
const localEvidence = engine.stateEvidenceRequirements({ steps: [{ action: "adjustment.colorize", target: { kind: "document" }, params: {} }] });
assert.strictEqual(localEvidence.needsCompositeDigest, true);
assert.strictEqual(localEvidence.needsSelectionDigest, true);
const selectionEvidence = engine.stateEvidenceRequirements({ steps: [{ action: "selection.select_all", target: { kind: "document" }, params: {} }] });
assert.strictEqual(selectionEvidence.needsCompositeDigest, false);
assert.strictEqual(selectionEvidence.needsSelectionDigest, true);
const rotateEvidence = engine.stateEvidenceRequirements({ steps: [{ action: "document.rotate", target: { kind: "document" }, params: {} }] });
assert.strictEqual(rotateEvidence.needsCompositeDigest, true);

async function verifyDeterministicMismatchDoesNotCallModel() {
  const originalAudit = planner.auditRequirementCoverage;
  let modelCalls = 0;
  planner.auditRequirementCoverage = () => ({ complete: false, missing: ["forced mismatch"], unauthorizedOperations: [] });
  try {
    await assert.rejects(
      engine.understand("把当前图层不透明度改为63%", {}, async () => { modelCalls += 1; return "{}"; }),
      (error) => error && error.code === "DETERMINISTIC_AUDIT_MISMATCH"
    );
    assert.strictEqual(modelCalls, 0, "a deterministic audit bug must never silently switch to a billed model request");
  } finally {
    planner.auditRequirementCoverage = originalAudit;
  }
}

function executionState(selectionDigest, selectionBounds, contentFingerprint, fingerprint, historyStateId) {
  return {
    hasDocument: true,
    fingerprint,
    contentFingerprint,
    document: { id: 17, title: "test.psd", historyStateId, historyStateName: `history-${historyStateId}`, compositeDigest: "composite" },
    activeLayers: [],
    flatLayers: [],
    selectionDigest,
    selectionBounds,
    integrity: { consistentRead: true, compositeDigestAvailable: true, selectionDigestAvailable: true }
  };
}

async function verifyTransactionRestoresPrePlanSelection() {
  const events = [];
  const candidateBounds = { left: 40, top: 40, right: 80, bottom: 80 };
  const userBounds = { left: 5, top: 6, right: 20, bottom: 24 };
  const baseline = executionState("candidate", candidateBounds, "before-content", "before-fingerprint", 10);
  const snapshots = [
    executionState("temporary", candidateBounds, "before-content", "step-1", 10),
    executionState("temporary", candidateBounds, "after-content", "step-2", 10),
    executionState("user-selection", userBounds, "after-content", "restored", 10),
    executionState("user-selection", userBounds, "after-content", "committed", 11)
  ];
  const stateEngine = {
    compactForModel: (value) => value,
    isCompleteIntegritySnapshot: () => true,
    async snapshot() {
      assert.ok(snapshots.length, "unexpected extra state snapshot");
      return snapshots.shift();
    },
    async captureLightweightGateSnapshot() { return { complete: true }; },
    lightweightGateMatches: () => true
  };
  const capability = (id) => ({
    id, label: id, risk: "low", reversible: true, documentWide: true, authorizedScope: "none",
    preflight() {},
    async execute() { events.push(`execute:${id}`); return { documentWide: true }; },
    async verify() { return `${id}:verified`; }
  });
  const capabilities = {
    catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
    get: capability,
    stateLayer() { return null; },
    subtreeIds() { return []; }
  };
  const activeDocument = {
    id: 17,
    title: "test.psd",
    activeHistoryState: { id: 10 },
    selection: { async deselect() { events.push("deselect"); } }
  };
  const photoshop = {
    app: { documents: [activeDocument], activeDocument },
    core: {
      async executeAsModal(callback) {
        return callback({
          isCancelled: false,
          reportProgress() {},
          hostControl: {
            async suspendHistory() { events.push("suspend"); return { id: "suspension" }; },
            async resumeHistory(_suspension, commit) {
              events.push(`resume:${commit}`);
              if (commit) activeDocument.activeHistoryState = { id: 11 };
            }
          }
        });
      }
    },
    action: { batchPlay: async () => [] },
    constants: {}
  };
  const selectionSessions = {
    describe(token) { return token === "pre-plan-token" ? { token, documentID: 17, selectionBounds: userBounds } : null; },
    async restore(token) { events.push(`restore:${token}`); },
    release() { events.push("release"); }
  };
  const transactionEngine = loadEngine({ stateEngine, capabilities, photoshop, selectionSessions });
  const plan = {
    version: "9.8",
    summary: "局部换色",
    sourceDocumentId: 17,
    sourceFingerprint: "before-fingerprint",
    sourceEvidenceRequirements: { needsCompositeDigest: true, needsSelectionDigest: true, needsLayerTree: false, needsActiveLayers: false },
    restoreSelectionHadSelection: true,
    restoreSelectionSessionToken: "pre-plan-token",
    restoreSelectionDocumentId: 17,
    highRiskStepIds: [],
    steps: [
      { id: "select", action: "selection.color_range", label: "select", risk: "low", reversible: true, target: { id: null, kind: "document" }, params: { color: "#112233", tolerance: 24, softness: 8 } },
      { id: "adjust", action: "adjustment.colorize", label: "adjust", risk: "low", reversible: true, target: { id: null, kind: "document" }, params: { color: "#445566", opacity: 100, blendMode: "normal" } }
    ]
  };
  const outcome = await transactionEngine.execute(plan, { executionBaseline: baseline });
  assert.strictEqual(outcome.records.length, 2);
  assert.ok(events.indexOf("restore:pre-plan-token") > events.indexOf("execute:adjustment.colorize"));
  assert.ok(events.indexOf("restore:pre-plan-token") < events.indexOf("resume:true"), "selection must be restored inside the same history transaction before commit");
  assert.strictEqual(events.includes("release"), false, "main owns the pre-plan token lifetime");

  const missingCredentialPlan = { ...plan };
  delete missingCredentialPlan.restoreSelectionHadSelection;
  delete missingCredentialPlan.restoreSelectionSessionToken;
  delete missingCredentialPlan.restoreSelectionDocumentId;
  await assert.rejects(
    transactionEngine.execute(missingCredentialPlan, { executionBaseline: baseline }),
    (error) => error && error.code === "SELECTION_RESTORE_BASELINE_REQUIRED"
  );
}

(async () => {
  await verifyDeterministicMismatchDoesNotCallModel();
  await verifyTransactionRestoresPrePlanSelection();
  console.log("v9.8 planning, authorization, and selection-transaction regressions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
