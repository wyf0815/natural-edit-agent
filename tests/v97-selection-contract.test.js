"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const sourceRoot = path.join(root, `uxp-${testVersion}`);
const protocol = require(path.join(sourceRoot, "protocol.js"));
const confidence = require(path.join(sourceRoot, "confidence-policy.js"));

function operation(action, params) {
  return protocol.normalizeIntent({
    operations: [{ action, target: { scope: "document" }, params, requirementIds: ["req_test"] }]
  }).operations[0];
}

function loadVisualTargetContract() {
  const source = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
  const start = source.indexOf("function enforceVisualTargetContract");
  const end = source.indexOf("\nfunction enforceVisualPlanContracts", start);
  assert(start >= 0 && end > start, "visual target contract must remain extractable for behavior tests");
  const context = {
    protocol,
    pointInsideVisualBox(point, box) {
      return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
    },
    result: null
  };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = enforceVisualTargetContract;`, context, { filename: "main-visual-contract.js" });
  return context.result;
}

function loadSelectionSessions() {
  const source = fs.readFileSync(path.join(sourceRoot, "selection-session.js"), "utf8");
  const calls = { putSelection: [], polygons: [], disposed: 0 };
  let mask = new Uint8Array(12).fill(255);
  const document = {
    id: 7,
    width: 100,
    height: 80,
    selection: {
      bounds: { left: 10, top: 20, right: 14, bottom: 23 },
      async selectPolygon(points, type, feather, antiAlias) {
        calls.polygons.push({ points, type, feather, antiAlias });
      }
    }
  };
  const photoshop = {
    app: { documents: [document], activeDocument: document },
    constants: {
      SelectionType: {
        REPLACE: "replace",
        EXTEND: "add",
        DIMINISH: "subtract",
        INTERSECT: "intersect"
      }
    },
    imaging: {
      async getSelection() {
        return {
          sourceBounds: { left: 10, top: 20, right: 14, bottom: 23 },
          imageData: {
            width: 4,
            height: 3,
            async getData() { return new Uint8Array(mask); },
            dispose() { calls.disposed += 1; }
          }
        };
      },
      async createImageDataFromBuffer(data, options) {
        return { data: new Uint8Array(data), options, dispose() { calls.disposed += 1; } };
      },
      async putSelection(options) { calls.putSelection.push(options); }
    }
  };
  const context = {
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    module: { exports: {} },
    require(name) {
      if (name === "photoshop") return photoshop;
      throw new Error(`unexpected require ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "selection-session.js" });
  return {
    sessions: context.module.exports,
    photoshop,
    document,
    calls,
    setMask(value) { mask = new Uint8Array(value); }
  };
}

async function main() {
  for (const text of [
    "只把右下角黄色奖杯变成灰色，保留高光和立体阴影。",
    "把商品改成蓝色并保持原有明暗和纹理",
    "阴影、光泽和细节保持不变",
    "保留原来的立体感与自然渐变",
    "奖杯的高光和阴影保持不变",
    "脸上的高光保持不变"
  ]) {
    assert.strictEqual(
      protocol.hasExplicitVisualSpatialProtection(text),
      false,
      `${text} is an appearance constraint, not a hard protected region`
    );
  }
  for (const text of [
    "把奖杯变成灰色，但人物的手保持不变",
    "把主体调暗，背景不要改",
    "保留奖杯前面的手",
    "只改身体，脸和嘴不变",
    "保留高光，同时脸保持不变"
  ]) {
    assert.strictEqual(
      protocol.hasExplicitVisualSpatialProtection(text),
      true,
      `${text} names a spatially protected region`
    );
  }

  const enforceVisualTargetContract = loadVisualTargetContract();
  const visualStep = () => ({
    action: "selection.visual_object",
    params: {
      description: "右下角黄色奖杯",
      semanticScope: "whole_object",
      targetBox: { left: 55, top: 40, right: 92, bottom: 92 },
      positivePoints: [{ x: 70, y: 70 }],
      excludePoints: [{ x: 74, y: 62 }, { x: 78, y: 70 }]
    }
  });
  const appearanceOnly = visualStep();
  enforceVisualTargetContract(appearanceOnly, "只把右下角黄色奖杯变成灰色，保留高光和立体阴影。", { sanitizeModelExclusions: true });
  assert.deepStrictEqual(Array.from(appearanceOnly.params.excludePoints), [], "initial model points must not exclude highlights or shadows");

  const explicitSpatial = visualStep();
  enforceVisualTargetContract(explicitSpatial, "把右下角黄色奖杯变成灰色，但前面人物的手保持不变", { sanitizeModelExclusions: true });
  assert.strictEqual(explicitSpatial.params.excludePoints.length, 2, "explicit spatial protection must retain initial exclusion points");

  const verifiedCorrection = visualStep();
  enforceVisualTargetContract(verifiedCorrection, "只把右下角黄色奖杯变成灰色，保留高光和立体阴影。", { sanitizeModelExclusions: false });
  assert.strictEqual(verifiedCorrection.params.excludePoints.length, 2, "verified or user-authored exclusion points must survive candidate regeneration");

  assert.strictEqual(confidence.classify(0.90).level, "high");
  assert.strictEqual(confidence.classify(0.60).level, "medium");
  const low = confidence.classify(0.20);
  assert.strictEqual(low.level, "low");
  assert.strictEqual(low.requiresCorrection, true);
  assert.strictEqual(low.explicitAcceptRequired, true);
  assert.strictEqual(confidence.mayConfirm(low, { corrected: false, lowConfidenceAccepted: false }), false);
  assert.strictEqual(confidence.mayConfirm(low, { corrected: true, lowConfidenceAccepted: false }), true);
  assert.strictEqual(confidence.mayConfirm(low, { corrected: false, lowConfidenceAccepted: true }), true);
  const unsafe = confidence.classify(0.95, { hasCandidate: false });
  assert.strictEqual(unsafe.canConfirm, false);
  assert.strictEqual(confidence.mayConfirm(unsafe, { corrected: true }), false);

  const normalizedRectangle = operation("selection.rectangle", {
    unit: "normalized", left: 0.1, top: 0.2, right: 0.9, bottom: 0.8
  });
  assert.strictEqual(normalizedRectangle.params.unit, "percent");
  assert.deepStrictEqual(
    [normalizedRectangle.params.left, normalizedRectangle.params.top, normalizedRectangle.params.right, normalizedRectangle.params.bottom],
    [10, 20, 90, 80]
  );

  const onePercentRectangle = operation("selection.rectangle", {
    unit: "percent", left: 1, top: 1, right: 2, bottom: 2
  });
  assert.strictEqual(onePercentRectangle.params.left, 1, "1 percent must not be guessed as normalized");

  const normalizedPolygon = operation("selection.polygon", {
    unit: "normalized",
    points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.9 }]
  });
  assert.strictEqual(normalizedPolygon.params.unit, "percent");
  assert.deepStrictEqual(normalizedPolygon.params.points, [{ x: 10, y: 20 }, { x: 80, y: 20 }, { x: 50, y: 90 }]);

  const visual = operation("selection.visual_object", {
    description: "奖杯",
    semanticScope: "whole_object",
    unit: "normalized",
    targetBox: { left: 0.2, top: 0.2, right: 0.6, bottom: 0.7 },
    searchRegion: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.9 },
    seed: { x: 0.4, y: 0.5 },
    positivePoints: [{ x: 0.3, y: 0.4 }],
    excludePoints: [{ x: 0.7, y: 0.8 }],
    confidence: 0.42
  });
  assert.strictEqual(visual.params.unit, "percent");
  assert.deepStrictEqual(visual.params.seed, { x: 40, y: 50 });
  assert.deepStrictEqual(visual.params.positivePoints, [{ x: 30, y: 40 }]);
  assert.deepStrictEqual(visual.params.excludePoints, [{ x: 70, y: 80 }]);
  assert.throws(() => operation("selection.rectangle", {
    unit: "normalized", left: 0, top: 0, right: 1.1, bottom: 1
  }), /区域右边界/);

  const harness = loadSelectionSessions();
  const first = await harness.sessions.captureCurrent({ metadata: { source: "automatic" } });
  assert(first.token && first.token.startsWith("selection_"));
  assert.strictEqual(first.documentID, 7);
  assert.strictEqual(first.selectedPixels, 12);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first.selectionBounds)), { left: 10, top: 20, right: 14, bottom: 23 });
  assert.strictEqual(first.corrected, false);

  await harness.sessions.restore(first.token);
  assert.strictEqual(harness.calls.putSelection.length, 1);
  assert.strictEqual(harness.calls.putSelection[0].replace, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.calls.putSelection[0].targetBounds)), { left: 10, top: 20 });
  assert.deepStrictEqual(Array.from(harness.calls.putSelection[0].imageData.data), Array(12).fill(255));

  const corrected = await harness.sessions.applyPolygon(first.token, [
    { x: -20, y: -30 }, { x: 50, y: 10 }, { x: 120, y: 90 }
  ], "subtract");
  assert.strictEqual(corrected.token, first.token, "corrections must update the same authoritative session");
  assert.strictEqual(corrected.corrected, true);
  assert.strictEqual(corrected.correctionSource, "panel-lasso:subtract");
  assert.strictEqual(harness.calls.polygons[0].type, "subtract");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.calls.polygons[0].points)), [
    { x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 80 }
  ]);

  const accepted = harness.sessions.setLowConfidenceAccepted(first.token, true);
  assert.strictEqual(accepted.lowConfidenceAccepted, true);
  harness.photoshop.app.activeDocument = { ...harness.document, id: 99 };
  await assert.rejects(() => harness.sessions.restore(first.token), /当前文档与锁定选区不一致/);
  harness.sessions.release(first.token);
  assert.strictEqual(harness.sessions.describe(first.token), null);

  console.log(`${testVersion} explicit coordinates, confidence policy, lasso add/subtract, and authoritative selection-session regressions passed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
