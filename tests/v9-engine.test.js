"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.3";
const protocol = require(`../uxp-${testVersion}/protocol.js`);
const planner = require(`../uxp-${testVersion}/planner.js`);
const strictRequirementIds = /^v9\.(?:[7-9]|\d{2,})$/.test(testVersion);

function normalizeTestIntent(value) {
  if (!strictRequirementIds) return protocol.normalizeIntent(value);
  return protocol.normalizeIntent({
    ...value,
    operations: (value.operations || []).map((item, index) => ({
      ...item,
      requirementIds: Array.isArray(item.requirementIds) && item.requirementIds.length
        ? item.requirementIds
        : [`test_requirement_${index + 1}`]
    }))
  });
}

function loadEngine() {
  const source = fs.readFileSync(path.resolve(__dirname, `../uxp-${testVersion}/engine.js`), "utf8");
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
      snapshot: async () => ({})
    },
    PhotoshopAssistantV8Capabilities: {
      catalog: () => [...protocol.ACTIONS].map((id) => ({ id })),
      get: () => ({ label: "Test capability", preflight() {} }),
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

function operationsFor(engine, instruction) {
  const parsed = engine.parseFastInstruction(instruction);
  assert.ok(parsed, `Deterministic parser returned null: ${instruction}`);
  return Array.from(parsed.operations);
}

function assertFast(engine, instruction, action, params) {
  const operations = operationsFor(engine, instruction);
  assert.strictEqual(operations.length, 1, instruction);
  assert.strictEqual(operations[0].action, action, instruction);
  for (const [key, expected] of Object.entries(params || {})) {
    assert.strictEqual(operations[0].params[key], expected, `${instruction}: ${key}`);
  }
}

const engine = loadEngine();

assertFast(
  engine,
  "新建一个名为“修图层”的空白像素图层。",
  "layer.create_pixel",
  { name: "修图层" }
);
assertFast(
  engine,
  "新建一个名为“标题”的文字图层，内容为“活动开始”。",
  "text.create",
  { name: "标题", content: "活动开始" }
);
assertFast(
  engine,
  "把当前图层重命名为“主体测试”。",
  "layer.rename",
  { name: "主体测试" }
);
assertFast(
  engine,
  "把当前图层的不透明度改成63%",
  "layer.set_opacity",
  { opacity: 63 }
);
assertFast(
  engine,
  "保持当前文字层内容不变，并将其基线偏移设为3点",
  "text.set_baseline_shift",
  { baselineShift: 3 }
);

const completeTextEdit = operationsFor(
  engine,
  "把当前文字改为“暑期活动”，字号80点，颜色#FF0000。"
);
assert.deepStrictEqual(
  completeTextEdit.map((item) => item.action),
  ["text.set_content", "text.set_size", "text.set_color"]
);
assert.strictEqual(completeTextEdit[0].params.content, "暑期活动");
assert.strictEqual(completeTextEdit[1].params.size, 80);
assert.strictEqual(completeTextEdit[2].params.color, "#FF0000");

for (const [instruction, action, params] of [
  ["把当前图层的不透明度改成63%", "layer.set_opacity", { opacity: 63 }],
  ["把当前图层填充不透明度改为61%", "layer.set_fill_opacity", { fillOpacity: 61 }],
  ["把当前图层向右移动20像素，向下移动10像素", "layer.move_by", { deltaX: 20, deltaY: 10 }],
  ["把当前图层宽高缩放为80%", "layer.scale", { scaleX: 80, scaleY: 80 }],
  ["把当前图层顺时针旋转15度", "layer.rotate", { angle: 15 }],
  ["水平翻转当前图层", "layer.flip", { axis: "horizontal" }],
  ["把当前图层水平斜切10度", "layer.skew", { angleH: 10, angleV: 0 }],
  ["栅格化当前图层", "layer.rasterize", { target: "entire_layer" }],
  ["解锁当前图层", "layer.set_lock", { lock: "all", locked: false }],
  ["把当前图层居中对齐到画布", "layer.align_to_reference", {
    reference: "canvas", horizontal: "center", vertical: "middle"
  }],
  ["把当前图层等比缩放放入选区，四周留20像素", "layer.fit_to_reference", {
    reference: "selection", padding: 20
  }],
  ["把当前文字字体改为ArialMT", "text.set_font", { font: "ArialMT" }],
  ["把当前文字基线偏移改为3点", "text.set_baseline_shift", { baselineShift: 3 }],
  ["把当前文字水平缩放改为92%", "text.set_horizontal_scale", { scale: 92 }],
  ["把当前文字垂直缩放改为88%", "text.set_vertical_scale", { scale: 88 }],
  ["关闭当前文字连字符", "text.set_hyphenation", { enabled: false }],
  ["选择整个画布", "selection.select_all", {}],
  ["取消当前选区", "selection.deselect", {}],
  ["反选当前选区", "selection.invert", {}],
  ["把当前选区收缩5像素", "selection.contract", { by: 5 }],
  ["给当前选区建立8像素的边界", "selection.border", { width: 8 }],
  ["按颜色容差32扩展当前选区", "selection.grow", { tolerance: 32 }],
  ["把当前选区平滑5像素", "selection.smooth", { radius: 5 }],
  ["把当前图层透明区域载入选区", "selection.load_layer", {}],
  ["给当前图层添加半径3像素的高斯模糊", "filter.gaussian_blur", { radius: 3 }],
  ["给当前图层添加角度15度、距离20像素的动感模糊", "filter.motion_blur", { angle: 15, distance: 20 }],
  ["给当前图层添加数量5%的单色高斯杂色", "filter.add_noise", { amount: 5, distribution: "gaussian", monochromatic: true }],
  ["给当前图层添加半径2.5像素的高反差保留", "filter.high_pass", { radius: 2.5 }],
  ["给当前图层应用数量80%、半径1.5像素、阈值2的USM锐化", "filter.unsharp_mask", { amount: 80, radius: 1.5, threshold: 2 }],
  ["给当前图层应用锐化滤镜", "filter.sharpen", {}],
  ["按当前选区裁剪文档", "document.crop", { reference: "selection" }],
  ["裁掉文档四周透明像素", "document.trim", { type: "transparent" }],
  ["扩展画布显示全部内容", "document.reveal_all", {}],
  ["把整个文档顺时针旋转90度", "document.rotate", { angle: 90 }]
]) {
  assertFast(engine, instruction, action, params);
}

const paragraph = operationsFor(
  engine,
  "把当前文字首行缩进设为6，左缩进4，右缩进4，段前2，段后3"
);
assert.strictEqual(paragraph.length, 1);
assert.strictEqual(paragraph[0].action, "text.set_paragraph_spacing");
assert.deepStrictEqual(paragraph[0].params, {
  firstLineIndent: 6,
  leftIndent: 4,
  rightIndent: 4,
  spaceBefore: 2,
  spaceAfter: 3
});

const groupStyle = operationsFor(
  engine,
  "把当前图层组内所有文字改成白色，字号32，字距20"
);
assert.strictEqual(groupStyle.length, 1);
assert.strictEqual(groupStyle[0].action, "group.set_text_style");
assert.strictEqual(groupStyle[0].params.color, "#FFFFFF");
assert.strictEqual(groupStyle[0].params.size, 32);
assert.strictEqual(groupStyle[0].params.tracking, 20);

const duplicate = operationsFor(
  engine,
  "复制当前图层，然后把副本重命名为“活动副本”，向右移动40像素，向下移动20像素，不透明度改为70%"
);
assert.deepStrictEqual(
  duplicate.map((item) => item.action),
  ["layer.duplicate", "layer.rename", "layer.move_by", "layer.set_opacity"]
);
for (const followup of duplicate.slice(1)) {
  assert.strictEqual(followup.target.scope, "operation_result");
  assert.strictEqual(followup.target.resultOf, duplicate[0].id);
}

const createGroupAndMove = operationsFor(
  engine,
  "建立一个组叫做测试组，然后把选中的图层放到测试组中"
);
assert.deepStrictEqual(
  createGroupAndMove.map((item) => item.action),
  ["layer.create_group", "layer.move_to_group"]
);
assert.strictEqual(createGroupAndMove[1].params.groupResultOf, createGroupAndMove[0].id);

const selectionChain = operationsFor(
  engine,
  "建立一个左100、上120、右900、下1400像素的矩形选区，然后收缩10像素，再羽化3像素"
);
assert.deepStrictEqual(
  selectionChain.map((item) => item.action),
  ["selection.rectangle", "selection.contract", "selection.feather"]
);

const recolor = operationsFor(engine, "把图中#B9E2E0的颜色改成#BA0003");
assert.deepStrictEqual(
  recolor.map((item) => item.action),
  ["selection.color_range", "adjustment.colorize"]
);
assert.strictEqual(recolor[0].params.color, "#B9E2E0");
assert.strictEqual(recolor[1].params.color, "#BA0003");

const subjectMask = operationsFor(
  engine,
  "选择画面主体，然后用当前选区给当前图层创建蒙版"
);
assert.deepStrictEqual(
  subjectMask.map((item) => item.action),
  ["selection.subject", "mask.create_from_selection"]
);

assert.strictEqual(engine.requiresVisualGrounding("把右下角黄色奖杯改成灰色"), true);
assert.strictEqual(engine.requiresVisualGrounding("把图中#B9E2E0改成#BA0003"), false);
assert.strictEqual(engine.isModificationInstruction("把当前图层重命名为测试"), true);

const visualSelection = {
  id: "locate",
  action: "selection.visual_object",
  target: { scope: "document" },
  params: {
    description: "右下角黄色奖杯",
    unit: "percent",
    targetBox: { left: 60, top: 42, right: 88, bottom: 78 },
    searchRegion: { left: 50, top: 35, right: 92, bottom: 85 },
    seed: { x: 72, y: 58 },
    color: "#FFD700",
    colors: ["#FFD700", "#B78200"],
    selectionMode: "all_in_region",
    confidence: 0.9
  }
};
const selectionOnlyAudit = engine.auditIntentCoverage(
  "把右下角黄色奖杯改成灰色",
  normalizeTestIntent({ operations: [visualSelection] })
);
assert.strictEqual(selectionOnlyAudit.complete, false);

const completeVisualIntent = normalizeTestIntent({
  operations: [
    visualSelection,
    {
      id: "recolor",
      action: "adjustment.colorize",
      target: { scope: "document" },
      params: { color: "#808080", opacity: 100, blendMode: "normal" }
    }
  ]
});
assert.strictEqual(
  engine.auditIntentCoverage("把右下角黄色奖杯改成灰色", completeVisualIntent).complete,
  true
);

const snapshot = {
  fingerprint: "strict-fingerprint",
  contentFingerprint: "content-fingerprint",
  document: { id: 1, title: "sample.psd", width: 2160, height: 3840 },
  selectionBounds: null,
  activeLayers: [{ id: 10, name: "Title" }, { id: 11, name: "Subtitle" }],
  flatLayers: [
    {
      id: 10,
      name: "Title",
      path: "Copy/Title",
      kind: "text",
      text: { contents: "Title" },
      locks: {},
      children: []
    },
    {
      id: 11,
      name: "Subtitle",
      path: "Copy/Subtitle",
      kind: "text",
      text: { contents: "Subtitle" },
      locks: {},
      children: []
    }
  ]
};

const multiLayerPlan = engine.compilePlan({
  route: "standard",
  intent: normalizeTestIntent({
    operations: [{
      id: "hide",
      action: "layer.set_visibility",
      target: { scope: "active_layers" },
      params: { visible: false }
    }]
  })
}, snapshot);
assert.strictEqual(multiLayerPlan.version, testVersion.replace(/^v/, ""));
assert.deepStrictEqual(
  Array.from(multiLayerPlan.steps, (step) => step.target.id),
  [10, 11]
);

const dependentPlan = engine.compilePlan({
  route: "standard",
  intent: normalizeTestIntent({
    operations: [
      {
        id: "copy",
        action: "layer.duplicate",
        target: { scope: "layer_path", query: "Copy/Title" },
        params: {}
      },
      {
        id: "rename",
        action: "layer.rename",
        target: { scope: "operation_result", resultOf: "copy" },
        params: { name: "Title copy" }
      }
    ]
  })
}, { ...snapshot, activeLayers: [{ id: 10, name: "Title" }] });
assert.strictEqual(dependentPlan.steps[1].target.kind, "operation_result");
assert.strictEqual(dependentPlan.steps[1].target.resultOf, "copy");

assert.throws(() => engine.compilePlan({
  route: "standard",
  intent: normalizeTestIntent({
    operations: [
      {
        action: "document.export",
        target: { scope: "document" },
        params: { format: "png" }
      },
      {
        action: "layer.rename",
        target: { scope: "active_layer" },
        params: { name: "Too late" }
      }
    ]
  })
}, snapshot), /导出/);

const visualPlan = engine.compilePlan({
  route: "standard",
  intent: normalizeTestIntent({
    operations: [{
      action: "selection.subject_region",
      target: { scope: "document" },
      params: {
        description: "right person",
        unit: "percent",
        searchRegion: { left: 50, top: 0, right: 100, bottom: 100 },
        confidence: 0.9
      }
    }]
  })
}, snapshot);
assert.strictEqual(visualPlan.steps[0].action, "selection.subject_region");
assert.strictEqual(visualPlan.steps[0].params.confidence, 0.9);

(async () => {
  let calls = 0;
  const understanding = await engine.understand(
    "把当前图层不透明度改为63%",
    snapshot,
    async () => {
      calls += 1;
      if (calls === 1) return 'Explanation before JSON: {"operations":[{"action":"layer.set_opacity","target":{"scope":"active_layer"},"params":{"opacity":63},"requirementIds":["req_1"],}],}';
      throw new Error("Repair call should not be needed for trailing commas");
    },
    { forceModel: true }
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(understanding.intent.operations[0].params.opacity, 63);

  calls = 0;
  const invalidJsonCall = () => engine.understand(
    "把当前图层不透明度改为63%",
    snapshot,
    async () => {
      calls += 1;
      if (calls === 1) return "I cannot format JSON";
      return '{"operations":[{"action":"layer.set_opacity","target":{"scope":"active_layer"},"params":{"opacity":63},"requirementIds":["req_1"]}]}';
    },
    { forceModel: true }
  );
  if (Number(testVersion.replace(/^v/, "")) >= 9.4) {
    await assert.rejects(invalidJsonCall, /没有再次请求模型/);
    assert.strictEqual(calls, 1, "v9.4+ must not make a hidden JSON-repair request");
  } else {
    const repaired = await invalidJsonCall();
    assert.strictEqual(calls, 2);
    assert.strictEqual(repaired.intent.operations[0].params.opacity, 63);
  }

  console.log(`${testVersion} engine routing, audit, target, and JSON-repair tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
