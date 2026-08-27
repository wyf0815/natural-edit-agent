"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "uxp-v9.8", "capabilities.js"), "utf8");

function imageData(bytes) {
  return {
    width: 2,
    height: 2,
    async getData() { return Uint8Array.from(bytes); },
    dispose() {}
  };
}

function loadHarness(options = {}) {
  let selectionBounds = { left: 10, top: 10, right: 20, bottom: 20 };
  let activeLayer = null;
  let maskCreated = false;
  let nextLayerId = 12;
  const sourceLayer = {
    id: 11,
    name: "受保护源图层",
    kind: "pixel",
    layers: [],
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    filterCalls: 0,
    async applyGaussianBlur() { this.filterCalls += 1; },
    async duplicate() {
      const layer = {
        id: nextLayerId++,
        name: `${this.name} 副本`,
        kind: this.kind,
        layers: [],
        bounds: { ...this.bounds },
        allLocked: true,
        pixelsLocked: true,
        transparentPixelsLocked: true,
        filterCalls: 0,
        sawSelectionDuringFilter: null,
        async applyGaussianBlur() {
          this.filterCalls += 1;
          this.sawSelectionDuringFilter = selectionBounds ? { ...selectionBounds } : null;
        }
      };
      document.layers.unshift(layer);
      activeLayer = layer;
      document.activeLayers = [layer];
      return layer;
    }
  };
  const document = {
    id: 7,
    layers: [sourceLayer],
    activeLayers: [sourceLayer],
    selection: {
      get bounds() {
        if (!selectionBounds) throw new Error("no selection");
        return { ...selectionBounds };
      },
      async deselect() { selectionBounds = null; }
    }
  };
  activeLayer = sourceLayer;

  const photoshop = {
    app: {
      activeDocument: document,
      async updateUI() {}
    },
    constants: {
      Orientation: { VERTICAL: "vertical", HORIZONTAL: "horizontal" },
      SelectionType: { REPLACE: "replace", EXTEND: "extend", DIMINISH: "diminish", INTERSECT: "intersect" },
      NoiseDistribution: { GAUSSIAN: "gaussian", UNIFORM: "uniform" },
      AnchorPosition: { MIDDLECENTER: "middle" }
    },
    action: {
      async batchPlay(commands) {
        const command = commands[0] || {};
        if (command._obj === "get") {
          const id = Number((command._target || []).find((item) => item._ref === "layer")._id);
          const layer = document.layers.find((item) => Number(item.id) === id);
          return [{ boundsNoEffects: { ...layer.bounds } }];
        }
        if (command._obj === "select" && (command._target || [])[0] && command._target[0]._ref === "layer") {
          const id = Number(command._target[0]._id);
          activeLayer = document.layers.find((item) => Number(item.id) === id);
          document.activeLayers = [activeLayer];
          return [{}];
        }
        if (command._obj === "make" && command.new && command.new._class === "channel") {
          maskCreated = true;
          return [{}];
        }
        return [{}];
      }
    },
    imaging: {
      async getPixels(request) {
        const layer = request.layerID == null
          ? null
          : document.layers.find((item) => Number(item.id) === Number(request.layerID));
        return { imageData: imageData(layer && layer.filterCalls ? [9, 8, 7, 6] : [1, 2, 3, 4]) };
      },
      async getSelection() {
        return { imageData: imageData([0, 255, 255, 0]) };
      },
      async putSelection(request) {
        selectionBounds = {
          left: Number(request.targetBounds.left),
          top: Number(request.targetBounds.top),
          right: Number(request.targetBounds.left) + 10,
          bottom: Number(request.targetBounds.top) + 10
        };
      },
      async getLayerMask() {
        if (!maskCreated) throw new Error("no mask");
        return { imageData: imageData(options.maskMismatch ? [255, 255, 255, 255] : [0, 255, 255, 0]) };
      }
    }
  };
  const context = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    JSON,
    Date,
    Map,
    Set,
    Uint8Array,
    setTimeout,
    require(name) {
      if (name !== "photoshop") throw new Error(`unexpected require ${name}`);
      return photoshop;
    },
    PhotoshopAssistantMaskRle: {
      decodeSegmentationRleCrop() {},
      summarizeSegmentationRle() {}
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "v9.8-capabilities.js" });
  return {
    capabilities: context.PhotoshopAssistantV8Capabilities,
    sourceLayer,
    document,
    get selectionBounds() { return selectionBounds && { ...selectionBounds }; },
    get maskCreated() { return maskCreated; }
  };
}

function state(target, useSelection) {
  return {
    document: { id: 7, width: 100, height: 100 },
    selectionBounds: useSelection ? { left: 10, top: 10, right: 20, bottom: 20 } : null,
    flatLayers: [target]
  };
}

async function runSelectedFilter(maskMismatch) {
  const harness = loadHarness({ maskMismatch });
  const capability = harness.capabilities.get("filter.gaussian_blur");
  const target = {
    id: 11,
    name: "受保护源图层",
    kind: "pixel",
    locks: { all: true, pixels: true, position: false, transparentPixels: true },
    hasLayerMask: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 }
  };
  const beforeState = state(target, true);
  assert.doesNotThrow(() => capability.preflight(target, { useSelection: true }, beforeState), "a locked source may be copied without being unlocked");
  const result = await capability.execute({ target, params: { radius: 4, useSelection: true }, beforeState });
  assert.strictEqual(result.sourceLayerId, 11);
  assert.strictEqual(result.resultLayerId, 12);
  assert.strictEqual(result.resultScope, "subtree");
  assert.strictEqual(harness.sourceLayer.filterCalls, 0, "the source layer must stay untouched");
  assert.strictEqual(harness.document.layers[0].filterCalls, 1, "the native filter must run on the duplicate");
  assert.deepStrictEqual(harness.document.layers[0].sawSelectionDuringFilter, beforeState.selectionBounds);
  assert.strictEqual(harness.maskCreated, true, "a selected local filter must persist its scope as a user mask");
  assert.deepStrictEqual(harness.selectionBounds, beforeState.selectionBounds, "the selection must remain reusable for later effects");
  const afterState = { ...beforeState, flatLayers: [target, { id: 12, name: "结果副本", kind: "pixel" }] };
  return { capability, target, result, afterState };
}

async function main() {
  const adjustmentBlock = source.slice(
    source.indexOf('["adjustment.brightness_contrast"'),
    source.indexOf('id: "document.resize_image"')
  );
  assert(adjustmentBlock.includes("await selectionMaskProof(selectionBounds, beforeState)"), "all local adjustment layers must capture the authorized selection mask");
  assert(adjustmentBlock.includes("withRetainedSelection(() => createAdjustment(params))"), "brightness, contrast, saturation and related effects must retain one reusable selection");
  assert(adjustmentBlock.includes("withRetainedSelection(() => createColorizeLayer(params))"), "local recoloring must retain the same reusable selection");
  assert(adjustmentBlock.includes("verifySelectionMask(result.resultLayerId, `${label}调整层`, result.expectedSelection)"), "adjustment masks must be compared with the authorized selection");
  assert(adjustmentBlock.includes('verifySelectionMask(result.resultLayerId, "局部改色图层", result.expectedSelection)'), "recolor masks must be compared with the authorized selection");
  assert(source.includes("center: Number(params.contrast)"), "Photoshop brightness/contrast must use its native center field");
  assert(source.includes("colorize: false"), "hue/saturation changes must preserve existing luminance and texture rather than flattening them");

  const harness = loadHarness();
  const capability = harness.capabilities.get("filter.gaussian_blur");
  assert.strictEqual(capability.version, "9.8");
  assert.strictEqual(capability.authorizedScope, "none", "filter capabilities must protect their source layer");
  const exportCapability = harness.capabilities.get("document.export");
  assert.strictEqual(exportCapability.reversible, false);
  assert.strictEqual(exportCapability.risk, "high", "external file writes cannot inherit the low-risk default because PSD rollback cannot undo them");

  const selected = await runSelectedFilter(false);
  assert.match(await selected.capability.verify({ afterState: selected.afterState, target: selected.target, result: selected.result }), /非破坏性副本/);

  const mismatched = await runSelectedFilter(true);
  await assert.rejects(
    () => mismatched.capability.verify({ afterState: mismatched.afterState, target: mismatched.target, result: mismatched.result }),
    /与获准选区不一致/
  );

  const whole = loadHarness();
  const wholeCapability = whole.capabilities.get("filter.gaussian_blur");
  const target = {
    id: 11,
    name: "受保护源图层",
    kind: "pixel",
    locks: { all: false, pixels: false, position: false, transparentPixels: false },
    hasLayerMask: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 }
  };
  const beforeState = state(target, false);
  const result = await wholeCapability.execute({ target, params: { radius: 4, useSelection: false }, beforeState });
  assert.strictEqual(whole.document.layers[0].sawSelectionDuringFilter, null, "an unrelated live selection must not restrict a whole-layer filter");
  assert.deepStrictEqual(whole.selectionBounds, { left: 10, top: 10, right: 20, bottom: 20 }, "the unrelated selection must be restored afterward");
  assert.strictEqual(result.createdSelectionMask, false);

  console.log("v9.8 local adjustment/filter capability tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
