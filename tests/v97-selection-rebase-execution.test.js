"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const sourceRoot = path.resolve(__dirname, `../uxp-${testVersion}`);
const protocol = require(path.join(sourceRoot, "protocol.js"));
const planner = require(path.join(sourceRoot, "planner.js"));

function loadEngine(snapshots) {
  const source = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");
  const queue = snapshots.slice();
  const context = {
    console,
    Date,
    Set,
    Map,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    PhotoshopAssistantV8Protocol: protocol,
    PhotoshopAssistantV9Planner: planner,
    PhotoshopAssistantV8State: {
      compactForModel: (value) => value,
      snapshot: async () => {
        if (!queue.length) throw new Error("unexpected snapshot read");
        return queue.shift();
      }
    },
    PhotoshopAssistantV8Capabilities: {
      catalog: () => [],
      get() { throw new Error("empty test plan must not resolve a capability"); },
      stateLayer() { return null; },
      subtreeIds() { return []; }
    },
    require(name) {
      if (name === "photoshop") {
        return {
          app: { documents: [] },
          core: {},
          action: { batchPlay: async () => [] },
          constants: {}
        };
      }
      throw new Error(`Unexpected require: ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "engine.js" });
  return context.PhotoshopAssistantV8Engine;
}

const bounds = Object.freeze({ left: 120, top: 180, right: 640, bottom: 920 });

function state(overrides = {}) {
  const base = {
    hasDocument: true,
    fingerprint: "history-2",
    contentFingerprint: "content-stable",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      resolution: 300,
      historyStateId: 202,
      historyStateName: "Restore confirmed selection",
      compositeDigest: "composite-stable"
    },
    selectionBounds: { ...bounds },
    selectionDigest: "selection-stable",
    activeLayers: [{ id: 42, name: "Artwork" }],
    flatLayers: [],
    integrity: {
      compositeDigestAvailable: true,
      selectionDigestAvailable: true,
      safetyStateComplete: true
    },
  };
  return {
    ...base,
    ...overrides,
    document: { ...base.document, ...(overrides.document || {}) },
    integrity: { ...base.integrity, ...(overrides.integrity || {}) }
  };
}

function withoutDigestEvidence(value, suffix = "temporary") {
  const missing = JSON.parse(JSON.stringify(value));
  missing.fingerprint = `incomplete-${suffix}`;
  missing.contentFingerprint = `content-incomplete-${suffix}`;
  missing.selectionDigest = null;
  missing.document.compositeDigest = null;
  missing.integrity = {
    ...(missing.integrity || {}),
    compositeDigestAvailable: false,
    selectionDigestAvailable: false
  };
  return missing;
}

function loadProductionLightweightMatcher() {
  const source = fs.readFileSync(path.join(sourceRoot, "state-engine.js"), "utf8");
  const context = {
    console, Date, Set, Map, JSON, Math, Number, String, Object, Array,
    require(name) {
      if (name === "photoshop") return {
        app: { documents: [] },
        action: { batchPlay: async () => [] },
        constants: {},
        imaging: {}
      };
      throw new Error(`Unexpected require: ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "state-engine-lightweight-matcher.js" });
  return context.PhotoshopAssistantV8State;
}

const productionLightweightState = loadProductionLightweightMatcher();

function lightweightGate(value) {
  const gate = {
    hasDocument: true,
    complete: true,
    document: {
      id: value.document.id,
      width: value.document.width,
      height: value.document.height,
      resolution: value.document.resolution,
      historyStateId: value.document.historyStateId,
      historyStateName: value.document.historyStateName
    },
    activeLayers: value.activeLayers.map((layer) => ({ id: layer.id })),
    selectionBounds: value.selectionBounds ? { ...value.selectionBounds } : null,
    flatLayers: JSON.parse(JSON.stringify(value.flatLayers || []))
  };
  gate.fingerprint = productionLightweightState.buildLightweightGateFingerprint(gate);
  return gate;
}

function plan(overrides = {}) {
  return {
    version: testVersion.replace(/^v/, ""),
    route: "standard",
    summary: "strict confirmed selection baseline",
    constraints: [],
    sourceDocumentId: 7,
    sourceFingerprint: "history-2",
    sourceContentFingerprint: "content-stable",
    sourceActiveLayerIds: [42],
    sourceHistoryStateId: 202,
    sourceHistoryStateName: "Restore confirmed selection",
    sourceCompositeDigest: "composite-stable",
    sourceIntegrity: {
      compositeDigestAvailable: true,
      selectionDigestAvailable: true,
      safetyStateComplete: true
    },
    // This suite exercises the strict confirmed-selection path explicitly.
    // v9.8 derives these dependencies from executable steps, while the
    // synthetic plan below is intentionally step-free in several cases.
    sourceEvidenceRequirements: {
      needsCompositeDigest: true,
      needsSelectionDigest: true,
      needsLayerTree: true,
      needsActiveLayers: true
    },
    selectionAuthority: {
      kind: "photoshop_current_selection",
      selectionDigest: "selection-stable",
      bounds: { ...bounds },
      sessionId: "selection-1"
    },
    highRiskStepIds: [],
    confirmedHighRiskStepIds: [],
    steps: [],
    ...overrides
  };
}

function loadStableSnapshotReader(mainSource, snapshots) {
  const start = mainSource.indexOf("const STRICT_SNAPSHOT_STABILITY_ATTEMPTS");
  const end = mainSource.indexOf("async function snapshotAndRebaseSelection", start);
  assert(start >= 0 && end > start, "strict snapshot stabilization implementation must exist");
  const queue = snapshots.slice();
  const context = {
    Promise,
    Error,
    runtime: { plan: plan() },
    engine: {
      stateEvidenceRequirements() {
        return {
          needsCompositeDigest: true,
          needsSelectionDigest: true,
          needsLayerTree: true,
          needsActiveLayers: true
        };
      }
    },
    setTimeout(callback) { callback(); },
    core: { executeAsModal: async (callback) => callback() },
    stateEngine: {
      isCompleteIntegritySnapshot: (value) => Boolean(
        value && value.hasDocument && value.fingerprint && value.contentFingerprint
        && value.document && Number(value.document.historyStateId) > 0
        && value.document.compositeDigest && Array.isArray(value.activeLayers)
        && value.integrity && value.integrity.consistentRead !== false
        && value.integrity.compositeDigestAvailable === true
        && value.integrity.selectionDigestAvailable === true
        && (value.selectionBounds
          ? value.selectionDigest != null && value.selectionDigest !== "none"
          : value.selectionDigest === "none")
      ),
      snapshot: async () => {
        if (!queue.length) throw new Error("unexpected stability snapshot read");
        return queue.shift();
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.readForTest = readStableStrictSnapshot;`, context);
  return context.readForTest;
}

function executablePlan(overrides = {}) {
  return plan({
    restoreSelectionHadSelection: false,
    restoreSelectionSessionToken: null,
    restoreSelectionDocumentId: 7,
    steps: [
      {
        id: "selection-step",
        operationId: "selection-op",
        action: "selection.visual_object",
        label: "restore locked object selection",
        risk: "medium",
        reversible: true,
        target: { kind: "document", id: 7, name: "fixture.psd", path: "fixture.psd" },
        params: { selectionSessionToken: "selection-1", description: "右下角奖杯" }
      },
      {
        id: "adjustment-step",
        operationId: "adjustment-op",
        action: "adjustment.hue_saturation",
        label: "desaturate locked object",
        risk: "low",
        reversible: true,
        target: { kind: "document", id: 7, name: "fixture.psd", path: "fixture.psd" },
        params: { hue: 0, saturation: -100, lightness: 0 }
      }
    ],
    ...overrides
  });
}

function loadExecutableEngine(snapshots, calls, options = {}) {
  const source = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");
  const snapshotProvider = typeof snapshots === "function" ? snapshots : null;
  const queue = snapshotProvider ? [] : snapshots.slice();
  let last = snapshotProvider ? null : queue[queue.length - 1];
  const definition = (id) => ({
    id,
    label: id,
    risk: "low",
    reversible: true,
    documentWide: true,
    authorizedScope: "none",
    preflight() {},
    async execute(payload) {
      if (id === "selection.visual_object") {
        calls.selectionExecute += 1;
        calls.selectionTokens.push(payload.params.selectionSessionToken);
      }
      else calls.adjustmentExecute += 1;
      return id === "selection.visual_object"
        ? { selectedPixels: 100, authoritativeSelection: true, documentWide: false }
        : { documentWide: true };
    },
    async verify() { return `${id}:verified`; }
  });
  const document = { id: 7, title: "fixture.psd", activeHistoryState: { id: 300 } };
  const stateShim = {
    compactForModel: (value) => value,
    async snapshot() {
      calls.engineSnapshots += 1;
      if (snapshotProvider) return JSON.parse(JSON.stringify(snapshotProvider(calls)));
      if (queue.length) last = queue.shift();
      return JSON.parse(JSON.stringify(last));
    }
  };
  if (options.lightweightGateProvider) {
    stateShim.captureLightweightGateSnapshot = async () => {
      calls.lightweightGateSnapshots += 1;
      return JSON.parse(JSON.stringify(options.lightweightGateProvider(calls)));
    };
    stateShim.lightweightGateMatches = productionLightweightState.lightweightGateMatches;
  }
  const context = {
    console, Date, Set, Map, JSON, Math, Number, String, Object, Array,
    PhotoshopAssistantV8Protocol: protocol,
    PhotoshopAssistantV9Planner: planner,
    PhotoshopAssistantV8State: stateShim,
    PhotoshopAssistantV8Capabilities: {
      catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
      get: (id) => definition(id),
      stateLayer() { return null; },
      subtreeIds() { return []; }
    },
    require(name) {
      if (name === "photoshop") return {
        app: { documents: [document], activeDocument: document },
        core: {
          async executeAsModal(callback) {
            calls.engineModal += 1;
            return callback({
              isCancelled: false,
              reportProgress() {},
              hostControl: {
                async suspendHistory() { return { id: "suspend-1" }; },
                async resumeHistory() {}
              }
            });
          }
        },
        action: { batchPlay: async () => [] },
        constants: {}
      };
      if (name === "uxp") throw new Error("export picker must not run in this flow");
      throw new Error(`Unexpected require: ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "engine-executable-selection-flow.js" });
  return context.PhotoshopAssistantV8Engine;
}

function loadExecutePlanFlow(mainSource, options) {
  const strictStart = mainSource.indexOf("const STRICT_SNAPSHOT_STABILITY_ATTEMPTS");
  const strictEnd = mainSource.indexOf("async function probeNonVisualSelectionCandidates", strictStart);
  const executeStart = mainSource.indexOf("async function executePlan()");
  const executeEnd = mainSource.indexOf("async function undoLast()", executeStart);
  assert(strictStart >= 0 && strictEnd > strictStart && executeStart >= 0 && executeEnd > executeStart,
    "execute-time selection relock flow must remain behavior-testable");
  const queue = options.uiSnapshots.slice();
  const calls = options.calls;
  const runtime = {
    plan: options.initialPlan,
    busy: false,
    snapshot: options.initialSnapshot,
    palette: [],
    visualConfirmedSteps: new Set(options.initialPlan.steps
      .map((step, index) => step.action.startsWith("selection.") ? index : null)
      .filter((index) => index != null)),
    prePlanSelection: options.prePlanSelection || {
      hadSelection: false,
      token: null,
      documentID: 7
    },
    undoPoint: null,
    documentSignature: "before-execute"
  };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id,
      disabled: false,
      classList: { add() {}, remove() {}, toggle() {} }
    });
    return elements.get(id);
  };
  const wrappedEngine = {
    rebasePlanAfterSelection: options.engine.rebasePlanAfterSelection,
    assertSafeSelectionRestoreBaseline: options.engine.assertSafeSelectionRestoreBaseline,
    async execute(value, executeOptions) {
      calls.enginePlan = JSON.parse(JSON.stringify(value));
      calls.engineOptions = JSON.parse(JSON.stringify(executeOptions || null));
      return options.engine.execute(value, executeOptions);
    }
  };
  const context = {
    console, Promise, Error, Set, Map, JSON, Math, Number, String, Object, Array,
    cloneValue(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); },
    setTimeout(callback) { callback(); },
    runtime,
    engine: wrappedEngine,
    core: { executeAsModal: async (callback) => callback() },
    stateEngine: {
      isCompleteIntegritySnapshot: (value) => Boolean(
        value && value.hasDocument && value.fingerprint && value.contentFingerprint
        && value.document && Number(value.document.historyStateId) > 0
        && value.document.compositeDigest && Array.isArray(value.activeLayers)
        && value.integrity && value.integrity.consistentRead !== false
        && value.integrity.compositeDigestAvailable === true
        && value.integrity.selectionDigestAvailable === true
        && (value.selectionBounds
          ? value.selectionDigest != null && value.selectionDigest !== "none"
          : value.selectionDigest === "none")
      ),
      async snapshot() {
        calls.uiSnapshots += 1;
        if (!queue.length) throw new Error("unexpected execute-time stability snapshot read");
        return JSON.parse(JSON.stringify(queue.shift()));
      }
    },
    selectionSessions: {
      async restore(token) {
        calls.restores.push(token);
        return { token, selectionDigest: "selection-stable" };
      },
      describe(token) { return { token, selectionDigest: "selection-stable" }; },
      release() {}
    },
    selectionPlanSteps() {
      return runtime.plan.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.action.startsWith("selection."));
    },
    selectionPlanStep() { return this.selectionPlanSteps()[0] || null; },
    planNeedsVisualConfirmation() { return false; },
    documentSignature() { return "execute-stable-signature"; },
    setBusy(value) { runtime.busy = value; calls.busy.push(value); },
    showResult(message, type) { calls.results.push({ message, type }); },
    showDetails(value) { calls.details.push(value); },
    appendLog() {},
    protectedEvidenceSummary() { return "protected"; },
    executionFailurePresentation(error) {
      calls.failure = error;
      return { message: String(error.message || error), stage: "preflight", preserveUndoPoint: false };
    },
    refreshState: async () => { calls.refreshAfterFailure += 1; },
    releaseVisualPlanMasks() {},
    markInsightsStale() {},
    renderSnapshot() {},
    $: element
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${mainSource.slice(strictStart, strictEnd)}\n${mainSource.slice(executeStart, executeEnd)}\nglobalThis.runForTest = executePlan;`,
    context,
    { filename: "main-execute-selection-flow.js" }
  );
  return { run: context.runForTest, runtime, calls };
}

async function assertPlannedPollingDoesNotOverwrite(mainSource) {
  const start = mainSource.indexOf("async function refreshWhenDocumentChanges()");
  const end = mainSource.indexOf("function renderPlan", start);
  const plannedSnapshot = { marker: "confirmed-plan-snapshot" };
  const runtime = {
    busy: false,
    refreshingState: false,
    plan: { id: "confirmed-plan" },
    snapshot: plannedSnapshot,
    documentSignature: "old-signature"
  };
  let refreshes = 0;
  const context = {
    runtime,
    documentSignature: () => "new-signature",
    async refreshState() {
      refreshes += 1;
      runtime.snapshot = { marker: "poll-overwrite" };
    }
  };
  vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.pollForTest = refreshWhenDocumentChanges;`, context);
  await context.pollForTest();
  assert.strictEqual(refreshes, 0, "polling must not refresh while a confirmed plan exists");
  assert.strictEqual(runtime.snapshot, plannedSnapshot, "polling must preserve the confirmed runtime snapshot by identity");
}

(async () => {
  const strictState = state();
  const strictEngine = loadEngine([strictState, strictState]);
  const outcome = await strictEngine.execute(plan());
  assert.strictEqual(outcome.finalState.fingerprint, "history-2");

  const incompleteSelectionState = state({
    fingerprint: "transient-incomplete",
    selectionDigest: null,
    integrity: {
      compositeDigestAvailable: true,
      selectionDigestAvailable: false,
      safetyStateComplete: true
    }
  });
  const recoveredGateEngine = loadEngine([incompleteSelectionState, strictState, strictState]);
  assert.strictEqual((await recoveredGateEngine.execute(plan())).finalState.fingerprint, "history-2",
    "a transient missing selection digest must be retried before strict comparison");
  const incompleteGateEngine = loadEngine([
    incompleteSelectionState,
    incompleteSelectionState,
    incompleteSelectionState,
    incompleteSelectionState
  ]);
  await assert.rejects(
    () => incompleteGateEngine.execute(plan()),
    (error) => Boolean(error && error.code === "INCOMPLETE_STATE_EVIDENCE"),
    "continuous missing integrity evidence must fail closed before execution"
  );

  const historyDriftEngine = loadEngine([state({
    fingerprint: "history-3",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 203,
      historyStateName: "Unexpected history drift"
    }
  })]);
  let mismatch = null;
  try {
    await historyDriftEngine.execute(plan());
  } catch (error) {
    mismatch = error;
  }
  assert(mismatch, "execution must not accept history-only drift from a weak content digest");
  assert.strictEqual(mismatch.code, "EXECUTION_BASELINE_MISMATCH");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mismatch.baselineDiagnostics)), {
    expected: {
      fingerprint: "history-2",
      contentFingerprint: "content-stable",
      historyStateId: 202,
      historyStateName: "Restore confirmed selection",
      compositeDigest: "composite-stable",
      integrity: {
        compositeDigestAvailable: true,
        selectionDigestAvailable: true,
        safetyStateComplete: true
      },
      selectionDigest: "selection-stable",
      selectionBounds: { ...bounds },
      activeLayerIds: [42]
    },
    current: {
      fingerprint: "history-3",
      contentFingerprint: "content-stable",
      historyStateId: 203,
      historyStateName: "Unexpected history drift",
      compositeDigest: "composite-stable",
      integrity: {
        compositeDigestAvailable: true,
        selectionDigestAvailable: true,
        safetyStateComplete: true
      },
      selectionDigest: "selection-stable",
      selectionBounds: { ...bounds },
      activeLayerIds: [42]
    }
  });

  const baselineReuseEngine = loadEngine([]);
  await baselineReuseEngine.execute(plan(), { executionBaseline: state() });

  const rebaseEngine = loadEngine([]);
  const before = state({ fingerprint: "history-1", selectionDigest: "selection-before" });
  const after = state({ fingerprint: "history-2" });
  const rebased = rebaseEngine.rebasePlanAfterSelection(
    plan({ sourceFingerprint: "history-1" }),
    before,
    after,
    { sessionId: "selection-1", selectionDigest: "selection-stable" }
  );
  assert.strictEqual(rebased.sourceFingerprint, "history-2");
  assert.strictEqual(rebased.sourceContentFingerprint, "content-stable");
  assert.deepStrictEqual(Array.from(rebased.sourceActiveLayerIds), [42]);
  assert.strictEqual(rebased.sourceHistoryStateId, 202);
  assert.strictEqual(rebased.sourceHistoryStateName, "Restore confirmed selection");

  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan(), state({ contentFingerprint: null }), after, {}));
  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan(), before, state({ contentFingerprint: null }), {}));
  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan(), before, state({ contentFingerprint: "changed" }), {}));
  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan(), before, state({ activeLayers: [{ id: 99 }] }), {}));
  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan({ sourceContentFingerprint: "old-content" }), before, after, {}));
  assert.throws(() => rebaseEngine.rebasePlanAfterSelection(plan({ sourceActiveLayerIds: [99] }), before, after, {}));

  assert.strictEqual(rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state()), true);
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({
    fingerprint: "history-delayed",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 203,
      historyStateName: "Restore confirmed selection"
    }
  })), (error) => Boolean(error && error.code === "EXECUTION_BASELINE_MISMATCH"),
  "same-named history drift must not bypass the exact execution baseline");
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({
    fingerprint: "hidden-edit",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 203,
      historyStateName: "Brush Tool"
    }
  })), (error) => Boolean(error && error.code === "EXECUTION_BASELINE_MISMATCH" && error.baselineDiagnostics));
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({ fingerprint: "content-edit", contentFingerprint: "changed" })));
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({ fingerprint: "selection-edit", selectionDigest: "changed" })));
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({
    fingerprint: "bounds-edit",
    selectionBounds: { ...bounds, right: bounds.right + 1 }
  })));
  assert.throws(() => rebaseEngine.assertSafeSelectionRestoreBaseline(plan(), state({
    fingerprint: "active-edit",
    activeLayers: [{ id: 99 }]
  })));

  const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
  const flowCalls = () => ({
    restores: [],
    uiSnapshots: 0,
    engineSnapshots: 0,
    engineModal: 0,
    lightweightGateSnapshots: 0,
    selectionExecute: 0,
    selectionTokens: [],
    adjustmentExecute: 0,
    enginePlan: null,
    engineExecutionBaseline: null,
    busy: [],
    results: [],
    details: [],
    failure: null,
    refreshAfterFailure: 0
  });
  const initialConfirmedState = state({
    fingerprint: "history-confirmed",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 210,
      historyStateName: "Confirmed selection"
    }
  });
  const restoredTransition = state({
    fingerprint: "history-restore-transition",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 211,
      historyStateName: "Restore transition"
    }
  });
  const delayedHistory = state({
    fingerprint: "history-delayed-confirmation",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 211,
      historyStateName: "Confirmed selection"
    }
  });
  const restoredStable = state({
    fingerprint: "history-restore-stable",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 212,
      historyStateName: "Restore confirmed selection"
    }
  });
  const executedState = state({
    fingerprint: "history-adjusted",
    contentFingerprint: "content-adjusted",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 213,
      historyStateName: "Hue/Saturation"
    }
  });
  const happyInitialPlan = executablePlan({
    sourceFingerprint: initialConfirmedState.fingerprint,
    sourceHistoryStateId: 210,
    sourceHistoryStateName: "Confirmed selection"
  });
  happyInitialPlan.steps.splice(1, 0, {
    ...happyInitialPlan.steps[0],
    id: "non-authority-selection-step",
    operationId: "non-authority-selection-op",
    label: "other confirmed selection session",
    params: {
      ...happyInitialPlan.steps[0].params,
      selectionSessionToken: "selection-2",
      description: "另一个已确认目标"
    }
  });
  happyInitialPlan.steps = happyInitialPlan.steps.filter((step) => step.id !== "non-authority-selection-step");
  const happyCalls = flowCalls();
  const happyEngine = loadExecutableEngine((calls) => {
    if (calls.selectionExecute === 0) {
      throw new Error("trusted no-resource execution must not request a full imaging snapshot before the first edit");
    }
    return calls.adjustmentExecute > 0 ? executedState : initialConfirmedState;
  }, happyCalls, {
    lightweightGateProvider: () => lightweightGate(initialConfirmedState)
  });
  const happyFlow = loadExecutePlanFlow(main, {
    engine: happyEngine,
    calls: happyCalls,
    initialPlan: happyInitialPlan,
    initialSnapshot: initialConfirmedState,
    uiSnapshots: [
      withoutDigestEvidence(initialConfirmedState, "pre-execute-transient"),
      initialConfirmedState,
      initialConfirmedState
    ]
  });
  await happyFlow.run();
  assert.deepStrictEqual(happyCalls.restores, [],
    "executePlan must not restore or rebase a selection immediately before entering the engine");
  assert.strictEqual(happyCalls.enginePlan.sourceFingerprint, initialConfirmedState.fingerprint,
    "executePlan must preserve the already-confirmed immutable plan fingerprint");
  assert.strictEqual(happyCalls.engineOptions.executionBaseline.fingerprint, initialConfirmedState.fingerprint,
    "the strict stable UI-modal baseline must be reused by the engine's first gate");
  assert.strictEqual(happyCalls.enginePlan.selectionAuthority.selectionDigest, "selection-stable");
  assert.strictEqual(happyCalls.lightweightGateSnapshots, 1,
    "the modal write lock must use one structural gate without requesting imaging digests");
  assert.strictEqual(happyCalls.selectionExecute, 1,
    "the locked selection capability must execute exactly once");
  assert.deepStrictEqual(happyCalls.selectionTokens, ["selection-1"],
    "the selection capability must restore only its confirmed session token");
  assert.strictEqual(happyCalls.adjustmentExecute, 1,
    "the real engine flow must reach the requested local adjustment");
  assert.deepStrictEqual(happyCalls.busy, [true, false],
    "the stable baseline lock and execution sequence must stay under the UI busy gate");

  const missingCalls = flowCalls();
  const missingFlow = loadExecutePlanFlow(main, {
    engine: loadExecutableEngine([restoredStable], missingCalls),
    calls: missingCalls,
    initialPlan: executablePlan({
      sourceFingerprint: initialConfirmedState.fingerprint,
      sourceHistoryStateId: 210,
      sourceHistoryStateName: "Confirmed selection"
    }),
    initialSnapshot: initialConfirmedState,
    uiSnapshots: Array.from({ length: 5 }, (_, index) => (
      withoutDigestEvidence(delayedHistory, `continuous-pre-restore-${index}`)
    ))
  });
  await missingFlow.run();
  assert.deepStrictEqual(missingCalls.restores, [],
    "continuous missing pre-restore evidence must fail before overwriting the live selection");
  assert.strictEqual(missingCalls.enginePlan, null,
    "continuous missing pre-restore evidence must not enter the strict engine");
  assert.strictEqual(missingCalls.selectionExecute, 0);
  assert.strictEqual(missingCalls.adjustmentExecute, 0,
    "continuous missing pre-restore evidence must never reach the requested adjustment");
  assert(missingCalls.failure, "continuous missing evidence must remain a visible fail-closed result");

  const strictExecutablePlan = executablePlan({
    sourceFingerprint: restoredStable.fingerprint,
    sourceHistoryStateId: 212,
    sourceHistoryStateName: "Restore confirmed selection"
  });
  const expectIncompleteEngineGate = async (label, prefixStates, missingState) => {
    const calls = flowCalls();
    const engineForGate = loadExecutableEngine([
      ...prefixStates,
      missingState,
      missingState,
      missingState,
      missingState
    ], calls);
    await assert.rejects(
      () => engineForGate.execute(strictExecutablePlan),
      (error) => Boolean(error && (
        error.code === "INCOMPLETE_STATE_EVIDENCE"
        || error.originalError && error.originalError.code === "INCOMPLETE_STATE_EVIDENCE"
      )),
      label
    );
    assert.strictEqual(calls.selectionExecute, 0, `${label}: selection must not execute`);
    assert.strictEqual(calls.adjustmentExecute, 0, `${label}: adjustment must not execute`);
  };
  const continuouslyIncomplete = withoutDigestEvidence(restoredStable, "continuous-engine-gate");
  await expectIncompleteEngineGate("continuous missing evidence at the first engine gate must fail closed", [], continuouslyIncomplete);

  const expectModalStructuralReject = async (label, changedGateState) => {
    const calls = flowCalls();
    const guardedEngine = loadExecutableEngine(() => {
      throw new Error(`${label}: rejected modal guard must not request imaging`);
    }, calls, {
      lightweightGateProvider: () => lightweightGate(changedGateState)
    });
    await assert.rejects(
      () => guardedEngine.execute(strictExecutablePlan, { executionBaseline: restoredStable }),
      (error) => Boolean(error && (
        error.code === "MODAL_LIGHTWEIGHT_GATE_MISMATCH"
        || error.originalError && error.originalError.code === "MODAL_LIGHTWEIGHT_GATE_MISMATCH"
      )),
      label
    );
    assert.strictEqual(calls.selectionExecute, 0, `${label}: selection must not execute`);
    assert.strictEqual(calls.adjustmentExecute, 0, `${label}: adjustment must not execute`);
    assert(calls.engineSnapshots <= 1,
      `${label}: only fail-path rollback verification may attempt a full imaging snapshot`);
  };
  await expectModalStructuralReject("modal document changed", state({
    document: { ...restoredStable.document, id: 8 }
  }));
  await expectModalStructuralReject("modal history changed", state({
    document: { ...restoredStable.document, historyStateId: 999 }
  }));
  await expectModalStructuralReject("modal active layer changed", state({ activeLayers: [{ id: 99 }] }));
  await expectModalStructuralReject("modal selection bounds changed", state({
    selectionBounds: { ...bounds, right: bounds.right + 1 }
  }));
  await expectModalStructuralReject("modal document width changed", state({
    document: { ...restoredStable.document, width: restoredStable.document.width + 1 }
  }));
  await expectModalStructuralReject("modal document height changed", state({
    document: { ...restoredStable.document, height: restoredStable.document.height + 1 }
  }));
  await expectModalStructuralReject("modal document resolution changed", state({
    document: { ...restoredStable.document, resolution: restoredStable.document.resolution + 1 }
  }));

  const expectPreExecuteRebaseReject = async (label, changedState) => {
    const calls = flowCalls();
    const strictEngine = loadExecutableEngine([restoredStable], calls);
    const flow = loadExecutePlanFlow(main, {
      engine: strictEngine,
      calls,
      initialPlan: executablePlan({
        sourceFingerprint: initialConfirmedState.fingerprint,
        sourceHistoryStateId: 210,
        sourceHistoryStateName: "Confirmed selection"
      }),
      initialSnapshot: initialConfirmedState,
      uiSnapshots: [changedState, changedState]
    });
    await flow.run();
    assert.deepStrictEqual(calls.restores, [], `${label}: unsafe state must be rejected before overwriting the live selection`);
    assert.strictEqual(calls.enginePlan, null, `${label}: strict engine must not start after immutable baseline drift`);
    assert.strictEqual(calls.selectionExecute, 0, `${label}: selection capability must not execute after rebase rejection`);
    assert.strictEqual(calls.adjustmentExecute, 0, `${label}: adjustment must not execute after rebase rejection`);
    assert(calls.failure, `${label}: the pre-execute failure must remain visible to the UI`);
  };

  await expectPreExecuteRebaseReject("history name changed before execute", state({
    fingerprint: "history-name-changed",
    document: {
      id: 7,
      title: "fixture.psd",
      width: 1200,
      height: 1600,
      historyStateId: 211,
      historyStateName: "User edit"
    }
  }));
  await expectPreExecuteRebaseReject("content changed before execute", state({
    fingerprint: "history-content-changed",
    contentFingerprint: "content-changed",
    document: { ...delayedHistory.document }
  }));
  await expectPreExecuteRebaseReject("active layer changed before execute", state({
    fingerprint: "history-active-layer-changed",
    activeLayers: [{ id: 99, name: "Other" }],
    document: { ...delayedHistory.document }
  }));
  await expectPreExecuteRebaseReject("selection changed before execute", state({
    fingerprint: "history-selection-changed",
    selectionDigest: "selection-changed",
    document: { ...delayedHistory.document }
  }));

  await assertPlannedPollingDoesNotOverwrite(main);
  const readStable = loadStableSnapshotReader(main, [
    state({ fingerprint: "history-1" }),
    state({ fingerprint: "history-2" }),
    state({ fingerprint: "history-2" })
  ]);
  assert.strictEqual((await readStable()).fingerprint, "history-2", "two consecutive strict matches lock the final baseline");

  const readRecoveredIntegrity = loadStableSnapshotReader(main, [
    incompleteSelectionState,
    state({ fingerprint: "history-integrity-recovered" }),
    state({ fingerprint: "history-integrity-recovered" })
  ]);
  assert.strictEqual((await readRecoveredIntegrity()).fingerprint, "history-integrity-recovered",
    "stable locking must ignore an incomplete selection digest and recover on two complete matching reads");

  const readContinuousIncomplete = loadStableSnapshotReader(main, [
    incompleteSelectionState,
    incompleteSelectionState,
    incompleteSelectionState,
    incompleteSelectionState,
    incompleteSelectionState
  ]);
  await assert.rejects(() => readContinuousIncomplete(), /Photoshop/,
    "continuous incomplete integrity evidence must fail closed after bounded retries");

  const readUnstable = loadStableSnapshotReader(main, [
    state({ fingerprint: "history-1" }),
    state({ fingerprint: "history-2" }),
    state({ fingerprint: "history-3" }),
    state({ fingerprint: "history-4" }),
    state({ fingerprint: "history-5" })
  ]);
  await assert.rejects(() => readUnstable(), /Photoshop/, "an unstable strict fingerprint must fail closed after bounded retries");

  const confirmStart = main.indexOf("async function confirmVisualCandidate()");
  const confirmEnd = main.indexOf("async function adoptCurrentPhotoshopSelection()", confirmStart);
  const confirmSource = main.slice(confirmStart, confirmEnd);
  assert(confirmSource.includes("setBusy(true"), "selection confirmation must block background refresh polling");
  assert(confirmSource.includes("finally"));
  assert(confirmSource.includes("setBusy(false)"));
  assert(main.includes("runtime.documentSignature = documentSignature();"), "rebasing must synchronize the polling signature");

  const refreshStart = main.indexOf("async function refreshWhenDocumentChanges()");
  const refreshEnd = main.indexOf("function renderPlan", refreshStart);
  const refreshSource = main.slice(refreshStart, refreshEnd);
  assert(refreshSource.includes("runtime.plan"), "background polling must not overwrite the plan snapshot");

  const executeStart = main.indexOf("async function executePlan()");
  const executeEnd = main.indexOf("async function undoLast()", executeStart);
  const executeSource = main.slice(executeStart, executeEnd);
  const busyIndex = executeSource.indexOf("setBusy(true)");
  const baselineReadIndex = executeSource.indexOf('readStableStrictSnapshot("pre_execute_baseline"');
  const strictGateIndex = executeSource.indexOf("assertSafeSelectionRestoreBaseline");
  const engineIndex = executeSource.indexOf("await engine.execute(");
  assert(busyIndex >= 0 && baselineReadIndex > busyIndex && strictGateIndex > baselineReadIndex
    && engineIndex > strictGateIndex,
  "execute must lock and exactly validate one complete stable baseline under busy, then immediately enter the engine");
  assert(!executeSource.includes("await activateSelectionStep"),
    "execution must not restore or rebase a selection before entering the strict engine");
  assert(executeSource.includes("if (runtime.refreshPromise) await runtime.refreshPromise"),
    "execute must wait for any refresh that was already in flight before reading the pre-restore gate");
  assert(executeSource.includes('readStableStrictSnapshot("pre_execute_baseline"'),
    "execute must lock one final complete stable snapshot and pass that immutable snapshot into the engine");
  assert(executeSource.includes("{ executionBaseline }"),
    "engine must reuse the UI-modal stable snapshot instead of starting with a bare host read");
  assert(executeSource.includes("baselineDiagnostics"), "first-gate diagnostics must be rendered without document pixels");
  assert(main.includes("runtime.visualConfirmedSteps.delete(item.index)"), "lasso/adopt/reset session changes must revoke confirmation");
  assert(main.includes("runtime.visualConfirmedSteps.delete(visual.index)"), "point/reset candidate changes must revoke confirmation");

  const manualRefreshStart = main.indexOf('bindEvent("refreshState", "click"');
  const manualRefreshEnd = main.indexOf('bindEvent("analyze", "click"', manualRefreshStart);
  const manualRefreshSource = main.slice(manualRefreshStart, manualRefreshEnd);
  assert(manualRefreshSource.includes("if (runtime.plan)"), "manual refresh must refuse to overwrite a pending plan baseline");

  console.log(`${testVersion} execute-time selection relock is stable, immutable-baseline checked, strictly gated, and diagnosable`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
