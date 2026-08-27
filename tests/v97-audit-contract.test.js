"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const sourceRoot = path.join(root, `uxp-${testVersion}`);
const protocol = require(path.join(sourceRoot, "protocol.js"));
const planner = require(path.join(sourceRoot, "planner.js"));

function loadEngine() {
  const source = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");
  const context = {
    console, Date, Set, Map, JSON, Math, Number, String, Object, Array,
    PhotoshopAssistantV8Protocol: protocol,
    PhotoshopAssistantV9Planner: planner,
    PhotoshopAssistantV8State: { compactForModel: (value) => value, snapshot: async () => ({}) },
    PhotoshopAssistantV8Capabilities: {
      catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
      get: () => ({ label: "test", preflight() {} }),
      stateLayer() { return null; },
      subtreeIds() { return []; }
    },
    require(name) {
      if (name === "photoshop") return { app: { documents: [] }, core: {}, action: { batchPlay: async () => [] }, constants: {} };
      throw new Error(`unexpected require ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "engine.js" });
  return context.PhotoshopAssistantV8Engine;
}

function loadExecutionHarness(snapshotSequence) {
  const source = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");
  const calls = {
    snapshots: 0,
    selectionExecute: 0,
    adjustmentExecute: 0,
    modal: 0
  };
  const states = snapshotSequence.map((state) => JSON.parse(JSON.stringify(state)));
  let lastState = states[states.length - 1];
  const stateEngine = {
    compactForModel: (value) => value,
    async snapshot() {
      calls.snapshots += 1;
      if (states.length) lastState = states.shift();
      return JSON.parse(JSON.stringify(lastState));
    },
    async captureLightweightGateSnapshot() {
      const gate = await this.snapshot();
      gate.complete = true;
      return gate;
    },
    lightweightGateMatches(expected, gate) {
      return Boolean(gate && gate.complete && expected && gate.fingerprint === expected.fingerprint);
    }
  };
  const definition = (id) => ({
    id,
    label: id,
    risk: "low",
    reversible: true,
    documentWide: true,
    authorizedScope: "none",
    preflight() {},
    async execute() {
      if (id === "selection.visual_object") calls.selectionExecute += 1;
      else calls.adjustmentExecute += 1;
      return id === "selection.visual_object"
        ? { selectedPixels: 100, authoritativeSelection: true, documentWide: false }
        : { resultLayerId: null, documentWide: true };
    },
    async verify() { return `${id}:verified`; }
  });
  const capabilities = {
    catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
    get: (id) => definition(id),
    stateLayer() { return null; },
    subtreeIds() { return []; }
  };
  const activeDocument = {
    id: 17,
    title: "selection-flow.psd",
    activeHistoryState: { id: 10 },
    selection: { async deselect() {} }
  };
  const context = {
    console, Date, Set, Map, JSON, Math, Number, String, Object, Array,
    PhotoshopAssistantV8Protocol: protocol,
    PhotoshopAssistantV9Planner: planner,
    PhotoshopAssistantV8State: stateEngine,
    PhotoshopAssistantV8Capabilities: capabilities,
    require(name) {
      if (name === "photoshop") return {
        app: { documents: [activeDocument], activeDocument },
        core: {
          async executeAsModal(callback) {
            calls.modal += 1;
            return callback({
              isCancelled: false,
              reportProgress() {},
              hostControl: {
                async suspendHistory() { return { id: "history-suspension" }; },
                async resumeHistory() {}
              }
            });
          }
        },
        action: { batchPlay: async () => [] },
        constants: {}
      };
      if (name === "uxp") throw new Error("export picker must not run in selection execution regression");
      throw new Error(`unexpected require ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "engine-selection-execute-flow.js" });
  return { engine: context.PhotoshopAssistantV8Engine, calls };
}

const engine = loadEngine();
const instruction = "复制当前图层，然后把副本重命名为活动副本";
const requirements = planner.buildRequirements(instruction);
assert.strictEqual(requirements.length, 2);

const completeIntent = protocol.normalizeIntent({
  operations: [
    {
      id: "copy",
      action: "layer.duplicate",
      target: { scope: "active_layer" },
      params: {},
      requirementIds: [requirements[0].id]
    },
    {
      id: "rename",
      action: "layer.rename",
      target: { scope: "operation_result", resultOf: "copy" },
      params: { name: "活动副本" },
      requirementIds: [requirements[1].id]
    }
  ]
});
const completeAudit = engine.auditPlanningCompleteness(instruction, completeIntent, requirements);
assert.strictEqual(completeAudit.complete, true);
assert.strictEqual(completeAudit.semanticAudit.complete, true, "instruction-to-plan semantic audit must pass");
assert.strictEqual(completeAudit.requirementAudit.complete, true, "requirements-to-plan coverage audit must pass");
assert.strictEqual(completeAudit.dependencyAudit.valid, true, "plan dependency audit must pass");

const incompleteIntent = protocol.normalizeIntent({ operations: [completeIntent.operations[0]] });
const incompleteAudit = engine.auditPlanningCompleteness(instruction, incompleteIntent, requirements);
assert.strictEqual(incompleteAudit.complete, false);
assert(incompleteAudit.missing.length > 0, "a one-way/partial plan must explain what is missing");

function auditCase(text, operationSpecs) {
  const caseRequirements = planner.buildRequirements(text);
  const operations = operationSpecs.map((spec, index) => {
    const keys = Array.isArray(spec.keys) ? spec.keys : [spec.keys];
    const requirementIds = caseRequirements
      .filter((item) => keys.includes(item.key))
      .map((item) => item.id);
    return {
      id: spec.id || `op_${index + 1}`,
      action: spec.action,
      target: spec.target || { scope: "active_layer" },
      params: spec.params || {},
      requirementIds
    };
  });
  const intent = { operations, constraints: [], ambiguities: [] };
  return {
    requirements: caseRequirements,
    result: engine.auditPlanningCompleteness(text, intent, caseRequirements)
  };
}

const visualParams = {
  description: "右下角奖杯",
  semanticScope: "whole_object",
  unit: "normalized",
  targetBox: { left: 0.5, top: 0.5, right: 1, bottom: 1 },
  searchRegion: { left: 0.35, top: 0.35, right: 1, bottom: 1 },
  seed: { x: 0.75, y: 0.75 },
  confidence: 0.8
};
const recolorText = "把右下角奖杯改成红色";
const correctRecolor = auditCase(recolorText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: visualParams, keys: "color_adjustment" },
  { action: "adjustment.colorize", params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]);
assert.strictEqual(correctRecolor.result.complete, true, "specific-object recolor must pass with visual_object and the requested color");
const wrongObjectViaColor = auditCase(recolorText, [
  { action: "selection.color_range", target: { scope: "document" }, params: { color: "#FFFF00", tolerance: 24 }, keys: "color_adjustment" },
  { action: "adjustment.colorize", params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]);
assert.strictEqual(wrongObjectViaColor.result.complete, false, "a global color range must not impersonate a named object");
const wrongObjectViaSubject = auditCase(recolorText, [
  { action: "selection.subject", target: { scope: "document" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.colorize", params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]);
assert.strictEqual(wrongObjectViaSubject.result.complete, false, "Select Subject must not impersonate a specified instance");
const wrongColor = auditCase(recolorText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: visualParams, keys: "color_adjustment" },
  { action: "adjustment.colorize", params: { color: "#0000FF", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]);
assert.strictEqual(wrongColor.result.complete, false, "a correct target with the wrong requested color must fail");

// Seen production regression: a model may describe excluded landmarks while
// locating the requested part. Those negative-role words must be sanitized,
// not promoted to a second modification target. A real part substitution is
// still rejected below.
const structuredBodyInstruction = "把画面中黄色玉米人物的身体改成青蓝色，描边花纹样式不变。";
const bodyWithModelLandmarks = auditCase(structuredBodyInstruction, [
  {
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "黄色玉米人物的身体，排除嘴和绿色叶子",
      semanticScope: "subpart",
      unit: "percent",
      targetBox: { left: 28, top: 35, right: 58, bottom: 82 },
      searchRegion: { left: 18, top: 22, right: 68, bottom: 92 },
      seed: { x: 43, y: 58 },
      excludePoints: [{ x: 47, y: 43 }],
      confidence: 0.82
    },
    keys: "color_adjustment"
  },
  { action: "adjustment.colorize", params: { color: "#00B7C7", opacity: 100, blendMode: "color" }, keys: "color_adjustment" }
]);
assert.strictEqual(bodyWithModelLandmarks.result.complete, true, "negative-role landmarks must not become unauthorized target nouns");
const wrongBodyPart = auditCase(structuredBodyInstruction, [
  {
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "黄色玉米人物的嘴",
      semanticScope: "subpart",
      unit: "percent",
      targetBox: { left: 35, top: 38, right: 50, bottom: 50 },
      searchRegion: { left: 18, top: 22, right: 68, bottom: 92 },
      seed: { x: 42, y: 44 },
      confidence: 0.82
    },
    keys: "color_adjustment"
  },
  { action: "adjustment.colorize", params: { color: "#00B7C7", opacity: 100, blendMode: "color" }, keys: "color_adjustment" }
]);
assert.strictEqual(wrongBodyPart.result.complete, false, "a true target-part substitution must remain blocked");

// Regression matrix for annotated/local object edits.  A colour adjective may
// identify a complete object without authorizing a global colour-range
// selection, and the model may omit that adjective while retaining the exact
// object, direction, and reviewed geometry.
const markedObjectGrayCases = [
  {
    text: "只把右下角黄色奖杯变成灰色，保留高光和立体阴影。",
    description: "右下角奖杯",
    box: { left: 60, top: 50, right: 95, bottom: 95 },
    search: { left: 50, top: 40, right: 100, bottom: 100 },
    seed: { x: 80, y: 75 }
  },
  {
    text: "把左上角红色商品变成灰色，保留原有纹理。",
    description: "左上角商品",
    box: { left: 5, top: 5, right: 45, bottom: 45 },
    search: { left: 0, top: 0, right: 55, bottom: 55 },
    seed: { x: 25, y: 25 }
  },
  {
    text: "把左下角绿色人物变成灰色，保持明暗不变。",
    description: "左下角人物",
    box: { left: 5, top: 55, right: 45, bottom: 95 },
    search: { left: 0, top: 45, right: 55, bottom: 100 },
    seed: { x: 25, y: 75 }
  },
  {
    text: "把右上角蓝色图标变成灰色，保留阴影。",
    description: "右上角图标",
    box: { left: 55, top: 5, right: 95, bottom: 45 },
    search: { left: 45, top: 0, right: 100, bottom: 55 },
    seed: { x: 75, y: 25 }
  }
];
for (const item of markedObjectGrayCases) {
  const caseRequirements = planner.buildRequirements(item.text);
  const colorRequirement = caseRequirements.find((requirement) => requirement.key === "color_adjustment");
  assert(colorRequirement, `${item.text} must create a color-adjustment requirement`);
  assert.strictEqual(colorRequirement.expectedParams.selectionColor, undefined,
    "a colour adjective on a named object must not become a global color range");
  const result = auditCase(item.text, [
    {
      action: "selection.visual_object",
      target: { scope: "document" },
      params: {
        description: item.description,
        semanticScope: "whole_object",
        unit: "percent",
        targetBox: item.box,
        searchRegion: item.search,
        seed: item.seed,
        confidence: 0.8,
        colorRefine: "none",
        allowColorFallback: false
      },
      keys: "color_adjustment"
    },
    {
      action: "adjustment.hue_saturation",
      target: { scope: "document" },
      params: { hue: 0, saturation: -100, lightness: 0 },
      keys: "color_adjustment"
    }
  ]).result;
  assert.strictEqual(result.complete, true, `${item.text} must accept a correctly located object and luminance-preserving grayscale edit`);
}

const markedTrophyText = markedObjectGrayCases[0].text;
const markedTrophyVisual = {
  description: "右下角奖杯",
  semanticScope: "whole_object",
  unit: "percent",
  targetBox: { left: 60, top: 50, right: 95, bottom: 95 },
  searchRegion: { left: 50, top: 40, right: 100, bottom: 100 },
  seed: { x: 80, y: 75 },
  confidence: 0.8,
  colorRefine: "none",
  allowColorFallback: false
};
for (const wrongTarget of [
  { ...markedTrophyVisual, description: "右下角帽子" },
  { ...markedTrophyVisual, description: "左上角奖杯" },
  { ...markedTrophyVisual, description: "右下角红色奖杯" },
  {
    ...markedTrophyVisual,
    unit: "normalized",
    targetBox: { left: 0.05, top: 0.05, right: 0.4, bottom: 0.4 },
    searchRegion: { left: 0, top: 0, right: 0.5, bottom: 0.5 },
    seed: { x: 0.2, y: 0.2 }
  }
]) {
  assert.strictEqual(auditCase(markedTrophyText, [
    { action: "selection.visual_object", target: { scope: "document" }, params: wrongTarget, keys: "color_adjustment" },
    { action: "adjustment.hue_saturation", target: { scope: "document" }, params: { hue: 0, saturation: -100, lightness: 0 }, keys: "color_adjustment" }
  ]).result.complete, false, "wrong object, direction, colour, or geometry must still be rejected");
}
assert.strictEqual(auditCase(markedTrophyText, [
  { action: "selection.color_range", target: { scope: "document" }, params: { color: "#FFFF00", tolerance: 24, softness: 8 }, keys: "color_adjustment" },
  { action: "adjustment.hue_saturation", target: { scope: "document" }, params: { hue: 0, saturation: -100, lightness: 0 }, keys: "color_adjustment" }
]).result.complete, false, "a named trophy must not degrade into a whole-image yellow-pixel selection");
assert.strictEqual(auditCase(markedTrophyText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: markedTrophyVisual, keys: "color_adjustment" },
  { action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#808080", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]).result.complete, false, "a solid normal-mode gray fill must not satisfy an explicit request to preserve highlights and shadows");

const explicitColorRangeText = "把全图所有黄色像素改成灰色，颜色容差10";
assert.strictEqual(auditCase(explicitColorRangeText, [
  { action: "selection.color_range", target: { scope: "document" }, params: { color: "#FFFF00", tolerance: 10, softness: 8 }, keys: "color_adjustment" },
  { action: "adjustment.hue_saturation", target: { scope: "document" }, params: { hue: 0, saturation: -100, lightness: 0 }, keys: "color_adjustment" }
]).result.complete, true, "explicit whole-image pixel wording must continue to authorize color_range");

const visibilityCorrect = auditCase("隐藏当前图层", [
  { action: "layer.set_visibility", target: { scope: "active_layer" }, params: { visible: false }, keys: "visibility" }
]);
assert.strictEqual(visibilityCorrect.result.complete, true);
const visibilityWrongTarget = auditCase("隐藏当前图层", [
  { action: "layer.set_visibility", target: { scope: "layer_name", query: "背景" }, params: { visible: false }, keys: "visibility" }
]);
assert.strictEqual(visibilityWrongTarget.result.complete, false, "the correct action must not target a different layer");

const namedOpacity = "把名为背景的图层不透明度从30%改为50%";
const namedOpacityRequirements = planner.buildRequirements(namedOpacity);
const opacityRequirement = namedOpacityRequirements.find((item) => item.key === "opacity");
assert.strictEqual(opacityRequirement.expectedParams.opacity, 50, "target value after 改为 must win over the old value");
assert.deepStrictEqual(opacityRequirement.expectedTarget, { scopes: ["layer_name"], query: "背景" });
assert.strictEqual(auditCase(namedOpacity, [
  { action: "layer.set_opacity", target: { scope: "layer_name", query: "背景" }, params: { opacity: 50 }, keys: "opacity" }
]).result.complete, true);
assert.strictEqual(auditCase(namedOpacity, [
  { action: "layer.set_opacity", target: { scope: "active_layer" }, params: { opacity: 50 }, keys: "opacity" }
]).result.complete, false, "a named layer requirement must reject active_layer");

const moveRequirement = planner.buildRequirements("当前图层向右移动40px").find((item) => item.key === "move");
assert.deepStrictEqual(moveRequirement.expectedActions, ["layer.move_by"]);
assert.deepStrictEqual(moveRequirement.expectedParams, { deltaX: 40, deltaY: 0 });
assert.strictEqual(auditCase("当前图层向右移动40px", [
  { action: "layer.align_to_reference", target: { scope: "active_layer" }, params: { reference: "canvas", horizontal: "center", vertical: "middle" }, keys: "move" }
]).result.complete, false, "numeric relative movement must not be replaced by canvas alignment");
assert.deepStrictEqual(planner.buildRequirements("当前图层缩放到50%").find((item) => item.key === "scale").expectedActions, ["layer.scale"]);
assert.strictEqual(auditCase("当前图层缩放到50%", [
  { action: "layer.fit_to_reference", target: { scope: "active_layer" }, params: { reference: "canvas", horizontal: "center", vertical: "middle" }, keys: "scale" }
]).result.complete, false, "explicit scale percentage must not be replaced by fit-to-canvas");
assert.deepStrictEqual(planner.buildRequirements("当前图层旋转90度").find((item) => item.key === "rotate").expectedActions, ["layer.rotate"]);
assert.strictEqual(auditCase("当前图层旋转90度", [
  { action: "document.rotate", target: { scope: "document" }, params: { angle: 90 }, keys: "rotate" }
]).result.complete, false, "layer rotation must not become a document rotation");
assert.deepStrictEqual(planner.buildRequirements("画布从800×600改为1200×900").find((item) => item.key === "document_size").expectedParams, { width: 1200, height: 900, anchor: "middle_center" });
assert.deepStrictEqual(planner.buildRequirements("画布调整为1200×900").find((item) => item.key === "document_size").expectedActions, ["document.resize_canvas"]);

for (const [word, color] of [["绿色", "#00A651"], ["橙色", "#FF8C00"], ["粉色", "#FF69B4"]]) {
  const req = planner.buildRequirements(`当前文字改成${word}`).find((item) => item.key === "text_color");
  assert(req, `${word} text requirement must be detected`);
  assert.strictEqual(req.expectedParams.color, color, `${word} must use the shared protocol color table`);
  assert.deepStrictEqual(req.expectedTarget, { scopes: ["active_layer"] });
}
assert.strictEqual(auditCase("把当前文字字号改为80点", [
  { action: "text.set_size", target: { scope: "layer_name", query: "其他文字" }, params: { size: 80 }, keys: "text_size" }
]).result.complete, false, "current text must not resolve to another text layer");
assert.deepStrictEqual(planner.buildRequirements("把文案组内文字字号改为24").find((item) => item.key === "text_size").expectedTarget, { scopes: ["layer_name"], query: "文案" });

for (const text of ["把“背景”图层隐藏", "把背景图层隐藏", "把叫做背景的图层隐藏"]) {
  const requirement = planner.buildRequirements(text).find((item) => item.key === "visibility");
  assert.deepStrictEqual(requirement.expectedTarget, { scopes: ["layer_name"], query: "背景" }, `${text} must bind the named layer`);
  assert.strictEqual(auditCase(text, [
    { action: "layer.set_visibility", target: { scope: "layer_name", query: "前景" }, params: { visible: false }, keys: "visibility" }
  ]).result.complete, false, `${text} must reject a different named layer`);
}
for (const text of ["隐藏背景图层", "把背景层隐藏"]) {
  const requirement = planner.buildRequirements(text).find((item) => item.key === "visibility");
  assert.deepStrictEqual(requirement.expectedTarget, { scopes: ["layer_name"], query: "背景" });
}
assert.strictEqual(auditCase("隐藏背景图层", [
  { action: "layer.set_visibility", target: { scope: "layer_name", query: "背景" }, params: { visible: false }, keys: "visibility" }
]).result.complete, true, "a named background layer visibility change must not be mistaken for a cutout workflow");
assert.deepStrictEqual(planner.buildRequirements("删除背景图层").find((item) => item.key === "delete").expectedTarget, { scopes: ["layer_name"], query: "背景" });
assert.deepStrictEqual(planner.buildRequirements("把这个图层隐藏").find((item) => item.key === "visibility").expectedTarget, { scopes: ["active_layer"] });

const copyRenameText = "复制当前图层并重命名为副本";
assert.strictEqual(auditCase(copyRenameText, [
  { id: "copy", action: "layer.duplicate", target: { scope: "active_layer" }, params: {}, keys: "duplicate" },
  { id: "rename", action: "layer.rename", target: { scope: "operation_result", resultOf: "copy" }, params: { name: "副本" }, keys: "rename" }
]).result.complete, true, "same-clause copy follow-up must bind to the produced layer");
const copyOpacityText = "复制当前图层并把副本不透明度设为50%";
assert.strictEqual(auditCase(copyOpacityText, [
  { id: "copy", action: "layer.duplicate", target: { scope: "active_layer" }, params: {}, keys: "duplicate" },
  { id: "opacity", action: "layer.set_opacity", target: { scope: "operation_result", resultOf: "copy" }, params: { opacity: 50 }, keys: "opacity" }
]).result.complete, true, "copy opacity must bind to operation_result");
assert.strictEqual(auditCase("复制当前图层并把原图层不透明度设为50%", [
  { id: "copy", action: "layer.duplicate", target: { scope: "active_layer" }, params: {}, keys: "duplicate" },
  { id: "opacity", action: "layer.set_opacity", target: { scope: "active_layer" }, params: { opacity: 50 }, keys: "opacity" }
]).result.complete, true, "an explicit original layer follow-up must not be forced onto the copy");

const createGroupText = "创建一个名为素材的图层组";
assert.strictEqual(auditCase(createGroupText, [
  { action: "layer.create_group", target: { scope: "document" }, params: { name: "素材" }, keys: "create_group" }
]).result.complete, true);
assert.strictEqual(auditCase(createGroupText, [
  { action: "layer.create_group", target: { scope: "document" }, params: { name: "删除组" }, keys: "create_group" }
]).result.complete, false, "created group name must match the requested name");
const moveGroupText = "把当前图层放到素材组中";
assert.strictEqual(auditCase(moveGroupText, [
  { action: "layer.move_to_group", target: { scope: "active_layer" }, params: { groupName: "素材组" }, keys: "move_to_group" }
]).result.complete, true);
assert.strictEqual(auditCase(moveGroupText, [
  { action: "layer.move_to_group", target: { scope: "active_layer" }, params: { groupName: "删除组" }, keys: "move_to_group" }
]).result.complete, false, "move_to_group destination must match the requested group");
assert.deepStrictEqual(planner.buildRequirements("把背景图层放到素材组中").find((item) => item.key === "move_to_group").expectedTarget, { scopes: ["layer_name"], query: "背景" });
assert.deepStrictEqual(planner.buildRequirements("把当前图层放到“素材”组中").find((item) => item.key === "move_to_group").expectedParams.destinationGroupName, "素材");

const valueCases = [
  ["把当前图层混合模式改为正片叠底", "blend", "layer.set_blend_mode", { blendMode: "multiply" }, { blendMode: "screen" }],
  ["锁定当前图层透明像素", "lock", "layer.set_lock", { lock: "transparentPixels", locked: true }, { lock: "all", locked: true }],
  ["把当前图层水平翻转", "flip", "layer.flip", { axis: "horizontal" }, { axis: "vertical" }],
  ["把当前图层置顶", "reorder", "layer.reorder", { position: "front" }, { position: "back" }],
  ["把当前文字字体改为思源黑体", "text_font", "text.set_font", { font: "思源黑体" }, { font: "Arial" }],
  ["把当前文字改为竖排", "text_orientation", "text.set_orientation", { orientation: "vertical" }, { orientation: "horizontal" }],
  ["把当前文字行距设为24", "text_spacing", "text.set_leading", { leading: 24 }, { leading: 99 }],
  ["把当前图层饱和度设为20", "color_adjustment", "adjustment.hue_saturation", { hue: 0, saturation: 20, lightness: 0 }, { hue: 0, saturation: -100, lightness: 0 }],
  ["把当前图层高斯模糊5px", "filter", "filter.gaussian_blur", { radius: 5 }, { radius: 100 }],
  ["导出PNG", "export", "document.export", { format: "png" }, { format: "jpeg" }],
  ["把当前选区羽化3像素", "selection", "selection.feather", { by: 3 }, { by: 30 }]
];
for (const [text, key, action, correctParams, wrongParams] of valueCases) {
  const target = action.startsWith("document.") || action.startsWith("selection.") || action.startsWith("adjustment.")
    ? { scope: "document" }
    : { scope: "active_layer" };
  const selector = action.startsWith("adjustment.")
    ? [{ action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: key }]
    : [];
  const correctAudit = auditCase(text, [...selector, { action, target, params: correctParams, keys: key }]);
  assert.strictEqual(correctAudit.result.complete, true, `${text} correct params must pass: ${JSON.stringify(correctAudit.result.missing)}`);
  assert.strictEqual(auditCase(text, [...selector, { action, target, params: wrongParams, keys: key }]).result.complete, false, `${text} wrong params must fail`);
}

const canvasAnchorText = "把画布调整为1200×900，锚点左上";
assert.strictEqual(auditCase(canvasAnchorText, [
  { action: "document.resize_canvas", target: { scope: "document" }, params: { width: 1200, height: 900, anchor: "top_left" }, keys: "document_size" }
]).result.complete, true);
assert.strictEqual(auditCase(canvasAnchorText, [
  { action: "document.resize_canvas", target: { scope: "document" }, params: { width: 1200, height: 900, anchor: "bottom_right" }, keys: "document_size" }
]).result.complete, false, "canvas anchor must match the request");
const alignText = "把当前图层居中到画布";
assert.strictEqual(auditCase(alignText, [
  { action: "layer.align_to_reference", target: { scope: "active_layer" }, params: { reference: "canvas", horizontal: "center", vertical: "middle" }, keys: "align" }
]).result.complete, true);
assert.strictEqual(auditCase(alignText, [
  { action: "layer.align_to_reference", target: { scope: "active_layer" }, params: { reference: "selection", horizontal: "left", vertical: "top" }, keys: "align" }
]).result.complete, false, "alignment reference and axes must match the request");
assert.deepStrictEqual(planner.buildRequirements("把画布上的当前图层旋转90度").find((item) => item.key === "rotate").expectedActions, ["layer.rotate"]);
assert.strictEqual(planner.buildRequirements("把当前图层对齐到画布").find((item) => item.key === "align").expectedParams.horizontal, undefined, "unspecified alignment axis must not be invented");

const saturationRequirement = planner.buildRequirements("把当前图层饱和度从20调整为30").find((item) => item.key === "color_adjustment");
assert.strictEqual(saturationRequirement.expectedParams.saturation, 30);
assert.strictEqual(planner.buildRequirements("把当前图层饱和度降低20").find((item) => item.key === "color_adjustment").expectedParams.saturation, -20);
assert.deepStrictEqual(planner.buildRequirements("把当前图层自然饱和度设为20").find((item) => item.key === "color_adjustment").expectedActions, ["adjustment.vibrance"]);
assert.strictEqual(planner.buildRequirements("给当前图层添加5像素高斯模糊").find((item) => item.key === "filter").expectedParams.radius, 5);
for (const text of ["把当前图层转换为智能对象", "把当前图层转为智能对象", "把当前图层变为智能对象", "把当前图层变成智能对象"]) {
  const requirement = planner.buildRequirements(text).find((item) => item.key === "convert_smart_object");
  assert(requirement, `${text} must build a dedicated smart-object requirement`);
  assert.strictEqual(planner.hasExplicitHighRiskAuthorization([requirement], { action: "layer.convert_to_smart_object" }), true);
}

const multiStyleText = "把文案组内文字字号改为24并且字体改为Arial";
const multiStyleRequirements = planner.buildRequirements(multiStyleText);
const multiStyleIntent = {
  operations: [{
    id: "style",
    action: "group.set_text_style",
    target: { scope: "layer_name", query: "文案" },
    params: { size: 24 },
    requirementIds: multiStyleRequirements.map((item) => item.id)
  }]
};
assert.strictEqual(engine.auditPlanningCompleteness(multiStyleText, multiStyleIntent, multiStyleRequirements).complete, false, "one group style field must not claim a second missing field");

const multiSelectedRequirements = planner.buildRequirements("把当前选中的所有图层隐藏");
assert.deepStrictEqual(multiSelectedRequirements.map((item) => item.key), ["visibility"]);
assert.deepStrictEqual(multiSelectedRequirements[0].expectedTarget, { scopes: ["active_layers"] });

for (const semanticGlobalText of ["把所有黄色奖杯改成灰色", "把所有黄色衣服改成灰色"]) {
  const bad = auditCase(semanticGlobalText, [
    { action: "selection.color_range", target: { scope: "document" }, params: { color: "#FFFF00", tolerance: 24 }, keys: "color_adjustment" },
    { action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#808080", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
  ]);
  assert.strictEqual(bad.result.complete, false, `${semanticGlobalText} must not become a global color range`);
}
for (const backgroundText of ["把背景变暗但人物保持不变", "把背景亮度降低20", "降低背景亮度20", "把衣服压暗"]) {
  const requirementsForBackground = planner.buildRequirements(backgroundText);
  const key = requirementsForBackground.find((item) => item.key === "color_adjustment") ? "color_adjustment" : "generic_modification";
  const bad = auditCase(backgroundText, [
    { action: "selection.subject", target: { scope: "document" }, params: {}, keys: key },
    { action: key === "color_adjustment" ? "adjustment.brightness_contrast" : "adjustment.hue_saturation", target: { scope: "document" }, params: key === "color_adjustment" ? { brightness: -20, contrast: 0 } : { hue: 0, saturation: 0, lightness: -20 }, keys: key }
  ]);
  assert.strictEqual(bad.result.complete, false, `${backgroundText} must not modify the subject without inverting or locating the intended target`);
}

const contrastText = "调整右边人物对比度为20";
assert.strictEqual(auditCase(contrastText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: { ...visualParams, description: "右边人物" }, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 0, contrast: 20 }, keys: "color_adjustment" }
]).result.complete, true, "localized contrast must use visual grounding and the requested value");
assert.strictEqual(auditCase(contrastText, [
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 0, contrast: -100 }, keys: "color_adjustment" }
]).result.complete, false, "localized contrast must reject missing grounding and a wrong value");

const exposureText = "把人物曝光度调整为20";
assert.strictEqual(auditCase(exposureText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: { ...visualParams, description: "人物" }, keys: "color_adjustment" },
  { action: "adjustment.exposure", target: { scope: "document" }, params: { exposure: 20, offset: 0, gamma: 1 }, keys: "color_adjustment" }
]).result.complete, true, "localized exposure must use visual grounding and the requested action/value");
assert.strictEqual(auditCase(exposureText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: { ...visualParams, description: "人物" }, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 20, contrast: 0 }, keys: "color_adjustment" }
]).result.complete, false, "exposure must not be replaced by another adjustment family");

const vagueText = "调整当前图层";
const vagueRequirements = planner.buildRequirements(vagueText);
assert.strictEqual(vagueRequirements[0].key, "generic_modification");
assert.strictEqual(engine.auditPlanningCompleteness(vagueText, {
  operations: [{
    id: "unsafe_guess",
    action: "layer.set_opacity",
    target: { scope: "layer_name", query: "其他层" },
    params: { opacity: 0 },
    requirementIds: [vagueRequirements[0].id]
  }],
  constraints: [],
  ambiguities: []
}, vagueRequirements).complete, false, "an unclassified vague modification must fail closed instead of authorizing an arbitrary edit");

const layerBrightnessText = "把当前图层亮度设为20";
assert.strictEqual(auditCase(layerBrightnessText, [
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 20, contrast: 0 }, keys: "color_adjustment" }
]).result.complete, false, "a layer-scoped adjustment must not silently reuse an unrelated existing selection");
assert.strictEqual(auditCase(layerBrightnessText, [
  { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 20, contrast: 0 }, keys: "color_adjustment" }
]).result.complete, true, "a layer-scoped adjustment may proceed after selecting that exact layer");

for (const [text, action, params, wrongParams] of [
  ["给当前选区建立5像素边界", "selection.border", { width: 5 }, { width: 50 }],
  ["按颜色容差32扩展当前选区", "selection.grow", { tolerance: 32, antiAlias: true }, { tolerance: 3, antiAlias: true }],
  ["扩展当前选区10像素", "selection.expand", { by: 10, applyAtCanvasBounds: false }, { by: 1, applyAtCanvasBounds: false }]
]) {
  const requirement = planner.buildRequirements(text).find((item) => item.key === "selection");
  assert(requirement, `${text} must create a concrete selection requirement`);
  assert.strictEqual(auditCase(text, [{ action, target: { scope: "document" }, params, keys: "selection" }]).result.complete, true);
  assert.strictEqual(auditCase(text, [{ action, target: { scope: "document" }, params: wrongParams, keys: "selection" }]).result.complete, false);
}

for (const [text, key, action, correctParams, wrongParams] of [
  ["把当前文字水平缩放80%", "text_scale", "text.set_horizontal_scale", { scale: 80 }, { scale: 200 }],
  ["把当前文字水平缩放从80%改为120%", "text_scale", "text.set_horizontal_scale", { scale: 120 }, { scale: 80 }],
  ["把当前文字左对齐", "text_style", "text.set_justification", { justification: "left" }, { justification: "right" }],
  ["关闭当前文字连字符", "text_style", "text.set_hyphenation", { enabled: false }, { enabled: true }],
  ["栅格化当前图层样式", "rasterize", "layer.rasterize", { target: "layer_style" }, { target: "entire_layer" }],
  ["把当前图层水平斜切10度", "skew", "layer.skew", { angleH: 10, angleV: 0 }, { angleH: 50, angleV: 50 }]
]) {
  assert.strictEqual(auditCase(text, [{ action, target: { scope: "active_layer" }, params: correctParams, keys: key }]).result.complete, true, `${text} correct value must pass`);
  assert.strictEqual(auditCase(text, [{ action, target: { scope: "active_layer" }, params: wrongParams, keys: key }]).result.complete, false, `${text} wrong value must fail`);
}
assert.strictEqual(auditCase("按当前选区裁剪文档", [
  { action: "document.crop", target: { scope: "document" }, params: { reference: "selection" }, keys: "document_crop" }
]).result.complete, true);
assert.strictEqual(auditCase("按当前选区裁剪文档", [
  { action: "document.trim", target: { scope: "document" }, params: { type: "transparent" }, keys: "document_crop" }
]).result.complete, false, "selection crop must not become trim");
assert.strictEqual(auditCase("去掉四周透明", [
  { action: "document.trim", target: { scope: "document" }, params: { type: "transparent", top: true, left: true, bottom: true, right: true }, keys: "document_crop" }
]).result.complete, true);
assert.strictEqual(auditCase("去掉四周透明", [
  { action: "document.crop", target: { scope: "document" }, params: { reference: "selection" }, keys: "document_crop" }
]).result.complete, false, "trim-transparent must not become selection crop");
assert.strictEqual(auditCase("把当前图层斜切10度", [
  { action: "layer.skew", target: { scope: "active_layer" }, params: { angleH: 10, angleV: 0 }, keys: "skew" }
]).result.complete, false, "ambiguous skew axis must fail closed");

assert.strictEqual(auditCase("把背景亮度降低20", [
  { action: "selection.subject", target: { scope: "document" }, params: {}, keys: "color_adjustment" },
  { action: "selection.invert", target: { scope: "document" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: -20, contrast: 0 }, keys: "color_adjustment" }
]).result.complete, true, "background adjustment must allow the explicit subject-then-invert chain");
assert.strictEqual(auditCase(contrastText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: { ...visualParams, description: "右边人物" }, keys: "color_adjustment" },
  { action: "selection.invert", target: { scope: "document" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 0, contrast: 20 }, keys: "color_adjustment" }
]).result.complete, false, "a specific foreground target must not be inverted");
assert.strictEqual(auditCase(layerBrightnessText, [
  { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
  { action: "selection.invert", target: { scope: "document" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.brightness_contrast", target: { scope: "document" }, params: { brightness: 20, contrast: 0 }, keys: "color_adjustment" }
]).result.complete, false, "a whole-layer adjustment must not invert the loaded layer selection");
for (const [text, params] of [
  ["把当前图层亮度设为20", { brightness: 20, contrast: -100 }],
  ["把当前图层对比度设为20", { brightness: -100, contrast: 20 }]
]) {
  assert.strictEqual(auditCase(text, [
    { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
    { action: "adjustment.brightness_contrast", target: { scope: "document" }, params, keys: "color_adjustment" }
  ]).result.complete, false, `${text} must reject an unrequested sibling adjustment`);
}
assert.strictEqual(auditCase("把当前图层饱和度设为20", [
  { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.hue_saturation", target: { scope: "document" }, params: { hue: 180, saturation: 20, lightness: -100 }, keys: "color_adjustment" }
]).result.complete, false);
assert.strictEqual(auditCase("把当前图层自然饱和度设为20", [
  { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.vibrance", target: { scope: "document" }, params: { vibrance: 20, saturation: -100 }, keys: "color_adjustment" }
]).result.complete, false);

const rectangleText = "建立一个左100、上120、右900、下1400像素的矩形选区";
assert.strictEqual(auditCase(rectangleText, [
  { action: "selection.rectangle", target: { scope: "document" }, params: { unit: "pixels", left: 100, top: 120, right: 900, bottom: 1400, mode: "replace" }, keys: "selection" }
]).result.complete, true);
assert.strictEqual(auditCase(rectangleText, [
  { action: "selection.rectangle", target: { scope: "document" }, params: { unit: "pixels", left: 0, top: 0, right: 10, bottom: 10, mode: "replace" }, keys: "selection" }
]).result.complete, false, "explicit selection geometry must be exact");
const pointPairRectangleText = "建立10×20到100×200矩形选区";
assert.strictEqual(auditCase(pointPairRectangleText, [
  { action: "selection.rectangle", target: { scope: "document" }, params: { unit: "pixels", left: 10, top: 20, right: 100, bottom: 200, mode: "replace" }, keys: "selection" }
]).result.complete, true, "two-point rectangle geometry must bind all four coordinates");
assert.strictEqual(auditCase(pointPairRectangleText, [
  { action: "selection.rectangle", target: { scope: "document" }, params: { unit: "pixels", left: 1000, top: 2000, right: 3000, bottom: 4000, mode: "replace" }, keys: "selection" }
]).result.complete, false, "two-point rectangle geometry must reject different coordinates");
assert.deepStrictEqual(planner.buildRequirements("建立一个矩形选区").find((item) => item.key === "selection").expectedActions, [], "a geometry selection without bounds must fail closed");

for (const [text, key] of [["按当前选区裁剪当前图层", "document_crop"], ["把当前图层裁剪到选区", "document_crop"], ["把图片图层大小改为800×600", "document_size"], ["导出当前图层为PNG", "export"], ["把素材组导出为PNG", "export"]]) {
  assert.strictEqual(planner.buildRequirements(text).some((item) => item.key === key), false, `${text} must not escalate a layer/group request into a document action`);
}

for (const text of ["把背景图层不透明度设为50%", "给背景图层添加5像素高斯模糊", "把背景图层混合模式设为正片叠底"]) {
  const requirement = planner.buildRequirements(text).find((item) => item.expectedTarget);
  assert(requirement && requirement.expectedTarget.scopes.includes("layer_name") && requirement.expectedTarget.query === "背景", `${text} must bind 背景`);
}
assert.deepStrictEqual(planner.buildRequirements("设置不透明度为50%").find((item) => item.key === "opacity").expectedTarget, { scopes: ["active_layer"] });
assert.deepStrictEqual(planner.buildRequirements("隐藏图层").find((item) => item.key === "visibility").expectedTarget, { scopes: ["active_layer"] });
assert.strictEqual(planner.buildRequirements("把当前图层透明度调到50%").some((item) => item.key === "color_adjustment"), false);
assert.strictEqual(planner.buildRequirements("把当前图层透明度调到50%").find((item) => item.key === "opacity").expectedParams.opacity, 50);

for (const [text, forbiddenKey] of [
  ["不要删除当前图层", "delete"],
  ["不要栅格化当前图层", "rasterize"],
  ["不要拼合文档", "flatten"],
  ["不要应用当前图层蒙版", "mask_apply"],
  ["不要把当前图层转换为智能对象", "convert_smart_object"],
  ["别隐藏当前图层", "visibility"],
  ["不要锁定当前图层", "lock"]
]) {
  assert.strictEqual(planner.buildRequirements(text).some((item) => item.key === forbiddenKey), false, `${text} must not become a positive authorization`);
}

for (const [text, allowedKey, forbiddenKeys] of [
  ["把当前文字改为“删除图层”", "text_content", ["delete"]],
  ["把当前文字改为“拼合文档”", "text_content", ["flatten"]],
  ["把当前文字改为“应用蒙版”", "text_content", ["mask_apply"]],
  ["创建一个内容为“拼合文档”的文字图层", "create_layer", ["flatten"]],
  ["创建一个名为“拼合文档”的图层组", "create_group", ["flatten"]],
  ["把当前图层名称改为红色", "rename", ["color_adjustment"]]
]) {
  const literalRequirements = planner.buildRequirements(text);
  assert(literalRequirements.some((item) => item.key === allowedKey), `${text} must keep its literal-string action`);
  for (const forbiddenKey of forbiddenKeys) assert.strictEqual(literalRequirements.some((item) => item.key === forbiddenKey), false, `${text} must not inject ${forbiddenKey}`);
}
assert(planner.buildRequirements("把当前文字内容改为红色").some((item) => item.key === "text_content"));
assert.strictEqual(planner.buildRequirements("把当前文字内容改为红色").some((item) => item.key === "text_color"), false);

for (const [text, expectedKeys] of [
  ["高斯模糊5px并锐化", ["filter", "filter"]],
  ["当前文字加粗并设为斜体", ["text_style", "text_style"]],
  ["行距24，字距50", ["text_spacing", "text_spacing"]],
  ["把当前图层隐藏并导出PNG", ["visibility", "export"]]
]) {
  assert.deepStrictEqual(planner.buildRequirements(text).map((item) => item.key), expectedKeys, `${text} must produce one requirement per effect`);
}
assert.deepStrictEqual(planner.buildRequirements("把背景图层隐藏，同时不透明度设为50%").find((item) => item.key === "opacity").expectedTarget, { scopes: ["layer_name"], query: "背景" });
assert.deepStrictEqual(planner.buildRequirements("复制当前图层，然后重命名为备份").find((item) => item.key === "rename").expectedTarget, { scopes: ["operation_result"] });
assert.deepStrictEqual(planner.buildRequirements("新建空白图层，然后重命名为素材").find((item) => item.key === "rename").expectedTarget, { scopes: ["operation_result"] });
const twoNamedActions = planner.buildRequirements("显示名为“底图”的图层并删除名为“文案”的图层");
assert.deepStrictEqual(twoNamedActions.find((item) => item.key === "visibility").expectedTarget, { scopes: ["layer_name"], query: "底图" });
assert.deepStrictEqual(twoNamedActions.find((item) => item.key === "delete").expectedTarget, { scopes: ["layer_name"], query: "文案" });

assert.strictEqual(auditCase("取消隐藏当前图层", [
  { action: "layer.set_visibility", target: { scope: "active_layer" }, params: { visible: false }, keys: "visibility" }
]).result.complete, false);
assert.strictEqual(auditCase("取消锁定当前图层", [
  { action: "layer.set_lock", target: { scope: "active_layer" }, params: { lock: "all", locked: true }, keys: "lock" }
]).result.complete, false);
assert.strictEqual(auditCase("取消当前文字加粗", [
  { action: "text.set_faux_bold", target: { scope: "active_layer" }, params: { enabled: true }, keys: "text_style" }
]).result.complete, false);

const crossClauseText = "把左边奖杯改成红色，然后把右边帽子改成蓝色";
const crossRequirements = planner.buildRequirements(crossClauseText);
const crossIntent = {
  operations: [
    { id: "select_left", action: "selection.visual_object", target: { scope: "document" }, params: { description: "左边奖杯" }, requirementIds: [crossRequirements[0].id] },
    { id: "red", action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, requirementIds: [crossRequirements[0].id] },
    { id: "blue", action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#0000FF", opacity: 100, blendMode: "normal" }, requirementIds: [crossRequirements[1].id] }
  ], constraints: [], ambiguities: []
};
assert.strictEqual(engine.auditPlanningCompleteness(crossClauseText, crossIntent, crossRequirements).complete, false, "each semantic clause must own its selector");

const texturedText = "把黑色图标改成灰色，然后把红色衣服改成蓝色";
const texturedRequirements = planner.buildRequirements(texturedText);
const texturedIntent = {
  operations: [
    { id: "icon_select", action: "selection.visual_object", target: { scope: "document" }, params: { description: "黑色图标" }, requirementIds: [texturedRequirements[0].id] },
    { id: "icon_gray", action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#808080", opacity: 100, blendMode: "normal" }, requirementIds: [texturedRequirements[0].id] },
    { id: "shirt_select", action: "selection.visual_object", target: { scope: "document" }, params: { description: "红色衣服" }, requirementIds: [texturedRequirements[1].id] },
    { id: "shirt_blue", action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#0000FF", opacity: 100, blendMode: "normal" }, requirementIds: [texturedRequirements[1].id] }
  ], constraints: [], ambiguities: []
};
assert.strictEqual(engine.auditPlanningCompleteness(texturedText, texturedIntent, texturedRequirements).complete, false, "each recolor clause must enforce its own blend mode");

const duplicateMoveText = "当前图层向右移动10，然后向右移动10";
const duplicateMoveRequirements = planner.buildRequirements(duplicateMoveText);
const oneMoveForTwo = {
  operations: [{ id: "move_once", action: "layer.move_by", target: { scope: "active_layer" }, params: { deltaX: 10, deltaY: 0 }, requirementIds: duplicateMoveRequirements.map((item) => item.id) }],
  constraints: [], ambiguities: []
};
assert.strictEqual(engine.auditPlanningCompleteness(duplicateMoveText, oneMoveForTwo, duplicateMoveRequirements).complete, false, "one effect cannot satisfy two repeated requirements");

assert.strictEqual(auditCase("把图像宽度改为1200像素", [
  { action: "document.resize_image", target: { scope: "document" }, params: { width: 100 }, keys: "document_size" }
]).result.complete, false);
assert.strictEqual(auditCase("按左10上20右100下200裁剪文档", [
  { action: "document.crop", target: { scope: "document" }, params: { reference: "bounds", unit: "pixels", left: 0, top: 0, right: 50, bottom: 50 }, keys: "document_crop" }
]).result.complete, false);
assert.strictEqual(auditCase("裁掉顶部透明像素", [
  { action: "document.trim", target: { scope: "document" }, params: { type: "transparent", top: true, left: true, bottom: true, right: true }, keys: "document_crop" }
]).result.complete, false);
for (const text of ["裁掉左边100像素", "裁掉顶部20像素", "裁剪文档"]) {
  const cropRequirement = planner.buildRequirements(text).find((item) => item.key === "document_crop");
  assert(cropRequirement, `${text} must remain visible as an unresolved requirement`);
  assert.deepStrictEqual(cropRequirement.expectedActions, [], `${text} must fail closed until its crop bounds are explicit`);
}
for (const text of ["画布尺寸改为1200像素", "图像大小调整为1200"]) {
  const sizeRequirement = planner.buildRequirements(text).find((item) => item.key === "document_size");
  assert(sizeRequirement, `${text} must remain visible as an unresolved requirement`);
  assert.deepStrictEqual(sizeRequirement.expectedActions, [], `${text} must not guess which dimension the number describes`);
}
assert.strictEqual(auditCase("把图像宽度改为1200像素", [
  { action: "document.resize_image", target: { scope: "document" }, params: { width: 1200, height: 900 }, keys: "document_size" }
]).result.complete, false, "a single-axis resize must not smuggle in an unrequested second dimension");
assert.strictEqual(auditCase("把图像大小等比改为1200×900", [
  { action: "document.resize_image", target: { scope: "document" }, params: { width: 1200, height: 900, constrainProportions: false }, keys: "document_size" }
]).result.complete, false, "explicit proportional resize must bind constrainProportions=true");
assert.strictEqual(auditCase("把图像大小改为1200×900", [
  { action: "document.resize_image", target: { scope: "document" }, params: { width: 1200, height: 900, constrainProportions: true }, keys: "document_size" }
]).result.complete, false, "an exact two-axis size defaults to unconstrained dimensions");
assert.strictEqual(auditCase("裁掉透明像素", [
  { action: "document.trim", target: { scope: "document" }, params: { type: "transparent", top: false, left: false, bottom: false, right: false }, keys: "document_crop" }
]).result.complete, false, "unspecified transparent trim means all four sides, not a no-op");

assert.strictEqual(auditCase("给当前图层添加动感模糊，距离20像素", [
  { action: "filter.motion_blur", target: { scope: "active_layer" }, params: { distance: 20, angle: 90, useSelection: false }, keys: "filter" }
]).result.complete, false);
assert.strictEqual(auditCase("选中所有红色像素，容差10", [
  { action: "selection.color_range", target: { scope: "document" }, params: { color: "#FF0000", tolerance: 10, softness: 255 }, keys: "selection" }
]).result.complete, false);
assert(planner.buildRequirements("给当前图层添加20%杂色").some((item) => item.key === "filter"));
assert.strictEqual(auditCase("给当前图层添加20%杂色", [
  { action: "filter.add_noise", target: { scope: "active_layer" }, params: { amount: 20, distribution: "gaussian", monochromatic: true, useSelection: false }, keys: "filter" }
]).result.complete, false, "unspecified noise options must remain at the documented uniform/color defaults");
assert.strictEqual(auditCase("当前图层USM锐化数量100%", [
  { action: "filter.unsharp_mask", target: { scope: "active_layer" }, params: { amount: 100, radius: 1000, threshold: 255, useSelection: false }, keys: "filter" }
]).result.complete, false, "unspecified USM radius/threshold must remain at the documented defaults");
assert.strictEqual(auditCase("把当前文字首行缩进设为10点", [
  { action: "text.set_paragraph_spacing", target: { scope: "active_layer" }, params: { firstLineIndent: 10, leftIndent: 100, rightIndent: 100, spaceBefore: 100, spaceAfter: 100 }, keys: "text_spacing" }
]).result.complete, false, "a paragraph-spacing edit must not change unrequested sibling properties");

for (const text of [
  "如果这是空图层就删除当前图层",
  "只有当前图层为空时才删除当前图层",
  "如果确认没问题就拼合文档"
]) {
  const conditionalRequirements = planner.buildRequirements(text);
  assert.strictEqual(conditionalRequirements.some((item) => ["delete", "flatten"].includes(item.key)), false,
    `${text} must not authorize an unconditional destructive operation`);
}

for (const [text, allowedKey, forbiddenKey] of [
  ["把拼合文档图层隐藏", "visibility", "flatten"],
  ["把拼合文档图层的不透明度设为50%", "opacity", "flatten"],
  ["把删除图层的不透明度设为50%", "opacity", "delete"]
]) {
  const namedRequirements = planner.buildRequirements(text);
  assert(namedRequirements.some((item) => item.key === allowedKey), `${text} must retain its requested metadata edit`);
  assert.strictEqual(namedRequirements.some((item) => item.key === forbiddenKey), false, `${text} must treat the layer name as data`);
}

for (const text of ["怎么删除当前图层？", "如何拼合文档？", "请告诉我如何栅格化当前图层"]) {
  assert.deepStrictEqual(planner.buildRequirements(text), [], `${text} must stay informational`);
  assert.strictEqual(engine.parseFastInstruction(text), null, `${text} must not produce deterministic edit operations`);
}

assert.strictEqual(auditCase(recolorText, [
  { action: "selection.visual_object", target: { scope: "document" }, params: visualParams, keys: "color_adjustment" },
  { action: "selection.load_layer", target: { scope: "active_layer" }, params: {}, keys: "color_adjustment" },
  { action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
]).result.complete, false, "a later whole-layer selector must not overwrite a specific visual-object selector");

for (const wrongVisualParams of [
  { ...visualParams, description: "右下角奖杯和左上角帽子" },
  { ...visualParams, semanticScope: "subpart" },
  { ...visualParams, unit: "percent", targetBox: { left: 0, top: 0, right: 100, bottom: 100 }, searchRegion: { left: 0, top: 0, right: 100, bottom: 100 }, seed: { x: 50, y: 50 } }
]) {
  assert.strictEqual(auditCase(recolorText, [
    { action: "selection.visual_object", target: { scope: "document" }, params: wrongVisualParams, keys: "color_adjustment" },
    { action: "adjustment.colorize", target: { scope: "document" }, params: { color: "#FF0000", opacity: 100, blendMode: "normal" }, keys: "color_adjustment" }
  ]).result.complete, false, "visual descriptions, semantic scope, and directional geometry must remain bound to the request");
}

for (const text of ["隐藏当前层", "显示选中层", "删除背景层"]) {
  assert.strictEqual(engine.requiresVisualGrounding(text), false, `${text} is a structured layer operation, not a visual-object request`);
}

for (const text of ["把当前文字颜色设成红色", "把当前文字颜色设置成红色", "把当前文字颜色换为红色"]) {
  const requirement = planner.buildRequirements(text).find((item) => item.key === "text_color");
  assert(requirement, `${text} must create a text-color requirement`);
  assert.strictEqual(requirement.expectedParams.color, "#FF0000");
}
assert.strictEqual(planner.buildRequirements("将图层颜色标记改成蓝色").some((item) => item.key === "color_adjustment"), false,
  "an unsupported layer-panel color label must not become a pixel recolor");

assert.strictEqual(planner.buildRequirements("新建两个空白图层").find((item) => item.key === "create_layer").expectedParams.count, 2);
assert.strictEqual(planner.buildRequirements("复制当前图层三份").find((item) => item.key === "duplicate").expectedParams.count, 3);

for (const [text, expectedContent] of [
  ["新建一个文字图层，文字是“拼合文档”", "拼合文档"],
  ["新建一个文字图层，写上“新品上市”", "新品上市"],
  ["创建一个内容：“活动标题”的文字图层", "活动标题"]
]) {
  const createRequirement = planner.buildRequirements(text).find((item) => item.key === "create_layer");
  assert(createRequirement, `${text} must keep the text-create requirement`);
  assert.strictEqual(createRequirement.expectedParams.content, expectedContent, `${text} must bind the literal content exactly`);
  assert.strictEqual(planner.buildRequirements(text).some((item) => item.key === "flatten"), false, `${text} must not execute literal content`);
}

const loadNamedText = "把名为“A”的图层透明区域载入选区";
assert.strictEqual(auditCase(loadNamedText, [
  { action: "selection.load_layer", target: { scope: "layer_name", query: "B" }, params: {}, keys: "selection_load" }
]).result.complete, false, "selection.load_layer must honor its named source layer");

const horizontalAlignText = "把当前图层水平居中对齐到画布";
const horizontalAlignRequirements = planner.buildRequirements(horizontalAlignText);
assert.strictEqual(horizontalAlignRequirements.some((item) => item.key === "text_style"), false,
  "layer/canvas alignment must not become paragraph alignment");
assert.deepStrictEqual(horizontalAlignRequirements.find((item) => item.key === "align").expectedParams, {
  reference: "canvas", padding: 0, allowUpscale: false, horizontal: "center"
});
assert.strictEqual(auditCase(horizontalAlignText, [
  { action: "layer.align_to_reference", target: { scope: "active_layer" }, params: { reference: "canvas", padding: 0, allowUpscale: false, horizontal: "center", vertical: "middle" }, keys: "align" }
]).result.complete, false, "horizontal-only alignment must not add an unrequested vertical move");

assert.strictEqual(auditCase("选择整个画面的主体", [
  { action: "selection.subject", target: { scope: "document" }, params: { sampleAllLayers: false }, keys: "selection" }
]).result.complete, false, "whole-canvas Select Subject must sample the composite image");
assert.strictEqual(auditCase("选择当前图层的主体", [
  { action: "selection.subject", target: { scope: "document" }, params: { sampleAllLayers: false }, keys: "selection" }
]).result.complete, true, "layer-scoped Select Subject must stay on the active layer");
assert.strictEqual(auditCase(rectangleText, [
  { action: "selection.rectangle", target: { scope: "document" }, params: { unit: "pixels", left: 100, top: 120, right: 900, bottom: 1400, mode: "replace", feather: 1000, antiAlias: false }, keys: "selection" }
]).result.complete, false, "exact geometry must not smuggle in unrequested feathering or disable anti-aliasing");
assert.strictEqual(auditCase("羽化当前选区10像素", [
  { action: "selection.feather", target: { scope: "document" }, params: { by: 10, applyAtCanvasBounds: true }, keys: "selection" }
]).result.complete, false, "selection modifiers must not enable canvas-edge behavior unless requested");
assert.strictEqual(auditCase("按颜色容差32扩展当前选区", [
  { action: "selection.grow", target: { scope: "document" }, params: { tolerance: 32, antiAlias: false }, keys: "selection" }
]).result.complete, false, "selection grow must keep anti-aliasing enabled unless explicitly disabled");

for (const [text, destination] of [["把当前图层移到组“素材”中", "素材"], ["把当前图层移到图层组素材中", "素材"]]) {
  const moveRequirement = planner.buildRequirements(text).find((item) => item.key === "move_to_group");
  assert.strictEqual(moveRequirement.expectedParams.destinationGroupName, destination);
  assert.strictEqual(auditCase(text, [
    { action: "layer.move_to_group", target: { scope: "active_layer" }, params: { groupName: "删除组" }, keys: "move_to_group" }
  ]).result.complete, false, `${text} must not move to an arbitrary group`);
}

for (const [text, key, expectedName, action, params] of [
  ["把当前文字换成Arial字体", "text_font", "Arial", "text.set_font", { font: "Arial" }],
  ["把当前文字设成微软雅黑字体", "text_font", "微软雅黑", "text.set_font", { font: "微软雅黑" }],
  ["将字体换为Arial", "text_font", "Arial", "text.set_font", { font: "Arial" }],
  ["把当前文字改成32号字", "text_size", 32, "text.set_size", { size: 32 }],
  ["把当前文字设成24点", "text_size", 24, "text.set_size", { size: 24 }],
  ["把当前文字改成80pt", "text_size", 80, "text.set_size", { size: 80 }]
]) {
  const styleRequirement = planner.buildRequirements(text).find((item) => item.key === key);
  assert(styleRequirement, `${text} must be parsed as ${key}`);
  assert.strictEqual(styleRequirement.expectedParams[key === "text_font" ? "font" : "size"], expectedName);
  assert.strictEqual(planner.buildRequirements(text).some((item) => item.key === "text_content"), false, `${text} must not replace visible content`);
  assert.strictEqual(auditCase(text, [{ action, target: { scope: "active_layer" }, params, keys: key }]).result.complete, true);
}

const afterConnector = planner.buildRequirements("显示底图图层后删除文案图层");
assert.deepStrictEqual(afterConnector.map((item) => item.key), ["visibility", "delete"]);
assert.deepStrictEqual(afterConnector.find((item) => item.key === "delete").expectedTarget, { scopes: ["layer_name"], query: "文案" });
assert.deepStrictEqual(planner.buildRequirements("先复制当前图层，之后把副本重命名为备份").find((item) => item.key === "rename").expectedTarget, { scopes: ["operation_result"] });
assert.deepStrictEqual(planner.buildRequirements("把当前文字加粗和斜体").map((item) => item.key), ["text_style", "text_style"]);
assert.deepStrictEqual(planner.buildRequirements("把当前文字行距设为24和字距设为50").map((item) => item.key), ["text_spacing", "text_spacing"]);

const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
const capabilities = fs.readFileSync(path.join(sourceRoot, "capabilities.js"), "utf8");
const engineSource = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");

assert(main.includes("SELECTION_PROVIDER_ACTIONS"));
assert(main.includes("!runtime.visualConfirmedSteps.has(index) || !step.params.selectionSessionToken"), "every selection provider must need confirmation and a locked session");
assert(main.includes("selectionSessions.captureCurrent"), "candidate selection must be captured as an authoritative session");
assert(main.includes("selectionSessions.applyPolygon"), "panel lasso corrections must update the authoritative session");
assert(main.includes("snapshotAndRebaseSelection"), "manual selection corrections must rebase the execution fingerprint");
assert(capabilities.includes("const token = context && context.params && context.params.selectionSessionToken"));
assert(capabilities.includes("const session = await selectionSessions.restore(token)"), "confirmed execution must restore the locked selection, not recompute it");
assert(capabilities.includes("authoritativeSelection: true"));
assert(capabilities.includes('resultScope: "subtree"'), "new group descendants must be explicitly authorized as a result subtree");
assert(capabilities.includes('id: "layer.duplicate"') && capabilities.includes('authorizedScope: "none"'), "duplicate must protect its source and authorize only the read-back result subtree");
assert(capabilities.includes('id: "layer.delete"') && capabilities.includes('risk: "high"'), "destructive layer operations must require separate confirmation");
assert(engineSource.includes('result.resultScope === "subtree"'), "engine must expand declared result subtrees after readback");
assert(engineSource.includes('capability.authorizedScope === "none"'), "engine must support capabilities that protect their source target as an invariant");
assert(engineSource.includes('evidenceScope: "non_target_pixels_and_user_masks"'));
assert(engineSource.includes('vectorMasks: "not_sampled"'), "vector mask paths must not be presented as sampled evidence");

const executeIndex = engineSource.indexOf("result = await capability.execute");
const protectedAuditIndex = engineSource.indexOf("verifyProtectedLayers(stepState, afterState", executeIndex);
const capabilityVerifyIndex = engineSource.indexOf("await capability.verify", protectedAuditIndex);
assert(executeIndex >= 0 && protectedAuditIndex > executeIndex && capabilityVerifyIndex > protectedAuditIndex,
  "execution must be followed by protected-state audit and capability-specific readback");
assert(engineSource.includes("rollbackVerification"), "rollback must report its verification strength");
assert(engineSource.includes("无法证明文档和选区已恢复"), "rollback must fail loudly when restoration cannot be proven");

const executePlanStart = main.indexOf("async function executePlan()");
const executePlanEnd = main.indexOf("\nasync function undoLast", executePlanStart);
const executePlanBody = main.slice(executePlanStart, executePlanEnd);
assert(executePlanStart >= 0 && executePlanEnd > executePlanStart, "execute UI handler must remain inspectable");
const strictEngineCallIndex = executePlanBody.indexOf("engine.execute(");
assert(strictEngineCallIndex >= 0 && executePlanBody.indexOf("setBusy(true)") < strictEngineCallIndex,
  "the UI must become busy before any execution gate or Photoshop mutation starts");
assert(executePlanBody.lastIndexOf("setBusy(false)") > strictEngineCallIndex,
  "the UI busy gate must be released in the execution finally path");
const documentPollingStart = main.indexOf("async function refreshWhenDocumentChanges()");
const documentPollingEnd = main.indexOf("\nfunction renderPlan", documentPollingStart);
const documentPollingBody = main.slice(documentPollingStart, documentPollingEnd);
assert(documentPollingBody.includes("if (runtime.busy || runtime.refreshingState) return"),
  "document polling must not replace the confirmed runtime snapshot while execution is busy");
assert(/runtime\.plan/.test(documentPollingBody),
  "document polling must not overwrite runtime.snapshot while a confirmed plan is waiting to execute");
assert(main.includes("runtime.documentSignature = documentSignature()"),
  "successful state refresh must rebase the UI document signature");

function executionState(options = {}) {
  const bounds = options.bounds === undefined
    ? { left: 1180, top: 1550, right: 1910, bottom: 3230 }
    : options.bounds;
  const activeIds = options.activeIds || [301];
  return {
    hasDocument: true,
    fingerprint: options.fingerprint || "fingerprint-confirmed",
    contentFingerprint: options.contentFingerprint || "content-v1",
    document: {
      id: options.documentId == null ? 17 : options.documentId,
      title: "selection-flow.psd",
      width: 2160,
      height: 3840,
      resolution: 300,
      historyStateId: options.historyStateId == null ? 10 : options.historyStateId,
      compositeDigest: options.compositeDigest || "composite-v1"
    },
    selectionBounds: bounds,
    selectionDigest: options.selectionDigest === undefined ? "selection-digest-1" : options.selectionDigest,
    activeLayers: activeIds.map((id) => ({ id, name: `layer-${id}`, kind: "pixel" })),
    flatLayers: [],
    integrity: { compositeDigestAvailable: true, selectionDigestAvailable: true, safetyStateComplete: true }
  };
}

function confirmedSelectionPlan(engineForCase) {
  const before = executionState({
    fingerprint: "fingerprint-before-candidate",
    historyStateId: 8,
    bounds: null,
    selectionDigest: "none"
  });
  const confirmed = executionState({ fingerprint: "fingerprint-confirmed-first-read", historyStateId: 9 });
  const stableConfirmation = executionState({ fingerprint: "fingerprint-confirmed-stable", historyStateId: 10 });
  const plan = {
    id: "selection-execute-regression",
    version: testVersion.replace(/^v/, ""),
    route: "standard",
    summary: "locked selection followed by a local adjustment",
    constraints: [],
    sourceDocumentId: 17,
    sourceFingerprint: before.fingerprint,
    sourceContentFingerprint: before.contentFingerprint,
    sourceActiveLayerIds: [301],
    restoreSelectionHadSelection: false,
    restoreSelectionSessionToken: null,
    restoreSelectionDocumentId: 17,
    highRiskStepIds: [],
    confirmedHighRiskStepIds: [],
    steps: [
      {
        id: "step-selection",
        operationId: "select-object",
        action: "selection.visual_object",
        label: "locked visual selection",
        risk: "medium",
        reversible: true,
        target: { kind: "document", id: 17, name: "selection-flow.psd", path: "selection-flow.psd" },
        params: { selectionSessionToken: "selection-session-1", description: "右下角奖杯" }
      },
      {
        id: "step-adjustment",
        operationId: "desaturate-object",
        action: "adjustment.hue_saturation",
        label: "desaturate locked object",
        risk: "low",
        reversible: true,
        target: { kind: "document", id: 17, name: "selection-flow.psd", path: "selection-flow.psd" },
        params: { hue: 0, saturation: -100, lightness: 0 }
      }
    ]
  };
  const firstRebase = engineForCase.rebasePlanAfterSelection(plan, before, confirmed, {
    source: "confirmed-selection-regression",
    sessionId: "selection-session-1",
    selectionDigest: confirmed.selectionDigest
  });
  const finalRebase = engineForCase.rebasePlanAfterSelection(firstRebase, confirmed, stableConfirmation, {
    source: "confirmed-selection-stable-read",
    sessionId: "selection-session-1",
    selectionDigest: stableConfirmation.selectionDigest
  });
  assert.strictEqual(finalRebase.sourceFingerprint, stableConfirmation.fingerprint,
    "confirmation must lock the final stable Photoshop fingerprint before execution is enabled");
  assert.strictEqual(finalRebase.selectionAuthority.selectionDigest, stableConfirmation.selectionDigest);
  return finalRebase;
}

async function runExecutionGateRegressions() {
  const understoodStructuredTarget = await engine.understand(
    structuredBodyInstruction,
    { document: { id: 1, width: 1000, height: 1000 }, activeLayers: [], flatLayers: [] },
    async () => JSON.stringify({
      operations: [
        {
          id: "select_body",
          action: "selection.visual_object",
          target: { scope: "document" },
          params: {
            description: "黄色玉米人物的身体，排除嘴和绿色叶子",
            semanticScope: "subpart",
            unit: "percent",
            targetBox: { left: 28, top: 35, right: 58, bottom: 82 },
            searchRegion: { left: 18, top: 22, right: 68, bottom: 92 },
            seed: { x: 43, y: 58 },
            excludePoints: [{ x: 47, y: 43 }],
            confidence: 0.82
          },
          requirementIds: ["req_1"]
        },
        {
          id: "recolor_body",
          action: "adjustment.colorize",
          target: { scope: "document" },
          params: { color: "#00B7C7", opacity: 100, blendMode: "color" },
          requirementIds: ["req_1"]
        }
      ]
    }),
    { forceModel: true }
  );
  const canonicalVisual = understoodStructuredTarget.intent.operations[0].params;
  assert.strictEqual(canonicalVisual.description, "黄色玉米人物的身体", "the user target must replace model-added landmarks");
  assert.deepStrictEqual(Array.from(canonicalVisual.excludePoints), [], "model-added exclusions must be cleared without user spatial protection");
  assert.strictEqual(canonicalVisual.visualContract.target.part, "身体");
  assert(canonicalVisual.visualContract.preserveAppearance.includes("outline"));
  assert(canonicalVisual.visualContract.preserveAppearance.includes("pattern"));

  const confirmedExact = executionState({
    fingerprint: "fingerprint-confirmed-stable",
    historyStateId: 10
  });
  const finalState = executionState({
    fingerprint: "fingerprint-after-adjustment",
    contentFingerprint: "content-v2",
    compositeDigest: "composite-v2",
    historyStateId: 11
  });
  const finalStateWithoutSelection = executionState({
    fingerprint: "fingerprint-after-adjustment-selection-restored",
    contentFingerprint: "content-v2",
    compositeDigest: "composite-v2",
    historyStateId: 11,
    bounds: null,
    selectionDigest: "none"
  });
  const happyHarness = loadExecutionHarness([
    confirmedExact,
    confirmedExact,
    confirmedExact,
    finalState,
    finalStateWithoutSelection,
    finalStateWithoutSelection
  ]);
  const happyPlan = confirmedSelectionPlan(happyHarness.engine);
  const happyOutcome = await happyHarness.engine.execute(happyPlan);
  assert.strictEqual(happyHarness.calls.selectionExecute, 1,
    "an exactly matching confirmed authoritative selection must execute");
  assert.strictEqual(happyHarness.calls.adjustmentExecute, 1,
    "the local adjustment must run after the stable confirmation fingerprint is locked");
  assert.strictEqual(happyOutcome.records.length, 2);

  const rejectAtFirstGate = async (name, firstState) => {
    const harness = loadExecutionHarness([firstState]);
    const plan = confirmedSelectionPlan(harness.engine);
    await assert.rejects(() => harness.engine.execute(plan), undefined, name);
    assert.strictEqual(harness.calls.modal, 0, `${name}: failure must happen before Photoshop modal execution`);
    assert.strictEqual(harness.calls.selectionExecute, 0, `${name}: locked selection must not be restored after rejection`);
    assert.strictEqual(harness.calls.adjustmentExecute, 0, `${name}: adjustment must not run after rejection`);
  };

  await rejectAtFirstGate("history changes after stable confirmation must invalidate the plan", executionState({
    fingerprint: "fingerprint-history-changed-after-confirmation",
    historyStateId: 11
  }));
  await rejectAtFirstGate("content changes must invalidate the confirmed plan", executionState({
    fingerprint: "fingerprint-content-changed",
    contentFingerprint: "content-v2",
    compositeDigest: "composite-v2"
  }));
  await rejectAtFirstGate("document changes must invalidate the confirmed plan", executionState({
    fingerprint: "fingerprint-other-document",
    documentId: 99
  }));
  await rejectAtFirstGate("selection digest changes must invalidate the confirmed authority", executionState({
    fingerprint: "fingerprint-selection-digest-changed",
    selectionDigest: "selection-digest-2"
  }));
  await rejectAtFirstGate("selection bounds changes must invalidate the confirmed authority", executionState({
    fingerprint: "fingerprint-selection-bounds-changed",
    bounds: { left: 10, top: 20, right: 40, bottom: 60 }
  }));
  await rejectAtFirstGate("active layer changes must invalidate the confirmed plan", executionState({
    fingerprint: "fingerprint-active-layer-changed",
    activeIds: [999]
  }));

  const modalGateDrift = executionState({
    fingerprint: "fingerprint-modal-gate-drift",
    historyStateId: 12
  });
  const modalGateHarness = loadExecutionHarness([confirmedExact, modalGateDrift]);
  await assert.rejects(
    () => modalGateHarness.engine.execute(confirmedSelectionPlan(modalGateHarness.engine)),
    undefined,
    "state drift after the trusted full baseline must be rejected by the lightweight modal gate"
  );
  assert.strictEqual(modalGateHarness.calls.modal, 1);
  assert.strictEqual(modalGateHarness.calls.selectionExecute, 0);
  assert.strictEqual(modalGateHarness.calls.adjustmentExecute, 0);
}

runExecutionGateRegressions().then(() => {
  console.log(`${testVersion} bidirectional planning audit, authoritative selection execution gates, protected-state readback, and rollback-proof contracts passed`);
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
