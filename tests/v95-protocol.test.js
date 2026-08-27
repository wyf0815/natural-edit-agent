"use strict";

const assert = require("assert");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.5";
const protocol = require(`../uxp-${testVersion}/protocol.js`);
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

if (strictRequirementIds) {
  assert.throws(() => protocol.normalizeIntent({ operations: [{
    action: "layer.rename",
    target: { scope: "active_layer" },
    params: { name: "missing requirement" }
  }] }), /requirementId/, `${testVersion} production normalization must fail closed when requirementIds are absent`);
}

function targetFor(action) {
  if (
    action.startsWith("selection.")
    || action.startsWith("adjustment.")
    || action.startsWith("document.")
    || action === "layer.create_pixel"
    || action === "layer.create_group"
    || action === "text.create"
  ) {
    return { scope: "document" };
  }
  return { scope: "active_layer" };
}

function paramsFor(action) {
  const samples = {
    "layer.create_pixel": { name: "Pixel layer" },
    "layer.create_group": { name: "Group" },
    "layer.rename": { name: "Renamed" },
    "layer.set_visibility": { visible: false },
    "layer.set_opacity": { opacity: 63 },
    "layer.set_fill_opacity": { fillOpacity: 61 },
    "layer.set_blend_mode": { blendMode: "multiply" },
    "layer.set_lock": { lock: "position", locked: true },
    "layer.move_by": { deltaX: 20, deltaY: -10 },
    "layer.scale": { scaleX: 80, scaleY: 80 },
    "layer.rotate": { angle: 15, anchor: "middle_center" },
    "layer.flip": { axis: "horizontal" },
    "layer.skew": { angleH: 10, angleV: 0 },
    "layer.rasterize": { target: "entire_layer" },
    "layer.reorder": { position: "front" },
    "layer.move_to_group": { groupName: "Target group" },
    "layer.align_to_reference": {
      reference: "canvas", padding: 12, horizontal: "center", vertical: "middle"
    },
    "layer.fit_to_reference": {
      reference: "selection", padding: 20, horizontal: "center", vertical: "middle", allowUpscale: true
    },
    "text.create": { name: "Title", content: "Hello", size: 36, color: "#FFFFFF" },
    "text.set_content": { content: "Updated" },
    "text.set_color": { color: "#FF0000" },
    "text.set_size": { size: 48 },
    "text.set_font": { font: "ArialMT" },
    "text.set_leading": { leading: 56 },
    "text.set_tracking": { tracking: 20 },
    "text.set_justification": { justification: "center" },
    "text.set_faux_bold": { enabled: true },
    "text.set_faux_italic": { enabled: false },
    "text.set_horizontal_scale": { scale: 90 },
    "text.set_vertical_scale": { scale: 110 },
    "text.set_baseline_shift": { baselineShift: 3 },
    "text.set_hyphenation": { enabled: false },
    "text.set_paragraph_spacing": {
      firstLineIndent: 6, leftIndent: 4, rightIndent: 4, spaceBefore: 2, spaceAfter: 3
    },
    "text.set_orientation": { orientation: "vertical" },
    "text.fit_to_reference": {
      reference: "selection", padding: 10, horizontal: "center", vertical: "middle", allowUpscale: false
    },
    "group.set_text_style": {
      size: 32, color: "#FFFFFF", tracking: 20, orientation: "horizontal"
    },
    "group.fit_text_to_reference": {
      reference: "selection",
      padding: 10,
      horizontal: "center",
      vertical: "middle",
      allowUpscale: false,
      arrangement: "compact",
      orientation: "horizontal"
    },
    "filter.gaussian_blur": { radius: 3 },
    "filter.motion_blur": { angle: 30, distance: 20 },
    "filter.add_noise": { amount: 5, distribution: "gaussian", monochromatic: true },
    "filter.high_pass": { radius: 2 },
    "filter.unsharp_mask": { amount: 120, radius: 1.5, threshold: 2 },
    "selection.rectangle": {
      unit: "pixels", left: 100, top: 120, right: 900, bottom: 1400, feather: 0
    },
    "selection.ellipse": {
      unit: "percent", left: 10, top: 20, right: 80, bottom: 90, feather: 2
    },
    "selection.polygon": {
      unit: "percent",
      points: [{ x: 10, y: 10 }, { x: 80, y: 20 }, { x: 50, y: 90 }],
      feather: 1
    },
    "selection.subject": { sampleAllLayers: true },
    "selection.subject_region": {
      description: "right-side person",
      unit: "percent",
      searchRegion: { left: 55, top: 0, right: 100, bottom: 100 },
      feather: 1,
      confidence: 0.9
    },
    "selection.color_range": { color: "#FF6600", tolerance: 24, softness: 6 },
    "selection.visual_object": {
      description: "yellow trophy",
      unit: "percent",
      targetBox: { left: 60, top: 42, right: 86, bottom: 76 },
      searchRegion: { left: 50, top: 35, right: 92, bottom: 82 },
      seed: { x: 72, y: 58 },
      excludePoints: [{ x: 53, y: 38 }],
      sourceColorFamilies: ["yellow"],
      sourceColors: ["#E8B514"],
      allowColorFallback: false,
      feather: 1,
      confidence: 0.9,
      maxCoverage: 0.5
    },
    "selection.expand": { by: 5 },
    "selection.contract": { by: 5 },
    "selection.feather": { by: 2 },
    "selection.border": { width: 3 },
    "selection.grow": { tolerance: 32, antiAlias: true },
    "selection.smooth": { radius: 5 },
    "adjustment.brightness_contrast": { brightness: 12, contrast: 8 },
    "adjustment.levels": { inputBlack: 8, inputWhite: 242, gamma: 1.08, outputBlack: 0, outputWhite: 255 },
    "layer.set_clipping_mask": { enabled: true },
    "mask.set_density": { density: 67 },
    "mask.set_feather": { feather: 3.5 },
    "adjustment.curves": { points: [{ input: 0, output: 0 }, { input: 128, output: 142 }, { input: 255, output: 255 }] },
    "adjustment.vibrance": { vibrance: 18, saturation: 4 },
    "adjustment.exposure": { exposure: 0.35, offset: 0, gamma: 1 },
    "adjustment.black_white": { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 },
    "adjustment.hue_saturation": { hue: 0, saturation: -100, lightness: 0 },
    "adjustment.colorize": { color: "#808080", opacity: 100, blendMode: "normal" },
    "document.resize_image": { width: 1080, height: 1920, constrainProportions: true },
    "document.resize_canvas": { width: 1200, height: 2000, anchor: "middle_center" },
    "document.crop": { reference: "selection" },
    "document.rotate": { angle: 90 },
    "document.trim": { type: "transparent", top: true, left: true, bottom: true, right: true },
    "document.export": { format: "jpg", quality: 10, asCopy: true }
  };
  return samples[action] || {};
}

const parsed = protocol.parseJsonValue(
  'Model note: {"message":"brace } inside string","items":[1,2,],} trailing text'
);
assert.strictEqual(parsed.message, "brace } inside string");
assert.deepStrictEqual(parsed.items, [1, 2]);
assert.throws(
  () => protocol.parseJsonValue("not json"),
  (error) => error && error.code === "MODEL_JSON_INVALID"
);

const normalizedActions = [];
for (const action of protocol.ACTIONS) {
  const intent = normalizeTestIntent({
    summary: "Contract sample",
    operations: [{
      id: `sample_${normalizedActions.length + 1}`,
      action,
      target: targetFor(action),
      params: paramsFor(action)
    }]
  });
  assert.strictEqual(intent.version, testVersion.replace(/^v/, ""));
  assert.strictEqual(intent.operations[0].action, action);
  normalizedActions.push(action);
}
assert.strictEqual(normalizedActions.length, protocol.ACTIONS.size);
assert.deepStrictEqual(
  normalizedActions.sort(),
  Object.keys(protocol.ACTION_CONTRACTS).sort(),
  "Every registered action must have a contract and a normalizable sample"
);

for (const target of [
  { scope: "active_layer" },
  { scope: "active_layers" },
  { scope: "layer_id", id: 42 },
  { scope: "layer_path", query: "Root/Title" },
  { scope: "layer_name", query: "Title" },
  { scope: "text_content", query: "Hello" },
  { scope: "operation_result", resultOf: "copy" },
  { scope: "document" }
]) {
  const intent = normalizeTestIntent({
    operations: [{ action: "layer.rename", target, params: { name: "Checked" } }]
  });
  assert.strictEqual(intent.operations[0].target.scope, target.scope);
}

const fractionalVisual = normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "target",
      unit: strictRequirementIds ? "normalized" : "percent",
      targetBox: { left: 0.6, top: 0.42, right: 0.86, bottom: 0.76 },
      searchRegion: { left: 0.5, top: 0.35, right: 0.92, bottom: 0.82 },
      seed: { x: 0.72, y: 0.58 },
      excludePoints: [{ x: 0.53, y: 0.38 }],
      confidence: 0.9
    }
  }]
});
assert.strictEqual(fractionalVisual.operations[0].params.targetBox.left, 60);
assert.strictEqual(fractionalVisual.operations[0].params.seed.x, 72);
assert.strictEqual(fractionalVisual.operations[0].params.excludePoints[0].x, 53);
assert.strictEqual(fractionalVisual.operations[0].params.selectionMode, "semantic");
assert.strictEqual(fractionalVisual.operations[0].params.allowColorFallback, false);
assert.strictEqual(fractionalVisual.operations[0].params.colorRefine, "auto");

const sourceColorPart = normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "purple beard only; keep the face unchanged",
      unit: "percent",
      targetBox: { left: 20, top: 30, right: 48, bottom: 62 },
      searchRegion: { left: 12, top: 22, right: 58, bottom: 72 },
      seed: { x: 34, y: 46 },
      excludePoints: [{ x: 36, y: 52 }],
      colorRefine: "source",
      sourceColorFamilies: ["purple"],
      sourceColors: ["#713A8A"],
      confidence: 0.82
    }
  }]
});
assert.strictEqual(sourceColorPart.operations[0].params.colorRefine, "source");
assert.strictEqual(sourceColorPart.operations[0].params.excludePoints.length, 1);
assert.deepStrictEqual(sourceColorPart.operations[0].params.sourceColorFamilies, ["purple"]);
assert.deepStrictEqual(sourceColorPart.operations[0].params.sourceColors, ["#713A8A"]);

assert.throws(() => normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "invalid refinement mode",
      unit: "percent",
      targetBox: { left: 20, top: 30, right: 48, bottom: 62 },
      searchRegion: { left: 12, top: 22, right: 58, bottom: 72 },
      seed: { x: 34, y: 46 },
      colorRefine: "everything",
      confidence: 0.82
    }
  }]
}), /颜色细化|refine|模式/);

assert.throws(() => normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "unsupported source colour family",
      unit: "percent",
      targetBox: { left: 20, top: 30, right: 48, bottom: 62 },
      searchRegion: { left: 12, top: 22, right: 58, bottom: 72 },
      seed: { x: 34, y: 46 },
      sourceColorFamilies: ["ultraviolet"],
      confidence: 0.82
    }
  }]
}), /原颜色|颜色类别|source/i);

const explicitColorFallback = normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "flat red stain",
      unit: "percent",
      targetBox: { left: 60, top: 42, right: 86, bottom: 76 },
      searchRegion: { left: 50, top: 35, right: 92, bottom: 82 },
      seed: { x: 72, y: 58 },
      color: "#FF0000",
      colors: ["#FF0000", "#CC0000"],
      allowColorFallback: true,
      selectionMode: "all_in_region",
      confidence: 0.9
    }
  }]
});
assert.strictEqual(explicitColorFallback.operations[0].params.allowColorFallback, true);
assert.strictEqual(explicitColorFallback.operations[0].params.selectionMode, "all_in_region");

assert.throws(() => normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "bad seed",
      unit: "percent",
      targetBox: { left: 60, top: 42, right: 86, bottom: 76 },
      searchRegion: { left: 50, top: 35, right: 92, bottom: 82 },
      seed: { x: 20, y: 20 },
      confidence: 0.9
    }
  }]
}), /seed|种子/);

const lowConfidenceSubject = normalizeTestIntent({
  operations: [{
    action: "selection.subject_region",
    target: { scope: "document" },
    params: {
      description: "uncertain object",
      unit: "percent",
      searchRegion: { left: 0, top: 0, right: 100, bottom: 100 },
      confidence: 0.3
    }
  }]
});
assert.strictEqual(lowConfidenceSubject.operations[0].params.requiresHumanConfirmation, true);

const lowConfidenceVisual = normalizeTestIntent({
  operations: [{
    action: "selection.visual_object",
    target: { scope: "document" },
    params: {
      description: "uncertain trophy",
      unit: "percent",
      targetBox: { left: 60, top: 42, right: 86, bottom: 76 },
      searchRegion: { left: 50, top: 35, right: 92, bottom: 82 },
      seed: { x: 72, y: 58 },
      positivePoints: [{ x: 80, y: 70 }],
      excludePoints: [{ x: 55, y: 40 }],
      confidence: 0.3
    }
  }]
});
assert.strictEqual(lowConfidenceVisual.operations[0].params.requiresHumanConfirmation, true);
assert.strictEqual(lowConfidenceVisual.operations[0].params.positivePoints.length, 1);

assert.throws(() => normalizeTestIntent({
  operations: [{ action: "not.registered", target: { scope: "document" }, params: {} }]
}), /not\.registered/);

console.log(`${testVersion} protocol contracts passed: ${protocol.ACTIONS.size} actions`);
