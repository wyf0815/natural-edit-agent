(function (root, factory) {
  root.PhotoshopAssistantV8Capabilities = factory(root.PhotoshopAssistantMaskRle);
})(typeof globalThis !== "undefined" ? globalThis : this, function (maskRle) {
  "use strict";

  const { app, constants, action, imaging } = require("photoshop");
  const selectionSessions = globalThis.PhotoshopAssistantV97SelectionSession;
  if (!maskRle || typeof maskRle.decodeSegmentationRleCrop !== "function"
    || typeof maskRle.summarizeSegmentationRle !== "function") {
    throw new Error("语义蒙版数据模块没有加载，插件已停止以保护 Photoshop。");
  }
  const { decodeSegmentationRleCrop, summarizeSegmentationRle } = maskRle;
  const SEMANTIC_MASK_LIMIT = 8;
  const SEMANTIC_MASK_TTL_MS = 10 * 60 * 1000;
  const semanticMasks = new Map();
  let semanticMaskSequence = 0;

  function normalizeEnum(value) {
    return String(value == null ? "" : value).split(".").pop();
  }

  function numericValue(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.value === "number") return value.value;
    if (value && typeof value._value === "number") return value._value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function safeDispose(value) {
    if (value && typeof value.dispose === "function") value.dispose();
  }

  function hexToRgb(hex) {
    const value = String(hex || "").replace("#", "");
    return {
      red: parseInt(value.slice(0, 2), 16),
      green: parseInt(value.slice(2, 4), 16),
      blue: parseInt(value.slice(4, 6), 16)
    };
  }

  function liveLayers(layers, result) {
    for (const layer of Array.from(layers || [])) {
      result.push(layer);
      try {
        if (layer.layers && layer.layers.length) liveLayers(layer.layers, result);
      } catch (_) {}
    }
    return result;
  }

  function findLiveLayer(id) {
    return liveLayers(app.activeDocument.layers, []).find((layer) => Number(layer.id) === Number(id)) || null;
  }

  function stateLayer(state, id) {
    return (state.flatLayers || []).find((layer) => Number(layer.id) === Number(id)) || null;
  }

  function adjacentSiblingBelow(state, target) {
    if (!target) return null;
    const siblings = (state.flatLayers || [])
      .filter((layer) => Number(layer.parentId) === Number(target.parentId))
      .sort((left, right) => Number(left.index) - Number(right.index));
    const position = siblings.findIndex((layer) => Number(layer.id) === Number(target.id));
    return position >= 0 && position + 1 < siblings.length ? siblings[position + 1] : null;
  }

  function stateDescendants(state, parentId) {
    const result = [];
    const queue = [Number(parentId)];
    while (queue.length) {
      const current = queue.shift();
      for (const layer of state.flatLayers || []) {
        if (Number(layer.parentId) === current) {
          result.push(layer);
          queue.push(Number(layer.id));
        }
      }
    }
    return result;
  }

  function liveDescendants(layer) {
    const result = [];
    try { liveLayers(layer.layers || [], result); } catch (_) {}
    return result;
  }

  function isGroup(target) {
    return Boolean(target && ((target.children && target.children.length) || String(target.kind).toLowerCase().includes("group")));
  }

  function resolveDestinationGroup(state, params) {
    const groups = (state.flatLayers || []).filter((layer) => {
      if (!isGroup(layer)) return false;
      if (params.groupId != null) return Number(layer.id) === Number(params.groupId);
      return String(layer.name || "") === String(params.groupName || "");
    });
    if (!groups.length) throw new Error(`没有找到图层组“${params.groupName}”。`);
    if (groups.length > 1) throw new Error(`存在多个同名图层组“${params.groupName}”，请重命名后再试。`);
    return groups[0];
  }

  function requireDocument(target) {
    if (!target || target.kind !== "document") throw new Error("该能力必须作用于当前文档。");
  }

  function requireEditable(target, options) {
    if (target && (!target.locks || target.locks.all == null)) {
      throw new Error(`无法确认图层“${target.name}”是否锁定，已停止执行以避免越权修改。`);
    }
    if (target && options && options.position && target.locks.position == null) {
      throw new Error(`无法确认图层“${target.name}”的位置锁定状态，已停止执行。`);
    }
    if (!target) throw new Error("目标图层不存在。");
    if (target.locks && target.locks.all) throw new Error(`图层“${target.name}”已完全锁定，v9.8不会擅自解锁。`);
    if (options && options.position && target.locks && target.locks.position) throw new Error(`图层“${target.name}”的位置已锁定。`);
    if (options && options.text && !target.text) throw new Error(`图层“${target.name}”不是可编辑文字层。`);
    if (options && options.group && !isGroup(target)) throw new Error(`图层“${target.name}”不是图层组。`);
  }

  function requireReadable(target) {
    if (!target) throw new Error("源图层不存在。");
  }

  function requireEditableGroup(target, beforeState, options) {
    const needsPosition = Boolean(options && options.position);
    requireEditable(target, { group: true, position: needsPosition });
    const textLayers = stateDescendants(beforeState, target.id).filter((layer) => Boolean(layer.text));
    if (!textLayers.length) throw new Error(`图层组“${target.name}”中没有可编辑文字层。`);
    const unknownLock = textLayers.find((layer) => !layer.locks
      || layer.locks.all == null
      || (needsPosition && layer.locks.position == null));
    if (unknownLock) {
      throw new Error(`无法确认图层组中文字层“${unknownLock.path}”的锁定状态，已停止执行。`);
    }
    const locked = textLayers.find((layer) => layer.locks && (layer.locks.all || (needsPosition && layer.locks.position)));
    if (locked) throw new Error(`图层组中的文字层“${locked.path}”已锁定，已停止执行。`);
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}，期望${expected}，实际${actual}。`);
  }

  function assertClose(actual, expected, tolerance, message) {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)
      || Math.abs(actualNumber - expectedNumber) > tolerance) {
      throw new Error(`${message}，期望${expected}，实际${actual}。`);
    }
  }

  function boundsOfState(layer) {
    const bounds = layer && (layer.boundsNoEffects || layer.bounds);
    if (!bounds) throw new Error(`无法读取图层“${layer ? layer.name : "未知"}”的边界。`);
    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
  }

  function width(bounds) { return Number(bounds.right) - Number(bounds.left); }
  function height(bounds) { return Number(bounds.bottom) - Number(bounds.top); }
  function centerX(bounds) { return (Number(bounds.left) + Number(bounds.right)) / 2; }
  function centerY(bounds) { return (Number(bounds.top) + Number(bounds.bottom)) / 2; }

  function unionBounds(boundsList) {
    if (!boundsList.length) throw new Error("没有可计算的图层边界。");
    return boundsList.reduce((all, bounds) => ({
      left: Math.min(all.left, bounds.left),
      top: Math.min(all.top, bounds.top),
      right: Math.max(all.right, bounds.right),
      bottom: Math.max(all.bottom, bounds.bottom)
    }));
  }

  async function freshBounds(layerId) {
    const result = await action.batchPlay([{
      _obj: "get",
      _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _id: Number(layerId) }],
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
    const raw = result[0] && (result[0].boundsNoEffects || result[0].bounds);
    if (!raw) return boundsOfState({ name: String(layerId), bounds: findLiveLayer(layerId).bounds });
    return {
      left: numericValue(raw.left),
      top: numericValue(raw.top),
      right: numericValue(raw.right),
      bottom: numericValue(raw.bottom)
    };
  }

  function intersectBounds(left, right) {
    if (!left || !right) return null;
    const result = {
      left: Math.max(Number(left.left), Number(right.left)),
      top: Math.max(Number(left.top), Number(right.top)),
      right: Math.min(Number(left.right), Number(right.right)),
      bottom: Math.min(Number(left.bottom), Number(right.bottom))
    };
    return width(result) >= 1 && height(result) >= 1 ? result : null;
  }

  function boundedSampleSize(bounds, maxSide) {
    const largest = Math.max(width(bounds), height(bounds));
    const scale = Math.min(1, Number(maxSide || 160) / Math.max(1, largest));
    return {
      width: Math.max(1, Math.round(width(bounds) * scale)),
      height: Math.max(1, Math.round(height(bounds) * scale))
    };
  }

  async function pixelDigest(layerId, requestedBounds) {
    const layerBounds = await freshBounds(layerId);
    const bounds = requestedBounds ? intersectBounds(layerBounds, requestedBounds) : layerBounds;
    if (!bounds) throw new Error("获准选区与目标图层没有重叠，滤镜不会产生目标内变化。");
    if (width(bounds) < 1 || height(bounds) < 1) throw new Error("目标图层没有可读取的像素区域。");
    const pixelArea = Math.ceil(width(bounds)) * Math.ceil(height(bounds));
    const options = {
      documentID: Number(app.activeDocument.id),
      layerID: Number(layerId),
      sourceBounds: bounds,
      componentSize: 8
    };
    if (pixelArea > 1024 * 1024) options.targetSize = boundedSampleSize(bounds, 192);
    const image = await imaging.getPixels({
      ...options
    });
    try {
      const data = await image.imageData.getData({ chunky: true });
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 1) {
        hash ^= Number(data[index]) & 255;
        hash = Math.imul(hash, 16777619);
      }
      return `${image.imageData.width}x${image.imageData.height}:${(hash >>> 0).toString(16)}`;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function selectionDigest() {
    const image = await imaging.getSelection({
      documentID: Number(app.activeDocument.id),
      targetSize: { width: 64, height: 64 }
    });
    if (!image || !image.imageData) throw new Error("Photoshop没有返回可读取的选区数据。");
    try {
      const data = await image.imageData.getData({ chunky: true });
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 1) {
        hash ^= Number(data[index]) & 255;
        hash = Math.imul(hash, 16777619);
      }
      return `${image.imageData.width}x${image.imageData.height}:${(hash >>> 0).toString(16)}`;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  function activeSelectionBounds() {
    try {
      const bounds = app.activeDocument.selection.bounds;
      if (!bounds) return null;
      const normalized = {
        left: numericValue(bounds.left),
        top: numericValue(bounds.top),
        right: numericValue(bounds.right),
        bottom: numericValue(bounds.bottom)
      };
      return width(normalized) > 0 && height(normalized) > 0 ? normalized : null;
    } catch (_) {
      return null;
    }
  }

  async function withPreservedSelection(callback) {
    const bounds = activeSelectionBounds();
    if (!bounds) return callback();
    const documentID = Number(app.activeDocument.id);
    const beforeSelectionDigest = await selectionDigest();
    const saved = await imaging.getSelection({ documentID, sourceBounds: bounds });
    if (!saved || !saved.imageData) {
      throw new Error("检测到活动选区，但 Photoshop 未返回可保存的选区数据；为避免变换只作用于局部，已停止执行。");
    }
    try {
      await app.activeDocument.selection.deselect();
      return await callback();
    } finally {
      try {
        await app.activeDocument.selection.deselect();
        await imaging.putSelection({
          documentID,
          imageData: saved.imageData,
          targetBounds: { left: bounds.left, top: bounds.top },
          replace: true,
          commandName: "Natural Edit Agent：恢复变换前选区"
        });
        const restoredBounds = activeSelectionBounds();
        const boundsMatch = restoredBounds && ["left", "top", "right", "bottom"]
          .every((key) => Math.round(Number(restoredBounds[key])) === Math.round(Number(bounds[key])));
        if (!boundsMatch || await selectionDigest() !== beforeSelectionDigest) {
          throw new Error("变换完成后未能精确恢复原活动选区，当前文档状态不确定；请立即使用本次撤销。");
        }
      } finally {
        safeDispose(saved && saved.imageData);
      }
    }
  }

  async function withRetainedSelection(callback) {
    const bounds = activeSelectionBounds();
    if (!bounds) throw new Error("当前没有可复用的活动选区。");
    const documentID = Number(app.activeDocument.id);
    const beforeSelectionDigest = await selectionDigest();
    const saved = await imaging.getSelection({ documentID, sourceBounds: bounds });
    if (!saved || !saved.imageData) {
      throw new Error("Photoshop 未返回可保存的活动选区，无法保证多个局部效果复用同一蒙版。");
    }
    try {
      return await callback();
    } finally {
      try {
        const currentBounds = activeSelectionBounds();
        let currentDigest = null;
        if (currentBounds) {
          try { currentDigest = await selectionDigest(); } catch (_) {}
        }
        const boundsMatch = currentBounds && ["left", "top", "right", "bottom"]
          .every((key) => Math.round(Number(currentBounds[key])) === Math.round(Number(bounds[key])));
        if (!boundsMatch || currentDigest !== beforeSelectionDigest) {
          await app.activeDocument.selection.deselect();
          await imaging.putSelection({
            documentID,
            imageData: saved.imageData,
            targetBounds: { left: bounds.left, top: bounds.top },
            replace: true,
            commandName: "Natural Edit Agent：恢复局部效果选区"
          });
        }
        const restoredBounds = activeSelectionBounds();
        const restoredBoundsMatch = restoredBounds && ["left", "top", "right", "bottom"]
          .every((key) => Math.round(Number(restoredBounds[key])) === Math.round(Number(bounds[key])));
        if (!restoredBoundsMatch || await selectionDigest() !== beforeSelectionDigest) {
          throw new Error("局部效果完成后未能恢复同一活动选区，不能继续复用该蒙版。");
        }
      } finally {
        safeDispose(saved && saved.imageData);
      }
    }
  }

  function batchPlayError(result, label) {
    const items = Array.from(result || []);
    const failureIndex = items.findIndex((item) => {
      if (!item || typeof item !== "object") return true;
      const objectType = String(item._obj || "").toLowerCase();
      if (objectType === "error" || objectType === "failure") return true;
      if (item.result != null && Number(item.result) < 0) return true;
      return typeof item.message === "string" && item.message.trim().length > 0;
    });
    if (failureIndex >= 0) {
      const failure = items[failureIndex];
      const detail = failure && (failure.message || failure.result || failure._obj);
      throw new Error(`${label}失败：${detail || "Photoshop没有返回有效结果"}`);
    }
    return result;
  }

  function hashGrayData(data, imageData) {
    let selected = 0;
    let sum = 0;
    let hash = 2166136261;
    for (const value of data) {
      const byte = Number(value) & 255;
      if (byte > 8) selected += 1;
      sum += byte;
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return {
      selected,
      total: data.length,
      sum,
      digest: `${imageData.width}x${imageData.height}:${(hash >>> 0).toString(16)}`
    };
  }

  async function layerMaskStats(layerId, sample) {
    const options = {
      documentID: Number(app.activeDocument.id),
      layerID: Number(layerId),
      kind: "user",
      targetSize: sample && sample.targetSize ? { ...sample.targetSize } : { width: 64, height: 64 }
    };
    if (sample && sample.sampleBounds) options.sourceBounds = { ...sample.sampleBounds };
    const mask = await imaging.getLayerMask(options);
    if (!mask || !mask.imageData) throw new Error("Photoshop没有返回可读取的用户蒙版数据。");
    try {
      const data = await mask.imageData.getData({ chunky: true });
      return hashGrayData(data, mask.imageData);
    } finally {
      safeDispose(mask && mask.imageData);
    }
  }

  function paddedSelectionSampleBounds(bounds, document, padding) {
    const margin = Math.max(Number(padding || 0), Math.ceil(Math.max(width(bounds), height(bounds)) * 0.04));
    return {
      left: Math.max(0, Math.floor(Number(bounds.left) - margin)),
      top: Math.max(0, Math.floor(Number(bounds.top) - margin)),
      right: Math.min(Number(document.width), Math.ceil(Number(bounds.right) + margin)),
      bottom: Math.min(Number(document.height), Math.ceil(Number(bounds.bottom) + margin))
    };
  }

  async function selectionMaskProof(bounds, beforeState) {
    const sampleBounds = paddedSelectionSampleBounds(bounds, beforeState.document, 4);
    const targetSize = boundedSampleSize(sampleBounds, 192);
    const selection = await imaging.getSelection({
      documentID: Number(app.activeDocument.id),
      sourceBounds: sampleBounds,
      targetSize
    });
    if (!selection || !selection.imageData) throw new Error("Photoshop没有返回可用于蒙版比对的活动选区数据。");
    try {
      const data = await selection.imageData.getData({ chunky: true });
      const stats = hashGrayData(data, selection.imageData);
      if (!stats.selected) throw new Error("活动选区为空，不能建立局部效果蒙版。");
      return { ...stats, sampleBounds, targetSize };
    } finally {
      safeDispose(selection && selection.imageData);
    }
  }

  async function verifySelectionMask(layerId, label, expectedSelection) {
    const stats = await layerMaskStats(layerId, expectedSelection);
    if (!stats.selected) throw new Error(`${label}没有生成有效选区蒙版。`);
    if (expectedSelection && (stats.total !== expectedSelection.total
      || stats.digest !== expectedSelection.digest
      || stats.selected !== expectedSelection.selected
      || stats.sum !== expectedSelection.sum)) {
      throw new Error(`${label}的用户蒙版与获准选区不一致，已停止把它判定为成功。`);
    }
    return stats.selected;
  }

  async function maskExists(layerId) {
    try {
      await layerMaskStats(layerId);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function makeUserMask(layerId, mode) {
    await selectLayer(layerId);
    const result = await action.batchPlay([{
      _obj: "make",
      new: { _class: "channel" },
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: mode },
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(result, "创建图层蒙版");
  }

  async function removeUserMask(layerId, apply) {
    await selectLayer(layerId);
    const result = await action.batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
      apply: Boolean(apply),
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(result, apply ? "应用图层蒙版" : "删除图层蒙版");
  }

  async function invertUserMask(layerId) {
    await selectLayer(layerId);
    const result = await action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
      makeVisible: false,
      _options: { dialogOptions: "silent" }
    }, {
      _obj: "invert",
      _options: { dialogOptions: "silent" }
    }, {
      _obj: "select",
      _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }],
      makeVisible: false,
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(result, "反相图层蒙版");
  }

  async function createAdjustmentLayer(name, type, failureLabel) {
    const result = await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name,
        type
      },
      _options: { dialogOptions: "silent" }
    }], { immediateRedraw: true });
    batchPlayError(result, failureLabel);
    if (typeof app.updateUI === "function") await app.updateUI();
    const layer = app.activeDocument.activeLayers[0];
    return Number((result[0] && (result[0].layerID || result[0].ID)) || (layer && layer.id));
  }

  async function createHueSaturationAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "hueSaturation",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      colorize: false,
      adjustment: [{
        _obj: "hueSatAdjustmentV2",
        hue: Number(params.hue),
        saturation: Number(params.saturation),
        lightness: Number(params.lightness)
      }]
    }, "创建色相/饱和度调整层");
  }

  async function createBrightnessContrastAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "brightnessEvent",
      brightness: Number(params.brightness),
      center: Number(params.contrast),
      useLegacy: false
    }, "创建亮度/对比度调整层");
  }

  async function createVibranceAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "vibrance",
      vibrance: Number(params.vibrance),
      saturation: Number(params.saturation)
    }, "创建自然饱和度调整层");
  }

  async function createExposureAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "exposure",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      exposure: Number(params.exposure),
      offset: Number(params.offset),
      gammaCorrection: Number(params.gamma)
    }, "创建曝光度调整层");
  }

  async function createBlackWhiteAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "blackAndWhite",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      red: Number(params.red),
      yellow: Number(params.yellow),
      green: Number(params.green),
      cyan: Number(params.cyan),
      blue: Number(params.blue),
      magenta: Number(params.magenta),
      useTint: false
    }, "创建黑白调整层");
  }

  async function createLevelsAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "levels",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      adjustment: [{
        _obj: "levelsAdjustment",
        channel: { _ref: "channel", _enum: "channel", _value: "composite" },
        input: [Number(params.inputBlack), Number(params.inputWhite)],
        gamma: Number(params.gamma),
        output: [Number(params.outputBlack), Number(params.outputWhite)]
      }]
    }, "创建色阶调整层");
  }

  async function createCurvesAdjustment(params) {
    return createAdjustmentLayer(params.name, {
      _obj: "curves",
      presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
      adjustment: [{
        _obj: "curvesAdjustment",
        channel: { _ref: "channel", _enum: "channel", _value: "composite" },
        curve: params.points.map((point) => ({
          _obj: "paint",
          horizontal: Number(point.input),
          vertical: Number(point.output)
        }))
      }]
    }, "创建曲线调整层");
  }

  async function createColorizeLayer(params) {
    const rgb = hexToRgb(params.color);
    const result = await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "contentLayer" }],
      using: {
        _obj: "contentLayer",
        name: params.name,
        type: {
          _obj: "solidColorLayer",
          color: { _obj: "RGBColor", red: rgb.red, grain: rgb.green, blue: rgb.blue }
        }
      },
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(result, "创建颜色填充层");
    const layer = app.activeDocument.activeLayers[0];
    const layerId = Number((result[0] && (result[0].layerID || result[0].ID)) || (layer && layer.id));
    const styleResult = await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _id: layerId }],
      to: {
        _obj: "layer",
        mode: { _enum: "blendMode", _value: params.blendMode || "normal" },
        opacity: { _unit: "percentUnit", _value: Number(params.opacity) }
      },
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(styleResult, "设置局部改色图层");
    return layerId;
  }

  async function selectColorRange(params, beforeState) {
    const bounds = {
      left: 0,
      top: 0,
      right: Math.round(beforeState.document.width),
      bottom: Math.round(beforeState.document.height)
    };
    const pixels = await imaging.getPixels({
      documentID: Number(app.activeDocument.id),
      sourceBounds: bounds,
      componentSize: 8,
      applyAlpha: false
    });
    try {
      const data = await pixels.imageData.getData({ chunky: true });
      const pixelCount = Number(pixels.imageData.width) * Number(pixels.imageData.height);
      const components = Math.max(1, Math.round(data.length / Math.max(1, pixelCount)));
      const wanted = hexToRgb(params.color);
      const tolerance = Number(params.tolerance);
      const softness = Number(params.softness || 0);
      const mask = new Uint8Array(pixelCount);
      let selected = 0;
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * components;
        const distance = Math.max(
          Math.abs(Number(data[offset]) - wanted.red),
          Math.abs(Number(data[offset + Math.min(1, components - 1)]) - wanted.green),
          Math.abs(Number(data[offset + Math.min(2, components - 1)]) - wanted.blue)
        );
        let value = distance <= tolerance ? 255 : 0;
        if (!value && softness > 0 && distance < tolerance + softness) {
          value = Math.round(255 * (1 - (distance - tolerance) / softness));
        }
        mask[index] = value;
        if (value > 8) selected += 1;
      }
      if (!selected) throw new Error(`画面中没有找到接近${params.color}且容差为${params.tolerance}的像素。`);
      await putSelectionMaskSafely({
        documentID: Number(app.activeDocument.id),
        mask,
        width: Number(pixels.imageData.width),
        height: Number(pixels.imageData.height),
        origin: { left: pixels.sourceBounds.left, top: pixels.sourceBounds.top },
        commandName: "Natural Edit Agent：按颜色选择"
      });
      return { selectedPixels: selected, totalPixels: pixelCount };
    } finally {
      safeDispose(pixels && pixels.imageData);
    }
  }

  function boundedSearchRegion(params, beforeState) {
    const scaleX = params.unit === "percent" ? Number(beforeState.document.width) / 100 : 1;
    const scaleY = params.unit === "percent" ? Number(beforeState.document.height) / 100 : 1;
    const source = params.searchRegion;
    const bounds = {
      left: Math.max(0, Math.floor(Number(source.left) * scaleX)),
      top: Math.max(0, Math.floor(Number(source.top) * scaleY)),
      right: Math.min(Math.round(beforeState.document.width), Math.ceil(Number(source.right) * scaleX)),
      bottom: Math.min(Math.round(beforeState.document.height), Math.ceil(Number(source.bottom) * scaleY))
    };
    if (bounds.right - bounds.left < 2 || bounds.bottom - bounds.top < 2) throw new Error("自动定位的搜索范围太小。");
    return { bounds, scaleX, scaleY };
  }

  function visualRegion(params, beforeState) {
    const spatial = boundedSearchRegion(params, beforeState);
    const { bounds, scaleX, scaleY } = spatial;
    const sourceTarget = params.targetBox;
    const targetBounds = {
      left: Math.max(bounds.left, Math.floor(Number(sourceTarget.left) * scaleX)),
      top: Math.max(bounds.top, Math.floor(Number(sourceTarget.top) * scaleY)),
      right: Math.min(bounds.right, Math.ceil(Number(sourceTarget.right) * scaleX)),
      bottom: Math.min(bounds.bottom, Math.ceil(Number(sourceTarget.bottom) * scaleY))
    };
    if (targetBounds.right - targetBounds.left < 2 || targetBounds.bottom - targetBounds.top < 2) {
      throw new Error("自动定位的目标紧框太小。");
    }
    const seed = {
      x: Math.max(targetBounds.left, Math.min(targetBounds.right - 1, Math.round(Number(params.seed.x) * scaleX))),
      y: Math.max(targetBounds.top, Math.min(targetBounds.bottom - 1, Math.round(Number(params.seed.y) * scaleY)))
    };
    return { bounds, targetBounds, seed };
  }

  function isInsideTargetBox(index, widthValue, sourceBounds, targetBounds) {
    const x = Number(sourceBounds.left) + (index % widthValue);
    const y = Number(sourceBounds.top) + Math.floor(index / widthValue);
    return x >= targetBounds.left && x < targetBounds.right && y >= targetBounds.top && y < targetBounds.bottom;
  }

  async function selectSubjectRegion(params, beforeState) {
    const spatial = boundedSearchRegion(params, beforeState);
    const result = await action.batchPlay([{
      _obj: "autoCutout",
      sampleAllLayers: Boolean(params.sampleAllLayers),
      _options: { dialogOptions: "silent" }
    }], {});
    batchPlayError(result, "选择主体");
    const documentID = Number(app.activeDocument.id);
    const clipped = await imaging.getSelection({ documentID, sourceBounds: spatial.bounds });
    if (!clipped || !clipped.imageData) throw new Error(`Photoshop没有在“${params.description}”范围内识别到主体。`);
    try {
      const data = await clipped.imageData.getData({ chunky: true });
      let selectedPixels = 0;
      for (const value of data) if (Number(value) > 8) selectedPixels += 1;
      if (selectedPixels < 9) throw new Error(`Photoshop在“${params.description}”范围内识别到的主体不足9个像素。`);
      await imaging.putSelection({
        documentID,
        imageData: clipped.imageData,
        replace: true,
        targetBounds: {
          left: Number(clipped.sourceBounds ? clipped.sourceBounds.left : spatial.bounds.left),
          top: Number(clipped.sourceBounds ? clipped.sourceBounds.top : spatial.bounds.top)
        },
        commandName: `Natural Edit Agent：定位${params.description}`
      });
      if (Number(params.feather) > 0) await app.activeDocument.selection.feather(Number(params.feather));
      return {
        selectedPixels,
        searchBounds: spatial.bounds,
        selectionBounds: activeSelectionBounds()
      };
    } finally {
      safeDispose(clipped && clipped.imageData);
    }
  }

  function rgbToHsv(red, green, blue) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta > 0) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { hue, saturation: max ? delta / max : 0, value: max };
  }

  function hueDistance(a, b) {
    const distance = Math.abs(a - b);
    return Math.min(distance, 360 - distance);
  }

  function visualColorMatcher(target, tolerance) {
    const hsv = rgbToHsv(target.red, target.green, target.blue);
    const hueLimit = Math.max(8, Math.min(48, tolerance * 0.62));
    const saturationLimit = Math.max(0.18, Math.min(0.62, tolerance / 150));
    const valueLimit = Math.max(0.24, Math.min(0.7, tolerance / 120));
    return (red, green, blue) => {
      const pixel = rgbToHsv(red, green, blue);
      if (hsv.saturation < 0.12) {
        const channelSpread = Math.max(red, green, blue) - Math.min(red, green, blue);
        return channelSpread <= Math.max(18, tolerance * 0.7) && Math.abs(pixel.value - hsv.value) <= valueLimit;
      }
      return pixel.saturation >= Math.max(0.08, hsv.saturation - saturationLimit)
        && hueDistance(pixel.hue, hsv.hue) <= hueLimit
        && Math.abs(pixel.value - hsv.value) <= valueLimit;
    };
  }

  function visualColorMatchers(params, sampled) {
    const colors = Array.isArray(params.colors) && params.colors.length
      ? params.colors.map(hexToRgb)
      : params.color
        ? [hexToRgb(params.color)]
        : [sampled];
    const matchers = colors.map((color) => visualColorMatcher(color, Number(params.tolerance)));
    return {
      colors,
      matches(red, green, blue) {
        return matchers.some((matcher) => matcher(red, green, blue));
      }
    };
  }

  function maskPixelBounds(mask, pixelWidth) {
    let left = pixelWidth;
    let top = Math.ceil(mask.length / pixelWidth);
    let right = -1;
    let bottom = -1;
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) continue;
      const x = index % pixelWidth;
      const y = Math.floor(index / pixelWidth);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    return { left, top, right: right + 1, bottom: bottom + 1 };
  }

  function cropSelectionMask(mask, pixelWidth, pixelHeight, origin, padding = 2) {
    const width = Math.round(Number(pixelWidth));
    const height = Math.round(Number(pixelHeight));
    if (!mask || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error("选区蒙版尺寸无效，已停止以保护 Photoshop。 ");
    }
    if (mask.length !== width * height) {
      throw new Error(`选区蒙版数据长度不一致：需要${width * height}，实际${mask.length}。`);
    }
    const bounds = maskPixelBounds(mask, width);
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
      throw new Error("选区蒙版为空，未向 Photoshop 提交。 ");
    }
    const safePadding = Math.max(0, Math.min(8, Math.round(Number(padding) || 0)));
    const left = Math.max(0, bounds.left - safePadding);
    const top = Math.max(0, bounds.top - safePadding);
    const right = Math.min(width, bounds.right + safePadding);
    const bottom = Math.min(height, bounds.bottom + safePadding);
    const croppedWidth = right - left;
    const croppedHeight = bottom - top;
    const pixelCount = croppedWidth * croppedHeight;
    if (pixelCount > 64 * 1024 * 1024) {
      throw new Error("选区蒙版范围过大，已停止以避免 Photoshop 原生崩溃。 ");
    }
    const cropped = new Uint8Array(pixelCount);
    for (let y = 0; y < croppedHeight; y += 1) {
      const sourceOffset = (top + y) * width + left;
      cropped.set(mask.subarray(sourceOffset, sourceOffset + croppedWidth), y * croppedWidth);
    }
    const originLeft = Math.round(Number(origin && origin.left) || 0);
    const originTop = Math.round(Number(origin && origin.top) || 0);
    return {
      data: cropped,
      width: croppedWidth,
      height: croppedHeight,
      targetBounds: { left: originLeft + left, top: originTop + top },
      documentBounds: {
        left: originLeft + bounds.left,
        top: originTop + bounds.top,
        right: originLeft + bounds.right,
        bottom: originTop + bounds.bottom
      }
    };
  }

  async function putSelectionMaskSafely({ documentID, mask, width, height, origin, commandName }) {
    const activeDocumentID = Number(app.activeDocument && app.activeDocument.id);
    const requestedDocumentID = Number(documentID);
    if (!Number.isInteger(requestedDocumentID) || activeDocumentID !== requestedDocumentID) {
      throw new Error("写入选区前活动文档已经变化，请重新分析指令。 ");
    }
    const cropped = cropSelectionMask(mask, width, height, origin, 2);
    let imageData = null;
    try {
      imageData = await imaging.createImageDataFromBuffer(cropped.data, {
        width: cropped.width,
        height: cropped.height,
        components: 1,
        chunky: false,
        colorSpace: "Grayscale",
        colorProfile: "Gray Gamma 2.2"
      });
      await imaging.putSelection({
        documentID: requestedDocumentID,
        imageData,
        replace: true,
        targetBounds: cropped.targetBounds,
        commandName
      });
      return cropped;
    } finally {
      safeDispose(imageData);
    }
  }

  function nearestMaskDistance(mask, pixelWidth, point) {
    const pixelHeight = Math.ceil(mask.length / pixelWidth);
    const startX = Math.max(0, Math.min(pixelWidth - 1, Math.round(point.x)));
    const startY = Math.max(0, Math.min(pixelHeight - 1, Math.round(point.y)));
    if (mask[startY * pixelWidth + startX]) return 0;
    const maxRadius = Math.max(12, Math.ceil(Math.hypot(pixelWidth, pixelHeight) * 0.08));
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      const left = Math.max(0, startX - radius);
      const right = Math.min(pixelWidth - 1, startX + radius);
      const top = Math.max(0, startY - radius);
      const bottom = Math.min(pixelHeight - 1, startY + radius);
      for (let x = left; x <= right; x += 1) {
        if (mask[top * pixelWidth + x] || mask[bottom * pixelWidth + x]) return radius;
      }
      for (let y = top + 1; y < bottom; y += 1) {
        if (mask[y * pixelWidth + left] || mask[y * pixelWidth + right]) return radius;
      }
    }
    return Infinity;
  }

  function rememberSemanticMask(entry) {
    for (const [key, value] of semanticMasks) {
      if (Date.now() - value.createdAt > SEMANTIC_MASK_TTL_MS) semanticMasks.delete(key);
    }
    const token = `semantic_${Date.now()}_${semanticMaskSequence += 1}`;
    semanticMasks.set(token, { ...entry, createdAt: Date.now() });
    while (semanticMasks.size > SEMANTIC_MASK_LIMIT) semanticMasks.delete(semanticMasks.keys().next().value);
    return token;
  }

  function clearSemanticMasks() {
    semanticMasks.clear();
  }

  function releaseSemanticMask(token) {
    if (token) semanticMasks.delete(String(token));
  }

  async function registerSemanticMask(result, params, beforeState) {
    const widthValue = Math.round(Number(result && result.width));
    const heightValue = Math.round(Number(result && result.height));
    const expectedWidth = Math.round(Number(beforeState.document.width));
    const expectedHeight = Math.round(Number(beforeState.document.height));
    if (widthValue !== expectedWidth || heightValue !== expectedHeight) {
      throw new Error(`语义分割蒙版尺寸${widthValue}×${heightValue}与当前文档${expectedWidth}×${expectedHeight}不一致。`);
    }
    const region = visualRegion(params, beforeState);
    const segmentationRle = result && (result.croppedRle || result.rle);
    const summary = summarizeSegmentationRle(segmentationRle, widthValue, heightValue, region);
    const bounds = summary.bounds;
    const searchArea = Math.max(1, width(region.bounds) * height(region.bounds));
    const coverage = summary.selected / searchArea;
    if (coverage > Number(params.maxCoverage)) {
      throw new Error(`语义分割覆盖搜索区${Math.round(coverage * 100)}%，超过安全上限，已拒绝整块误选。`);
    }
    if (summary.outsideSearch > 0) throw new Error("语义分割越出了允许搜索范围，已停止执行。");
    const targetContainment = summary.insideTarget / Math.max(1, summary.selected);
    const targetArea = Math.max(1, width(region.targetBounds) * height(region.targetBounds));
    const targetCoverage = summary.insideTarget / targetArea;
    const wholeObject = String(params.semanticScope || "unknown") === "whole_object";
    const targetWidth = Math.max(1, width(region.targetBounds));
    const targetHeight = Math.max(1, height(region.targetBounds));
    const targetOverlapWidth = bounds
      ? Math.max(0, Math.min(bounds.right, region.targetBounds.right) - Math.max(bounds.left, region.targetBounds.left))
      : 0;
    const targetOverlapHeight = bounds
      ? Math.max(0, Math.min(bounds.bottom, region.targetBounds.bottom) - Math.max(bounds.top, region.targetBounds.top))
      : 0;
    const targetSpanX = Math.max(0, Math.min(1, targetOverlapWidth / targetWidth));
    const targetSpanY = Math.max(0, Math.min(1, targetOverlapHeight / targetHeight));
    const targetSpanScore = Math.sqrt(targetSpanX * targetSpanY);
    const rawGeometricIntegrity = Number(result && result.geometricIntegrity);
    const geometricIntegrity = Number.isFinite(rawGeometricIntegrity)
      ? Math.max(0, Math.min(1, rawGeometricIntegrity))
      : Math.max(0, Math.min(1, targetContainment * 0.35 + targetSpanScore * 0.65));
    const seedDistance = summary.seedDistance;
    const targetDiagonal = Math.hypot(width(region.targetBounds), height(region.targetBounds));
    const rawIouScore = Number(result.iouScore);
    const iouScore = Number.isFinite(rawIouScore) ? Math.max(0, Math.min(1, rawIouScore)) : 0;
    const protectedLeakage = Math.max(0, Math.min(1, Number(result.protectedLeakage || 0)));
    const protectedRemovalRatio = Math.max(0, Math.min(1, Number(result.protectedRemovalRatio || 0)));
    const protectionMode = String(result.protectionMode || "none");
    const protectionConflict = result.protectionConflict === true;
    const colorRefined = result.colorRefined === true;
    const colorRetainedRatio = Math.max(0, Number(result.colorRetainedRatio == null ? 1 : result.colorRetainedRatio));
    if (params.colorRefine === "source" && !colorRefined) {
      throw new Error("该局部颜色目标没有经过源颜色细化，已停止执行以避免修改相邻部件。");
    }
    if (protectedLeakage > 0.18) {
      throw new Error("候选蒙版仍覆盖了明确要求保持不变的区域，请修正排除点。");
    }
    const qualityWarnings = [];
    if (targetContainment < 0.42) qualityWarnings.push("候选蒙版大部分位于模型给出的目标框之外");
    if (wholeObject && (targetCoverage < 0.10 || targetSpanScore < 0.46)) {
      qualityWarnings.push("完整对象候选的覆盖或跨度偏低，请检查是否漏掉肢体、花纹、分离部件或内部明暗");
    }
    if (!Number.isFinite(seedDistance) || seedDistance > Math.max(16, targetDiagonal * 0.22)) {
      qualityWarnings.push("候选蒙版没有可靠覆盖目标落点");
    }
    if (iouScore < 0.35) qualityWarnings.push("分割模型对候选蒙版的预测分数较低");
    if (Number(params.confidence) < 0.72) qualityWarnings.push("视觉模型对目标位置的置信度较低");
    if (protectedLeakage > 0.02) qualityWarnings.push("候选蒙版靠近明确保护区域，请人工检查边缘");
    if (protectionConflict) qualityWarnings.push("保护区与目标候选有较大冲突，已按保护点强制避让，请检查边缘");
    else if (protectedRemovalRatio > 0.20) qualityWarnings.push("系统已自动从候选中排除较大保护区域，请检查是否有漏选");
    const maskPreview = result.maskPreviewBase64 ? {
      mime: String(result.maskPreviewMime || "image/png"),
      base64: String(result.maskPreviewBase64),
      width: Math.max(1, Math.round(Number(result.maskPreviewWidth || width(region.targetBounds)))),
      height: Math.max(1, Math.round(Number(result.maskPreviewHeight || height(region.targetBounds)))),
      canvasBounds: result.maskPreviewCanvasBounds ? { ...result.maskPreviewCanvasBounds } : { ...region.bounds }
    } : null;
    const snapshotDocumentID = Number(beforeState.document && beforeState.document.id);
    const documentID = Number.isInteger(snapshotDocumentID)
      ? snapshotDocumentID
      : Number(app.activeDocument.id);
    const token = rememberSemanticMask({
      documentID,
      width: widthValue,
      height: heightValue,
      rle: Array.isArray(segmentationRle)
        ? segmentationRle.map((count) => Number(count))
        : { ...segmentationRle, counts: segmentationRle.counts.map((count) => Number(count)) },
      selectedPixels: summary.selected,
      coverage,
      selectionBounds: bounds,
      searchBounds: { ...region.bounds },
      targetBounds: { ...region.targetBounds },
      iouScore,
      targetContainment,
      targetCoverage,
      targetSpanX,
      targetSpanY,
      targetSpanScore,
      geometricIntegrity,
      seedDistance,
      colorRefined,
      colorRetainedRatio,
      protectedLeakage,
      protectedRemovalRatio,
      protectionMode,
      protectionConflict,
      candidateMode: String(result.candidateMode || "unknown"),
      candidateCount: Math.max(1, Math.round(Number(result.candidateCount || 1))),
      sourceColorFamilies: Array.isArray(result.sourceColorFamilies) ? result.sourceColorFamilies.slice() : [],
      sourceColorHints: Array.isArray(result.sourceColorHints) ? result.sourceColorHints.slice() : []
    });
    const protectionScore = 1 - protectedLeakage;
    // MobileSAM's IoU score rates its own mask candidate. It is not proof that the
    // candidate semantically covers the complete user-described object.
    const pixelConfidence = wholeObject
      ? iouScore * 0.22 + targetContainment * 0.18 + geometricIntegrity * 0.50 + protectionScore * 0.10
      : colorRefined
        ? iouScore * 0.35 + targetContainment * 0.25 + geometricIntegrity * 0.15 + protectionScore * 0.25
        : iouScore * 0.42 + targetContainment * 0.28 + geometricIntegrity * 0.20 + protectionScore * 0.10;
    return {
      maskToken: token,
      segmentationMode: "semantic",
      segmentationEngine: String(result.engine || "MobileSAM"),
      modelConfidence: Number(params.confidence),
      pixelConfidence: Math.max(0, Math.min(1, pixelConfidence)),
      requiresHumanConfirmation: qualityWarnings.length > 0 || params.requiresHumanConfirmation === true,
      qualityWarnings,
      matchingPixels: summary.selected,
      coverage,
      seedDistance,
      iouScore,
      targetContainment,
      targetCoverage,
      targetSpanX,
      targetSpanY,
      targetSpanScore,
      geometricIntegrity,
      colorRefined,
      colorRetainedRatio,
      protectedLeakage,
      protectedRemovalRatio,
      protectionMode,
      protectionConflict,
      candidateMode: String(result.candidateMode || "unknown"),
      candidateCount: Math.max(1, Math.round(Number(result.candidateCount || 1))),
      sourceColorFamilies: Array.isArray(result.sourceColorFamilies) ? result.sourceColorFamilies.slice() : [],
      sourceColorHints: Array.isArray(result.sourceColorHints) ? result.sourceColorHints.slice() : [],
      maskPreview,
      fullPreview: result.previewBase64 ? {
        mime: String(result.previewMime || "image/jpeg"),
        base64: String(result.previewBase64),
        width: Number(result.previewWidth || result.width || widthValue),
        height: Number(result.previewHeight || result.height || heightValue)
      } : null,
      selectionBounds: bounds,
      searchBounds: { ...region.bounds },
      targetBounds: { ...region.targetBounds },
      cacheHit: Boolean(result.cacheHit)
    };
  }

  function nearestMatchingPixel(matches, widthValue, heightValue, seedX, seedY) {
    const direct = seedY * widthValue + seedX;
    if (matches[direct]) return direct;
    const maxRadius = Math.max(6, Math.ceil(Math.min(widthValue, heightValue) * 0.12));
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      const left = Math.max(0, seedX - radius);
      const right = Math.min(widthValue - 1, seedX + radius);
      const top = Math.max(0, seedY - radius);
      const bottom = Math.min(heightValue - 1, seedY + radius);
      for (let x = left; x <= right; x += 1) {
        const topIndex = top * widthValue + x;
        const bottomIndex = bottom * widthValue + x;
        if (matches[topIndex]) return topIndex;
        if (matches[bottomIndex]) return bottomIndex;
      }
      for (let y = top + 1; y < bottom; y += 1) {
        const leftIndex = y * widthValue + left;
        const rightIndex = y * widthValue + right;
        if (matches[leftIndex]) return leftIndex;
        if (matches[rightIndex]) return rightIndex;
      }
    }
    return -1;
  }

  function buildVisualMask(candidates, widthValue, heightValue, start, selectionMode) {
    const mask = new Uint8Array(candidates.length);
    let selected = 0;
    let minX = widthValue;
    let minY = heightValue;
    let maxX = -1;
    let maxY = -1;
    const include = (index) => {
      const x = index % widthValue;
      const y = Math.floor(index / widthValue);
      mask[index] = 255;
      selected += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    if (selectionMode === "all_in_region") {
      for (let index = 0; index < candidates.length; index += 1) {
        if (candidates[index]) include(index);
      }
    } else {
      const queue = new Int32Array(candidates.length);
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      candidates[start] = 0;
      while (head < tail) {
        const index = queue[head++];
        const x = index % widthValue;
        const y = Math.floor(index / widthValue);
        include(index);
        for (let dy = -1; dy <= 1; dy += 1) {
          const nextY = y + dy;
          if (nextY < 0 || nextY >= heightValue) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nextX = x + dx;
            if (nextX < 0 || nextX >= widthValue) continue;
            const next = nextY * widthValue + nextX;
            if (!candidates[next]) continue;
            candidates[next] = 0;
            queue[tail++] = next;
          }
        }
      }
    }
    return { mask, selected, minX, minY, maxX, maxY };
  }

  async function probeVisualObject(params, beforeState) {
    const region = visualRegion(params, beforeState);
    const pixels = await imaging.getPixels({
      documentID: Number(app.activeDocument.id),
      sourceBounds: region.bounds,
      componentSize: 8,
      applyAlpha: false
    });
    try {
      const data = await pixels.imageData.getData({ chunky: true });
      const pixelWidth = Number(pixels.imageData.width);
      const pixelHeight = Number(pixels.imageData.height);
      const pixelCount = pixelWidth * pixelHeight;
      const components = Math.max(1, Math.round(data.length / Math.max(1, pixelCount)));
      const localSeedX = Math.max(0, Math.min(pixelWidth - 1, region.seed.x - Number(pixels.sourceBounds.left)));
      const localSeedY = Math.max(0, Math.min(pixelHeight - 1, region.seed.y - Number(pixels.sourceBounds.top)));
      const seedOffset = (localSeedY * pixelWidth + localSeedX) * components;
      const sampled = {
        red: Number(data[seedOffset]),
        green: Number(data[seedOffset + Math.min(1, components - 1)]),
        blue: Number(data[seedOffset + Math.min(2, components - 1)])
      };
      const matcher = visualColorMatchers(params, sampled);
      const candidates = new Uint8Array(pixelCount);
      let matchingPixels = 0;
      for (let index = 0; index < pixelCount; index += 1) {
        if (!isInsideTargetBox(index, pixelWidth, pixels.sourceBounds, region.targetBounds)) continue;
        const offset = index * components;
        if (!matcher.matches(
          Number(data[offset]),
          Number(data[offset + Math.min(1, components - 1)]),
          Number(data[offset + Math.min(2, components - 1)])
        )) continue;
        candidates[index] = 1;
        matchingPixels += 1;
      }
      const start = nearestMatchingPixel(candidates, pixelWidth, pixelHeight, localSeedX, localSeedY);
      if (start < 0 || matchingPixels < 9) throw new Error(`像素复核没有在“${params.description}”附近找到足够的目标颜色。`);
      const candidateCopy = new Uint8Array(candidates);
      const selected = buildVisualMask(candidateCopy, pixelWidth, pixelHeight, start, params.selectionMode);
      if (selected.selected < 9) throw new Error(`像素复核在“${params.description}”附近只找到${selected.selected}个连通像素。`);
      const startX = start % pixelWidth;
      const startY = Math.floor(start / pixelWidth);
      const distance = Math.hypot(startX - localSeedX, startY - localSeedY);
      const proximity = 1 - Math.min(1, distance / Math.max(6, Math.min(pixelWidth, pixelHeight) * 0.12));
      const coverage = selected.selected / Math.max(1, pixelCount);
      if (coverage > Number(params.maxCoverage)) {
        throw new Error(`像素复核发现目标颜色覆盖搜索区${Math.round(coverage * 100)}%，超过安全上限，已停止以避免误改。`);
      }
      const coverageScore = coverage >= 0.002 && coverage <= 0.55 ? 1 : 0.55;
      const pixelConfidence = Math.max(0, Math.min(1, proximity * 0.72 + coverageScore * 0.28));
      if (pixelConfidence < 0.58) throw new Error(`“${params.description}”的模型坐标没有通过真实像素复核，请换一句更明确的位置描述。`);
      return {
        pixelConfidence,
        modelConfidence: Number(params.confidence),
        matchingPixels: selected.selected,
        coverage,
        seedDistance: distance,
        sampledColor: `#${[matcher.colors[0].red, matcher.colors[0].green, matcher.colors[0].blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`,
        sampledColors: matcher.colors.map((color) => `#${[color.red, color.green, color.blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`),
        maskPreview: null,
        selectionBounds: {
          left: Number(pixels.sourceBounds.left) + selected.minX,
          top: Number(pixels.sourceBounds.top) + selected.minY,
          right: Number(pixels.sourceBounds.left) + selected.maxX + 1,
          bottom: Number(pixels.sourceBounds.top) + selected.maxY + 1
        },
        searchBounds: {
          left: Number(pixels.sourceBounds.left),
          top: Number(pixels.sourceBounds.top),
          right: Number(pixels.sourceBounds.right == null ? pixels.sourceBounds.left + pixelWidth : pixels.sourceBounds.right),
          bottom: Number(pixels.sourceBounds.bottom == null ? pixels.sourceBounds.top + pixelHeight : pixels.sourceBounds.bottom)
        },
        targetBounds: { ...region.targetBounds }
      };
    } finally {
      safeDispose(pixels && pixels.imageData);
    }
  }

  async function selectVisualObjectByColor(params, beforeState) {
    const region = visualRegion(params, beforeState);
    const pixels = await imaging.getPixels({
      documentID: Number(app.activeDocument.id),
      sourceBounds: region.bounds,
      componentSize: 8,
      applyAlpha: false
    });
    try {
      const data = await pixels.imageData.getData({ chunky: true });
      const pixelWidth = Number(pixels.imageData.width);
      const pixelHeight = Number(pixels.imageData.height);
      const pixelCount = pixelWidth * pixelHeight;
      const components = Math.max(1, Math.round(data.length / Math.max(1, pixelCount)));
      const localSeedX = Math.max(0, Math.min(pixelWidth - 1, region.seed.x - Number(pixels.sourceBounds.left)));
      const localSeedY = Math.max(0, Math.min(pixelHeight - 1, region.seed.y - Number(pixels.sourceBounds.top)));
      const seedOffset = (localSeedY * pixelWidth + localSeedX) * components;
      const sampled = {
        red: Number(data[seedOffset]),
        green: Number(data[seedOffset + Math.min(1, components - 1)]),
        blue: Number(data[seedOffset + Math.min(2, components - 1)])
      };
      const matcher = visualColorMatchers(params, sampled);
      const candidates = new Uint8Array(pixelCount);
      for (let index = 0; index < pixelCount; index += 1) {
        if (!isInsideTargetBox(index, pixelWidth, pixels.sourceBounds, region.targetBounds)) continue;
        const offset = index * components;
        if (matcher.matches(
          Number(data[offset]),
          Number(data[offset + Math.min(1, components - 1)]),
          Number(data[offset + Math.min(2, components - 1)])
        )) candidates[index] = 1;
      }
      const start = nearestMatchingPixel(candidates, pixelWidth, pixelHeight, localSeedX, localSeedY);
      if (start < 0) throw new Error(`自动定位没有在“${params.description}”附近找到符合颜色特征的像素。`);
      const selectedResult = buildVisualMask(candidates, pixelWidth, pixelHeight, start, params.selectionMode);
      const coverage = selectedResult.selected / Math.max(1, pixelCount);
      if (selectedResult.selected < 9) throw new Error(`自动定位到的“${params.description}”不足9个像素，已停止以避免误改。`);
      if (coverage > Number(params.maxCoverage)) {
        throw new Error(`自动定位覆盖搜索区域的${Math.round(coverage * 100)}%，超过安全上限${Math.round(Number(params.maxCoverage) * 100)}%，已停止以避免整块误改。`);
      }
      await putSelectionMaskSafely({
        documentID: Number(app.activeDocument.id),
        mask: selectedResult.mask,
        width: pixelWidth,
        height: pixelHeight,
        origin: { left: Number(pixels.sourceBounds.left), top: Number(pixels.sourceBounds.top) },
        commandName: `Natural Edit Agent：定位${params.description}`
      });
      if (Number(params.feather) > 0) await app.activeDocument.selection.feather(Number(params.feather));
      return {
        selectedPixels: selectedResult.selected,
        coverage,
        sampledColor: `#${[matcher.colors[0].red, matcher.colors[0].green, matcher.colors[0].blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`,
        sampledColors: matcher.colors.map((color) => `#${[color.red, color.green, color.blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`),
        selectionBounds: {
          left: Number(pixels.sourceBounds.left) + selectedResult.minX,
          top: Number(pixels.sourceBounds.top) + selectedResult.minY,
          right: Number(pixels.sourceBounds.left) + selectedResult.maxX + 1,
          bottom: Number(pixels.sourceBounds.top) + selectedResult.maxY + 1
        },
        searchBounds: {
          left: Number(pixels.sourceBounds.left),
          top: Number(pixels.sourceBounds.top),
          right: Number(pixels.sourceBounds.right == null ? pixels.sourceBounds.left + pixelWidth : pixels.sourceBounds.right),
          bottom: Number(pixels.sourceBounds.bottom == null ? pixels.sourceBounds.top + pixelHeight : pixels.sourceBounds.bottom)
        },
        targetBounds: { ...region.targetBounds }
      };
    } finally {
      safeDispose(pixels && pixels.imageData);
    }
  }

  async function selectVisualObject(params, beforeState) {
    const token = String(params.maskToken || "");
    if (!token) {
      if (params.allowColorFallback === true) {
        return selectVisualObjectByColor({ ...params, selectionMode: params.selectionMode === "all_in_region" ? "all_in_region" : "seeded" }, beforeState);
      }
      throw new Error("缺少已验收的语义对象蒙版；不会退回矩形或颜色整块选区冒充目标。");
    }
    const entry = semanticMasks.get(token);
    if (!entry || Date.now() - entry.createdAt > SEMANTIC_MASK_TTL_MS) {
      semanticMasks.delete(token);
      throw new Error("语义对象蒙版已失效，请重新分析指令。");
    }
    if (Number(app.activeDocument.id) !== entry.documentID
      || Number(beforeState.document.width) !== entry.width
      || Number(beforeState.document.height) !== entry.height) {
      throw new Error("当前文档与语义对象蒙版不一致，请重新分析指令。");
    }
    const decoded = decodeSegmentationRleCrop(
      entry.rle,
      entry.width,
      entry.height,
      entry.selectionBounds,
      2
    );
    if (decoded.selected !== entry.selectedPixels) {
      semanticMasks.delete(token);
      throw new Error("语义对象蒙版缓存校验失败，请重新分析指令。");
    }
    await putSelectionMaskSafely({
      documentID: entry.documentID,
      mask: decoded.mask,
      width: decoded.width,
      height: decoded.height,
      origin: decoded.origin,
      commandName: `Natural Edit Agent：语义定位${params.description}`
    });
    if (Number(params.feather) > 0) await app.activeDocument.selection.feather(Number(params.feather));
    return {
      selectedPixels: entry.selectedPixels,
      coverage: entry.coverage,
      selectionBounds: { ...entry.selectionBounds },
      searchBounds: { ...entry.searchBounds },
      targetBounds: { ...entry.targetBounds },
      segmentationMode: "semantic",
      iouScore: entry.iouScore,
      targetContainment: entry.targetContainment
    };
  }

  async function documentDigest() {
    const image = await imaging.getPixels({
      documentID: Number(app.activeDocument.id),
      targetSize: { width: 64, height: 64 },
      componentSize: 8,
      applyAlpha: false
    });
    try {
      const data = await image.imageData.getData({ chunky: true });
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 1) {
        hash ^= Number(data[index]) & 255;
        hash = Math.imul(hash, 16777619);
      }
      return `${image.imageData.width}x${image.imageData.height}:${(hash >>> 0).toString(16)}`;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function compositeRegionDigest(bounds) {
    if (!bounds || width(bounds) < 1 || height(bounds) < 1) throw new Error("目标选区没有可验收的像素区域。");
    const maxSide = Math.max(width(bounds), height(bounds));
    const scale = Math.min(1, 160 / Math.max(1, maxSide));
    const pixelArea = Math.ceil(width(bounds)) * Math.ceil(height(bounds));
    const useNativeResolution = pixelArea <= 4 * 1024 * 1024;
    const options = {
      documentID: Number(app.activeDocument.id),
      sourceBounds: bounds,
      colorSpace: "RGB",
      componentSize: 8,
      applyAlpha: false
    };
    // execute() suspends history until the whole plan commits. Supplying the
    // active history ID here would pin the read to the pre-plan composite.
    if (!useNativeResolution) {
      options.targetSize = {
        width: Math.max(1, Math.round(width(bounds) * scale)),
        height: Math.max(1, Math.round(height(bounds) * scale))
      };
    }
    const image = await imaging.getPixels(options);
    if (!image || !image.imageData) throw new Error("Photoshop没有返回目标区域的像素数据。");
    try {
      const data = await image.imageData.getData({ chunky: true });
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 1) {
        hash ^= Number(data[index]) & 255;
        hash = Math.imul(hash, 16777619);
      }
      return `${image.imageData.width}x${image.imageData.height}:${(hash >>> 0).toString(16)}`;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function waitForCompositeChange(bounds, beforeDigest) {
    let digest = beforeDigest;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (typeof app.updateUI === "function") await app.updateUI();
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 50));
      digest = await compositeRegionDigest(bounds);
      if (digest !== beforeDigest) return digest;
    }
    return digest;
  }

  function referenceBounds(state, params) {
    const source = params.reference === "selection"
      ? state.selectionBounds
      : { left: 0, top: 0, right: state.document.width, bottom: state.document.height };
    if (!source) throw new Error("当前没有活动选区。请先建立选区，或把参考区域改为画布。");
    const padding = Number(params.padding || 0);
    const result = {
      left: Number(source.left) + padding,
      top: Number(source.top) + padding,
      right: Number(source.right) - padding,
      bottom: Number(source.bottom) - padding
    };
    if (width(result) <= 1 || height(result) <= 1) throw new Error("目标区域扣除内边距后太小。");
    return result;
  }

  function targetPosition(bounds, destination, params) {
    const x = params.horizontal === "preserve"
      ? bounds.left
      : params.horizontal === "left"
      ? destination.left
      : params.horizontal === "right"
        ? destination.right - width(bounds)
        : centerX(destination) - width(bounds) / 2;
    const y = params.vertical === "preserve"
      ? bounds.top
      : params.vertical === "top"
      ? destination.top
      : params.vertical === "bottom"
        ? destination.bottom - height(bounds)
        : centerY(destination) - height(bounds) / 2;
    return { x, y };
  }

  async function selectLayer(layerId) {
    const result = await action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "layer", _id: Number(layerId) }],
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
    batchPlayError(result, "选择目标图层");
  }

  async function addLayerToSelection(layerId) {
    const result = await action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "layer", _id: Number(layerId) }],
      selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" }
    }], { synchronousExecution: true });
    batchPlayError(result, "追加选择图层");
  }

  async function transformLayer(layerId, scaleX, scaleY) {
    await withPreservedSelection(async () => {
      await selectLayer(layerId);
      const layer = findLiveLayer(layerId);
      try {
        await layer.scale(Number(scaleX), Number(scaleY), constants.AnchorPosition.MIDDLECENTER);
        return;
      } catch (nativeError) {
        // A few generated/background layer types do not expose DOM scale. The
        // explicit transform descriptor is the fallback, not the default path.
      }
      const result = await action.batchPlay([{
        _obj: "transform",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        width: { _unit: "percentUnit", _value: Number(scaleX) },
        height: { _unit: "percentUnit", _value: Number(scaleY) },
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
      batchPlayError(result, "缩放图层");
    });
  }

  async function translateLayer(layer, deltaX, deltaY) {
    await withPreservedSelection(async () => {
      await selectLayer(layer.id);
      try {
        await layer.translate(Number(deltaX), Number(deltaY));
        return;
      } catch (nativeError) {
        // Fall back only for layer types whose DOM implementation is absent.
      }
      const result = await action.batchPlay([{
        _obj: "transform",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: Number(deltaX) },
          vertical: { _unit: "pixelsUnit", _value: Number(deltaY) }
        },
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
      batchPlayError(result, "移动图层");
    });
  }

  async function moveLayerTo(layer, destination, params) {
    const layerId = Number(layer.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bounds = await freshBounds(layerId);
      const wanted = targetPosition(bounds, destination, params);
      const deltaX = wanted.x - bounds.left;
      const deltaY = wanted.y - bounds.top;
      if (Math.abs(deltaX) <= 0.35 && Math.abs(deltaY) <= 0.35) return;
      await translateLayer(findLiveLayer(layerId), deltaX, deltaY);
    }
  }

  async function fitLayerToReference(layer, beforeState, params) {
    const destination = referenceBounds(beforeState, params);
    const layerId = Number(layer.id);
    let bounds = await freshBounds(layer.id);
    const ratio = Math.min(width(destination) / Math.max(1, width(bounds)), height(destination) / Math.max(1, height(bounds)));
    const applied = params.allowUpscale ? ratio : Math.min(1, ratio);

    if (Math.abs(applied - 1) > 0.0005) {
      // Photoshop 2026 rejects a synthetic combined transform descriptor for
      // some editable text layers. Use the supported UXP scale operation first,
      // then read native bounds and position the result as a separate step.
      await transformLayer(layerId, applied * 100, applied * 100);
      await moveLayerTo(findLiveLayer(layerId), destination, params);
    } else {
      await moveLayerTo(findLiveLayer(layerId), destination, params);
    }
    return { referenceBounds: destination, scalePercent: applied * 100, fittedBounds: await freshBounds(layerId) };
  }

  function inside(actual, destination, tolerance) {
    return actual.left >= destination.left - tolerance && actual.top >= destination.top - tolerance
      && actual.right <= destination.right + tolerance && actual.bottom <= destination.bottom + tolerance;
  }

  function verifyAlignment(actual, destination, params, tolerance) {
    const wanted = targetPosition(actual, destination, params);
    if (params.horizontal !== "preserve") assertClose(actual.left, wanted.x, tolerance, "水平对齐验收失败");
    if (params.vertical !== "preserve") assertClose(actual.top, wanted.y, tolerance, "垂直对齐验收失败");
  }

  function makeColor(hex) {
    const color = new app.SolidColor();
    const rgb = hexToRgb(hex);
    color.rgb.red = rgb.red;
    color.rgb.green = rgb.green;
    color.rgb.blue = rgb.blue;
    return color;
  }

  function justificationValue(value) {
    return {
      left: constants.Justification.LEFT,
      center: constants.Justification.CENTER,
      right: constants.Justification.RIGHT,
      justify_all: constants.Justification.FULLYJUSTIFIED
    }[value];
  }

  function anchorValue(value) {
    return {
      top_left: constants.AnchorPosition.TOPLEFT,
      top_center: constants.AnchorPosition.TOPCENTER,
      top_right: constants.AnchorPosition.TOPRIGHT,
      middle_left: constants.AnchorPosition.MIDDLELEFT,
      middle_center: constants.AnchorPosition.MIDDLECENTER,
      middle_right: constants.AnchorPosition.MIDDLERIGHT,
      bottom_left: constants.AnchorPosition.BOTTOMLEFT,
      bottom_center: constants.AnchorPosition.BOTTOMCENTER,
      bottom_right: constants.AnchorPosition.BOTTOMRIGHT
    }[value || "middle_center"];
  }

  function percentBounds(params, state) {
    const scaleX = params.unit === "percent" ? Number(state.document.width) / 100 : 1;
    const scaleY = params.unit === "percent" ? Number(state.document.height) / 100 : 1;
    return {
      left: Number(params.left) * scaleX,
      top: Number(params.top) * scaleY,
      right: Number(params.right) * scaleX,
      bottom: Number(params.bottom) * scaleY
    };
  }

  function selectionTypeForMode(mode) {
    const normalized = String(mode || "replace").toLowerCase();
    const values = {
      replace: constants.SelectionType.REPLACE,
      add: constants.SelectionType.EXTEND || constants.SelectionType.ADD,
      subtract: constants.SelectionType.DIMINISH || constants.SelectionType.SUBTRACT,
      intersect: constants.SelectionType.INTERSECT
    };
    if (!values[normalized]) throw new Error(`不支持的选区合并模式：${normalized}`);
    return values[normalized];
  }

  function requireSelectionForMergeMode(target, params, beforeState) {
    requireDocument(target);
    if (String(params && params.mode || "replace") !== "replace" && !beforeState.selectionBounds) {
      throw new Error("加选、减选或取交集前必须已有活动选区。");
    }
  }

  function selectionChanged(beforeState, afterState) {
    return JSON.stringify(beforeState.selectionBounds) !== JSON.stringify(afterState.selectionBounds);
  }

  function requireSelection(target, params, beforeState) {
    requireDocument(target);
    if (!beforeState.selectionBounds) throw new Error("当前没有活动选区。");
  }

  function commandAcceptedResult(beforeState) {
    return { historyStateIdBefore: Number(beforeState.document.historyStateId || 0) };
  }

  function verifyCommandAccepted(afterState, result, label) {
    const afterId = Number(afterState.document.historyStateId || 0);
    if (result.historyStateIdBefore && afterId === result.historyStateIdBefore) {
      throw new Error(`${label}执行后Photoshop历史状态没有变化，不能判定为成功。`);
    }
  }

  const NATIVE_TEXT_POINT_FIELDS = Object.freeze({
    size: Object.freeze({ styleProperty: "textStyle", actionKey: "size" }),
    leading: Object.freeze({ styleProperty: "textStyle", actionKey: "leading" }),
    baselineShift: Object.freeze({ styleProperty: "textStyle", actionKey: "baselineShift" }),
    firstLineIndent: Object.freeze({ styleProperty: "paragraphStyle", actionKey: "firstLineIndent" }),
    leftIndent: Object.freeze({ styleProperty: "paragraphStyle", actionKey: "startIndent" }),
    rightIndent: Object.freeze({ styleProperty: "paragraphStyle", actionKey: "endIndent" }),
    spaceBefore: Object.freeze({ styleProperty: "paragraphStyle", actionKey: "spaceBefore" }),
    spaceAfter: Object.freeze({ styleProperty: "paragraphStyle", actionKey: "spaceAfter" })
  });

  function pointUnit(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label || "文字属性"}必须是有限数值。`);
    return { _unit: "pointsUnit", _value: number };
  }

  function nativeTextStyleTarget(styleProperty) {
    return [
      { _property: styleProperty, _ref: "property" },
      { _enum: "ordinal", _ref: "textLayer", _value: "targetEnum" }
    ];
  }

  function buildNativeTextStyleCommands(layerId, params) {
    const id = Number(layerId);
    if (!Number.isFinite(id) || id <= 0) throw new Error("原生文字属性写入缺少有效图层ID。");
    const values = params || {};
    const payloads = {
      textStyle: { _obj: "textStyle" },
      paragraphStyle: { _obj: "paragraphStyle" }
    };
    let textStyleCount = 0;
    let paragraphStyleCount = 0;

    for (const [parameterKey, definition] of Object.entries(NATIVE_TEXT_POINT_FIELDS)) {
      if (values[parameterKey] == null) continue;
      payloads[definition.styleProperty][definition.actionKey] = pointUnit(values[parameterKey], parameterKey);
      if (definition.styleProperty === "textStyle") textStyleCount += 1;
      else paragraphStyleCount += 1;
    }

    if (values.leading != null) payloads.textStyle.autoLeading = false;

    const commands = [];
    if (textStyleCount) {
      commands.push({
        _obj: "set",
        _target: nativeTextStyleTarget("textStyle"),
        to: payloads.textStyle,
        _options: { dialogOptions: "dontDisplay" }
      });
    }
    if (paragraphStyleCount) {
      commands.push({
        _obj: "set",
        _target: nativeTextStyleTarget("paragraphStyle"),
        to: payloads.paragraphStyle,
        _options: { dialogOptions: "dontDisplay" }
      });
    }
    return commands;
  }

  function assertNativeTextStyleResults(results, commands) {
    if (!Array.isArray(results) || results.length !== commands.length) {
      throw new Error(`Photoshop原生文字属性写入没有返回完整结果（期望${commands.length}项，实际${Array.isArray(results) ? results.length : 0}项）。`);
    }
    results.forEach((result, index) => {
      if (!result || typeof result !== "object") {
        const property = commands[index] && commands[index]._target && commands[index]._target[0]
          ? commands[index]._target[0]._property
          : "未知属性";
        throw new Error(`Photoshop原生文字属性${property}写入没有返回结果。`);
      }
      const failed = result._obj === "error"
        || result._obj === "failure"
        || Number(result.result) < 0
        || (typeof result.message === "string" && result.message.trim());
      if (failed) {
        const property = commands[index] && commands[index]._target && commands[index]._target[0]
          ? commands[index]._target[0]._property
          : "未知属性";
        throw new Error(`Photoshop原生文字属性${property}写入失败：${result.message || result.result || result._obj}`);
      }
    });
  }

  async function applyNativeTextStylePoints(layerId, params) {
    // Adobe's supported ActionJSON path targets the selected text layer.
    // Resolve and select the exact layer immediately before the write so a
    // stale active-layer selection cannot receive these properties.
    await selectLayer(layerId);
    // ActionJSON point fields accept the same final point values shown in the
    // Photoshop UI. Do not pre-divide by the layer transform: Photoshop
    // resolves that transform itself and exposes the result through implied*.
    const commands = buildNativeTextStyleCommands(layerId, params);
    if (!commands.length) return [];
    const results = await action.batchPlay(commands, { immediateRedraw: true });
    assertNativeTextStyleResults(results, commands);
    return results;
  }

  function installedPostScriptFont(name) {
    const wanted = String(name || "").trim().toLowerCase();
    const fonts = Array.from(app.fonts || []);
    const aliases = (font) => [
      font.postScriptName,
      font.name,
      font.family,
      font.familyName,
      font.style,
      font.styleName,
      [font.family, font.style].filter(Boolean).join(" "),
      [font.familyName, font.styleName].filter(Boolean).join(" ")
    ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    const exact = fonts.find((font) => aliases(font).includes(wanted));
    if (exact) return exact;
    const normalizedWanted = wanted.replace(/[\s_-]+/g, "");
    const fuzzy = fonts.filter((font) => aliases(font).some((alias) => alias.replace(/[\s_-]+/g, "") === normalizedWanted));
    return fuzzy.length === 1 ? fuzzy[0] : null;
  }

  function requireInstalledFont(params) {
    if (params && params.font != null) {
      const font = installedPostScriptFont(params.font);
      if (!font) throw new Error(`字体“${params.font}”未安装，或名称对应多个字重。请使用 Photoshop 字体面板中的完整名称。`);
      params.font = String(font.postScriptName || font.name || params.font);
    }
  }

  async function applyTextStyle(layer, params, beforeState) {
    const item = layer.textItem;
    const character = item.characterStyle;
    if (params.orientation != null) item.orientation = params.orientation === "vertical" ? constants.Orientation.VERTICAL : constants.Orientation.HORIZONTAL;
    if (params.color != null) character.color = makeColor(params.color);
    if (params.font != null) {
      const font = installedPostScriptFont(params.font);
      if (!font) throw new Error(`字体“${params.font}”未安装。请填写 Photoshop 字体面板中的 PostScript 名称。`);
      character.font = String(font.postScriptName || params.font);
    }
    if (params.tracking != null) character.tracking = Number(params.tracking);
    if (params.fauxBold != null) character.fauxBold = Boolean(params.fauxBold);
    if (params.fauxItalic != null) character.fauxItalic = Boolean(params.fauxItalic);
    if (params.horizontalScale != null) character.horizontalScale = Number(params.horizontalScale);
    if (params.verticalScale != null) character.verticalScale = Number(params.verticalScale);
    if (params.justification != null) item.paragraphStyle.justification = justificationValue(params.justification);
    if (params.hyphenation != null) item.paragraphStyle.hyphenation = Boolean(params.hyphenation);
    await applyNativeTextStylePoints(layer.id, params);
  }

  function verifyTextStyle(layer, params) {
    if (!layer || !layer.text) throw new Error("修改后目标不再是文字层。");
    const text = layer.text;
    if (params.size != null) {
      const sizes = Array.isArray(text.uiSizesPoints) ? text.uiSizesPoints : [];
      if (!sizes.length || sizes.some((size) => Math.abs(size - params.size) > 0.1)) {
        throw new Error(`字号验收失败，期望${params.size}点，Photoshop实际为${sizes.join("、") || "无法读取"}点。`);
      }
    }
    if (params.color != null) assertEqual(text.color, params.color, "文字颜色验收失败");
    if (params.font != null) assertEqual(String(text.font), String(params.font), "字体验收失败，字体可能未安装");
    const nativeReadback = text.nativeReadback || {};
    if (params.leading != null) assertClose(nativeReadback.leading, params.leading, 0.1, "行距验收失败");
    if (params.tracking != null) assertClose(text.tracking, params.tracking, 0.1, "字距验收失败");
    if (params.fauxBold != null) assertEqual(text.fauxBold, Boolean(params.fauxBold), "仿粗体验收失败");
    if (params.fauxItalic != null) assertEqual(text.fauxItalic, Boolean(params.fauxItalic), "仿斜体验收失败");
    if (params.horizontalScale != null) assertClose(text.horizontalScale, params.horizontalScale, 0.1, "文字水平缩放验收失败");
    if (params.verticalScale != null) assertClose(text.verticalScale, params.verticalScale, 0.1, "文字垂直缩放验收失败");
    if (params.baselineShift != null) assertClose(nativeReadback.baselineShift, params.baselineShift, 0.1, "基线偏移验收失败");
    if (params.justification != null && !String(text.justification).toLowerCase().includes(params.justification === "justify_all" ? "fully" : params.justification)) {
      throw new Error(`段落对齐验收失败，期望${params.justification}，实际${text.justification}。`);
    }
    if (params.orientation != null && !String(text.orientation).toLowerCase().includes(params.orientation)) {
      throw new Error(`文字方向验收失败，期望${params.orientation}，实际${text.orientation}。`);
    }
    if (params.hyphenation != null) assertEqual(Boolean(text.hyphenation), Boolean(params.hyphenation), "连字符验收失败");
    for (const key of ["firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"]) {
      if (params[key] != null) assertClose(nativeReadback[key], params[key], 0.1, `${key}验收失败`);
    }
  }

  async function arrangeTextGroup(group, beforeState, params) {
    const layers = liveDescendants(group).filter((layer) => {
      try { return layer.textItem && layer.textItem.contents != null; } catch (_) { return false; }
    });
    if (!layers.length) throw new Error(`图层组“${group.name}”中没有文字层。`);
    for (const layer of layers) await applyTextStyle(layer, params, beforeState);

    const destination = referenceBounds(beforeState, params);
    let entries = [];
    for (const layer of layers) entries.push({ layer, bounds: await freshBounds(layer.id) });
    const orientation = params.orientation || (params.arrangement === "compact" ? "horizontal" : null);

    if (params.arrangement === "compact") {
      const gap = Math.max(4, Math.min(width(destination), height(destination)) * 0.025);
      const verticalColumns = orientation === "vertical";
      const requiredWidth = verticalColumns
        ? entries.reduce((sum, entry) => sum + width(entry.bounds), 0) + gap * (entries.length - 1)
        : Math.max(...entries.map((entry) => width(entry.bounds)));
      const requiredHeight = verticalColumns
        ? Math.max(...entries.map((entry) => height(entry.bounds)))
        : entries.reduce((sum, entry) => sum + height(entry.bounds), 0) + gap * (entries.length - 1);
      const ratio = Math.min(width(destination) / Math.max(1, requiredWidth), height(destination) / Math.max(1, requiredHeight));
      const applied = params.allowUpscale ? ratio : Math.min(1, ratio);
      if (Math.abs(applied - 1) > 0.0005) {
        for (const entry of entries) await transformLayer(entry.layer.id, applied * 100, applied * 100);
      }
      entries = [];
      for (const layer of layers) entries.push({ layer, bounds: await freshBounds(layer.id) });
      if (verticalColumns) {
        const total = entries.reduce((sum, entry) => sum + width(entry.bounds), 0) + gap * (entries.length - 1);
        let cursor = centerX(destination) - total / 2;
        for (const entry of entries) {
          await translateLayer(entry.layer, cursor - entry.bounds.left, centerY(destination) - centerY(entry.bounds));
          cursor += width(entry.bounds) + gap;
        }
      } else {
        const total = entries.reduce((sum, entry) => sum + height(entry.bounds), 0) + gap * (entries.length - 1);
        let cursor = centerY(destination) - total / 2;
        for (const entry of entries) {
          await translateLayer(entry.layer, centerX(destination) - centerX(entry.bounds), cursor - entry.bounds.top);
          cursor += height(entry.bounds) + gap;
        }
      }
    } else {
      const originalUnion = unionBounds(entries.map((entry) => entry.bounds));
      const ratio = Math.min(width(destination) / Math.max(1, width(originalUnion)), height(destination) / Math.max(1, height(originalUnion)));
      const applied = params.allowUpscale ? ratio : Math.min(1, ratio);
      for (const entry of entries) {
        if (Math.abs(applied - 1) > 0.0005) await transformLayer(entry.layer.id, applied * 100, applied * 100);
        const current = await freshBounds(entry.layer.id);
        const desiredX = centerX(destination) + (centerX(entry.bounds) - centerX(originalUnion)) * applied;
        const desiredY = centerY(destination) + (centerY(entry.bounds) - centerY(originalUnion)) * applied;
        await translateLayer(entry.layer, desiredX - centerX(current), desiredY - centerY(current));
      }
    }

    const finalBounds = [];
    for (const layer of layers) finalBounds.push(await freshBounds(layer.id));
    const finalUnion = unionBounds(finalBounds);
    const wanted = targetPosition(finalUnion, destination, params);
    const correctionX = wanted.x - finalUnion.left;
    const correctionY = wanted.y - finalUnion.top;
    if (Math.abs(correctionX) > 0.1 || Math.abs(correctionY) > 0.1) {
      for (const layer of layers) await translateLayer(layer, correctionX, correctionY);
    }
    return { affectedLayerIds: layers.map((layer) => Number(layer.id)), referenceBounds: destination };
  }

  function capability(definition) {
    const selectionProviders = new Set([
      "selection.select_all",
      "selection.rectangle",
      "selection.ellipse",
      "selection.polygon",
      "selection.subject",
      "selection.subject_region",
      "selection.color_range",
      "selection.visual_object",
      "selection.load_layer"
    ]);
    const originalExecute = definition.execute;
    const wrappedExecute = selectionProviders.has(definition.id) && typeof originalExecute === "function"
      ? async (context) => {
        const token = context && context.params && context.params.selectionSessionToken;
        if (!token) return originalExecute(context);
        if (!selectionSessions || typeof selectionSessions.restore !== "function") {
          throw new Error("v9.8 权威选区会话模块没有加载，已停止执行。");
        }
        const session = await selectionSessions.restore(token);
        return {
          ...(session.metadata || {}),
          selectedPixels: session.selectedPixels,
          selectionBounds: session.selectionBounds,
          selectionSessionToken: token,
          authoritativeSelection: true,
          documentWide: false
        };
      }
      : originalExecute;
    return Object.freeze({ version: "9.8", reversible: true, risk: "low", ...definition, execute: wrappedExecute });
  }

  function subtreeIds(state, layerId) {
    return [Number(layerId), ...stateDescendants(state, layerId).map((layer) => Number(layer.id))];
  }

  function createCapability(id, label, kind, create) {
    return capability({
      id,
      label,
      targetTypes: ["document"],
      preflight: requireDocument,
      async execute({ params }) {
        const layer = await create(params);
        return { resultLayerId: Number(layer.id) };
      },
      verify({ beforeState, afterState, params, result }) {
        const layer = stateLayer(afterState, result.resultLayerId);
        if (!layer) throw new Error(`${label}后没有在图层树中找到结果。`);
        if (afterState.flatLayers.length !== beforeState.flatLayers.length + 1) throw new Error(`${label}产生了预期之外的图层数量变化。`);
        if (params.name && layer.name !== params.name) throw new Error(`${label}后的图层名称不一致。`);
        if (kind === "text") {
          if (!layer.text || layer.text.contents !== params.content) throw new Error("新建文字层内容验收失败。");
          verifyTextStyle(layer, params);
        }
        if (kind === "group" && !isGroup(layer)) throw new Error("新建结果不是图层组。");
        return `${label}已在图层树中确认：${layer.path}。`;
      }
    });
  }

  const definitions = [
    createCapability("layer.create_pixel", "新建像素图层", "pixel", (params) => app.activeDocument.createPixelLayer({ name: params.name })),
    createCapability("layer.create_group", "新建图层组", "group", (params) => app.activeDocument.createLayerGroup({ name: params.name })),
    createCapability("text.create", "新建文字图层", "text", async (params) => {
      const layer = await app.activeDocument.createTextLayer({ name: params.name, contents: params.content });
      // Photoshop may replace a new text layer's requested name with its contents.
      if (params.name) layer.name = params.name;
      await applyTextStyle(layer, params, { document: { resolution: numericValue(app.activeDocument.resolution) } });
      return layer;
    }),
    capability({
      id: "layer.duplicate",
      label: "复制图层",
      targetTypes: ["layer"],
      authorizedScope: "none",
      preflight: requireReadable,
      async execute({ target, beforeState }) {
        const duplicated = await findLiveLayer(target.id).duplicate();
        return {
          resultLayerId: Number(duplicated.id),
          resultScope: "subtree",
          sourceLayerCount: subtreeIds(beforeState, target.id).length
        };
      },
      verify({ beforeState, afterState, target, result }) {
        const source = stateLayer(beforeState, target.id);
        const duplicate = stateLayer(afterState, result.resultLayerId);
        if (!source || !duplicate || duplicate.kind !== source.kind) throw new Error("复制后没有找到类型一致的副本。");
        const expected = subtreeIds(beforeState, target.id).length;
        if (afterState.flatLayers.length !== beforeState.flatLayers.length + expected) throw new Error("复制产生了预期之外的图层数量变化。");
        return `已创建“${duplicate.name}”副本，原图层保持存在。`;
      }
    }),
    capability({
      id: "layer.delete",
      label: "删除图层",
      targetTypes: ["layer"],
      risk: "high",
      preflight: requireEditable,
      async execute({ target, beforeState }) {
        const deletedLayerIds = subtreeIds(beforeState, target.id);
        await findLiveLayer(target.id).delete();
        return { deletedLayerIds, affectedLayerIds: deletedLayerIds };
      },
      verify({ beforeState, afterState, result }) {
        if (result.deletedLayerIds.some((id) => stateLayer(afterState, id))) throw new Error("删除后目标或其子图层仍然存在。");
        if (afterState.flatLayers.length !== beforeState.flatLayers.length - result.deletedLayerIds.length) throw new Error("删除影响了目标以外的图层数量。");
        return `目标图层及其${result.deletedLayerIds.length - 1}个子图层已确认删除。`;
      }
    }),
    capability({
      id: "layer.rename",
      label: "重命名图层",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) { findLiveLayer(target.id).name = params.name; return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) {
        const layer = stateLayer(afterState, target.id);
        if (!layer) throw new Error("重命名后目标图层不存在。");
        assertEqual(layer.name, params.name, "图层名称验收失败");
        return `图层名称已修改为“${params.name}”。`;
      }
    }),
    capability({
      id: "layer.set_visibility",
      label: "显示或隐藏图层",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) { findLiveLayer(target.id).visible = params.visible; return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) {
        assertEqual(stateLayer(afterState, target.id).visible, params.visible, "图层可见性验收失败");
        return params.visible ? "目标图层已显示。" : "目标图层已隐藏。";
      }
    }),
    capability({
      id: "layer.set_opacity",
      label: "修改图层不透明度",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) { findLiveLayer(target.id).opacity = params.opacity; return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) {
        // Photoshop quantizes layer opacity to 8 bits. A requested integer
        // percentage can read back up to about 0.196 percentage points away.
        assertClose(stateLayer(afterState, target.id).opacity, params.opacity, 0.21, "不透明度验收失败");
        return `目标图层不透明度已调整为${params.opacity}%。`;
      }
    }),
    capability({
      id: "layer.set_fill_opacity",
      label: "修改填充不透明度",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) { findLiveLayer(target.id).fillOpacity = params.fillOpacity; return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) {
        // Photoshop stores this as an 8-bit value, so the closest readable value
        // can differ by up to roughly 0.196 percentage points.
        assertClose(stateLayer(afterState, target.id).fillOpacity, params.fillOpacity, 0.21, "填充不透明度验收失败");
        return `填充不透明度已调整为${params.fillOpacity}%。`;
      }
    }),
    capability({
      id: "layer.set_blend_mode",
      label: "修改图层混合模式",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) {
        const result = await action.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _id: target.id }], to: { _obj: "layer", mode: { _enum: "blendMode", _value: params.blendMode } }, _options: { dialogOptions: "dontDisplay" } }], {});
        batchPlayError(result, "修改图层混合模式");
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        assertEqual(String(stateLayer(afterState, target.id).blendMode).toLowerCase(), params.blendMode.toLowerCase(), "混合模式验收失败");
        return `混合模式已修改为${params.blendMode}。`;
      }
    }),
    capability({
      id: "layer.set_lock",
      label: "修改图层锁定状态",
      targetTypes: ["layer"],
      preflight(target, params) {
        if (!target) throw new Error("目标图层不存在。");
        if (target.locks && target.locks.all && !(params.lock === "all" && params.locked === false)) throw new Error("图层完全锁定时只能先解除完全锁定。");
      },
      async execute({ target, params }) {
        const layer = findLiveLayer(target.id);
        const property = { all: "allLocked", pixels: "pixelsLocked", position: "positionLocked", transparentPixels: "transparentPixelsLocked" }[params.lock];
        layer[property] = params.locked;
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        assertEqual(Boolean(stateLayer(afterState, target.id).locks[params.lock]), params.locked, "锁定状态验收失败");
        return `图层${params.locked ? "已锁定" : "已解锁"}（${params.lock}）。`;
      }
    }),
    capability({
      id: "layer.move_by",
      label: "移动图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target) { requireEditable(target, { position: true }); },
      async execute({ target, params }) {
        await translateLayer(findLiveLayer(target.id), params.deltaX, params.deltaY);
        return { resultLayerId: target.id };
      },
      verify({ beforeState, afterState, target, params }) {
        const before = boundsOfState(stateLayer(beforeState, target.id));
        const after = boundsOfState(stateLayer(afterState, target.id));
        assertClose(after.left, before.left + params.deltaX, 1.1, "水平移动验收失败");
        assertClose(after.top, before.top + params.deltaY, 1.1, "垂直移动验收失败");
        return `图层已移动（X ${params.deltaX}px，Y ${params.deltaY}px）。`;
      }
    }),
    capability({
      id: "layer.scale",
      label: "缩放图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target) { requireEditable(target, { position: true }); },
      async execute({ target, params }) {
        await transformLayer(target.id, params.scaleX, params.scaleY);
        return { resultLayerId: target.id };
      },
      verify({ beforeState, afterState, target, params }) {
        const before = boundsOfState(stateLayer(beforeState, target.id));
        const after = boundsOfState(stateLayer(afterState, target.id));
        const toleranceX = Math.max(2.1, width(before) * params.scaleX / 100 * 0.015);
        const toleranceY = Math.max(2.1, height(before) * params.scaleY / 100 * 0.015);
        assertClose(width(after), width(before) * params.scaleX / 100, toleranceX, "水平缩放验收失败");
        assertClose(height(after), height(before) * params.scaleY / 100, toleranceY, "垂直缩放验收失败");
        return `图层已缩放为X ${params.scaleX}%、Y ${params.scaleY}%。`;
      }
    }),
    capability({
      id: "layer.rotate",
      label: "旋转图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target) { requireEditable(target, { position: true }); },
      async execute({ target, params }) {
        const beforePixelDigest = await pixelDigest(target.id);
        await withPreservedSelection(async () => {
          await selectLayer(target.id);
          await findLiveLayer(target.id).rotate(params.angle, anchorValue(params.anchor));
        });
        return { resultLayerId: target.id, beforePixelDigest, afterPixelDigest: await pixelDigest(target.id) };
      },
      verify({ afterState, target, params, result }) {
        if (!stateLayer(afterState, target.id)) throw new Error("旋转后目标图层不存在。");
        if (result.beforePixelDigest === result.afterPixelDigest) throw new Error("旋转前后像素摘要相同，不能判定为成功。");
        return `图层已围绕${params.anchor}旋转${params.angle}度。`;
      }
    }),
    capability({
      id: "layer.flip",
      label: "翻转图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target) { requireEditable(target, { position: true }); },
      async execute({ target, params }) {
        const beforePixelDigest = await pixelDigest(target.id);
        const flipAxis = constants.FlipAxis || {};
        const axis = params.axis === "horizontal"
          ? (flipAxis.HORIZONTAL || "horizontal")
          : (flipAxis.VERTICAL || "vertical");
        await withPreservedSelection(async () => {
          await selectLayer(target.id);
          await findLiveLayer(target.id).flip(axis);
        });
        return { resultLayerId: target.id, beforePixelDigest, afterPixelDigest: await pixelDigest(target.id) };
      },
      verify({ afterState, target, params, result }) {
        if (!stateLayer(afterState, target.id)) throw new Error("翻转后目标图层不存在。");
        if (result.beforePixelDigest === result.afterPixelDigest) throw new Error("翻转前后像素摘要相同，不能判定为成功。");
        return `图层已${params.axis === "horizontal" ? "水平" : "垂直"}翻转。`;
      }
    }),
    capability({
      id: "layer.skew",
      label: "斜切图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target) { requireEditable(target, { position: true }); },
      async execute({ target, params }) {
        const beforePixelDigest = await pixelDigest(target.id);
        await withPreservedSelection(async () => {
          await selectLayer(target.id);
          await findLiveLayer(target.id).skew(params.angleH, params.angleV);
        });
        return { resultLayerId: target.id, beforePixelDigest, afterPixelDigest: await pixelDigest(target.id) };
      },
      verify({ afterState, target, params, result }) {
        if (!stateLayer(afterState, target.id)) throw new Error("斜切后目标图层不存在。");
        if (result.beforePixelDigest === result.afterPixelDigest) throw new Error("斜切前后像素摘要相同，不能判定为成功。");
        return `图层已斜切（水平${params.angleH}度，垂直${params.angleV}度）。`;
      }
    }),
    capability({
      id: "layer.rasterize",
      label: "栅格化图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      risk: "high",
      preflight: requireEditable,
      async execute({ target, params }) {
        const requestedTarget = params.target === "smart_object" ? "entire_layer" : params.target;
        const rasterizeType = {
          entire_layer: constants.RasterizeType.ENTIRELAYER,
          text: constants.RasterizeType.TEXTCONTENTS,
          shape: constants.RasterizeType.SHAPE,
          layer_style: constants.RasterizeType.LAYERSTYLE
        }[requestedTarget];
        if (rasterizeType == null) throw new Error(`当前Photoshop不支持栅格化类型${requestedTarget}。`);
        const beforePixelDigest = await pixelDigest(target.id);
        await selectLayer(target.id);
        await findLiveLayer(target.id).rasterize(rasterizeType);
        return { resultLayerId: target.id, beforePixelDigest, afterPixelDigest: await pixelDigest(target.id) };
      },
      verify({ beforeState, afterState, target, params, result }) {
        const before = stateLayer(beforeState, target.id);
        const after = stateLayer(afterState, target.id);
        if (!after) throw new Error("栅格化后目标图层不存在。");
        const kindChanged = String(before && before.kind || "") !== String(after.kind || "");
        const descriptorChanged = String(before && before.integrityDescriptorDigest || "") !== String(after.integrityDescriptorDigest || "");
        const pixelsChanged = result.beforePixelDigest && result.afterPixelDigest && result.beforePixelDigest !== result.afterPixelDigest;
        if ((params.target === "entire_layer" || params.target === "text") && before.text && after.text) throw new Error("文字图层栅格化验收失败，结果仍可编辑文字。");
        if (params.target === "shape" && !kindChanged) throw new Error("形状栅格化验收失败，图层类型没有改变。");
        if (params.target === "layer_style" && !descriptorChanged) throw new Error("图层样式栅格化验收失败，样式描述没有改变。");
        if (params.target === "entire_layer" && !kindChanged && !descriptorChanged && !pixelsChanged) throw new Error("整层栅格化没有产生可验证的类型、描述或像素变化。");
        return `图层已按${params.target}栅格化并回读确认。`;
      }
    }),
    capability({
      id: "layer.convert_to_smart_object",
      label: "转换为智能对象",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      risk: "high",
      preflight: requireEditable,
      async execute({ target, beforeState }) {
        const replacedLayerIds = subtreeIds(beforeState, target.id);
        await selectLayer(target.id);
        const response = await action.batchPlay([{
          _obj: "newPlacedLayer",
          _options: { dialogOptions: "dontDisplay" }
        }], {});
        batchPlayError(response, "转换为智能对象");
        const layer = app.activeDocument.activeLayers[0];
        return {
          resultLayerId: Number(layer && layer.id),
          resultScope: "subtree",
          replacedLayerId: Number(target.id),
          affectedLayerIds: replacedLayerIds
        };
      },
      verify({ beforeState, afterState, result }) {
        const layer = stateLayer(afterState, result.resultLayerId);
        if (!layer || !String(layer.kind).toLowerCase().includes("smart")) throw new Error("转换后没有读取到智能对象图层。");
        const replacedCount = new Set(result.affectedLayerIds || [result.replacedLayerId]).size;
        const resultCount = subtreeIds(afterState, result.resultLayerId).length;
        if (afterState.flatLayers.length !== beforeState.flatLayers.length - replacedCount + resultCount) {
          throw new Error("转换智能对象时发生了预期之外的图层数量变化。");
        }
        return `图层“${layer.name}”已转换为智能对象。`;
      }
    }),
    capability({
      id: "layer.set_clipping_mask",
      label: "设置或释放剪贴蒙版",
      targetTypes: ["layer"],
      risk: "medium",
      preflight: requireEditable,
      async execute({ target, params }) {
        findLiveLayer(target.id).isClippingMask = params.enabled;
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        const layer = stateLayer(afterState, target.id);
        if (!layer) throw new Error("设置剪贴蒙版后目标图层不存在。");
        assertEqual(Boolean(layer.clippingMask), params.enabled, "剪贴蒙版状态验收失败");
        return params.enabled ? "目标图层已设为剪贴蒙版。" : "目标图层已释放剪贴蒙版。";
      }
    }),
    capability({
      id: "layer.merge_down",
      label: "向下合并图层",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      risk: "high",
      preflight(target, params, beforeState) {
        requireEditable(target);
        const below = adjacentSiblingBelow(beforeState, target);
        if (!below) throw new Error("目标图层下方没有可合并的同级图层。");
        requireEditable(below);
      },
      async execute({ target, beforeState }) {
        const below = adjacentSiblingBelow(beforeState, target);
        if (!below) throw new Error("执行前没有找到目标图层正下方的同级图层。");
        const mergedSourceLayerIds = [...new Set([
          ...subtreeIds(beforeState, target.id),
          ...subtreeIds(beforeState, below.id)
        ])];
        await selectLayer(target.id);
        await addLayerToSelection(below.id);
        const response = await action.batchPlay([{
          _obj: "mergeLayersNew",
          _options: { dialogOptions: "dontDisplay" }
        }], {});
        batchPlayError(response, "向下合并图层");
        const layer = app.activeDocument.activeLayers[0];
        if (!layer) throw new Error("Photoshop合并后没有返回结果图层。");
        return {
          resultLayerId: Number(layer.id),
          resultScope: "subtree",
          mergedSourceId: Number(target.id),
          mergedBelowId: Number(below.id),
          affectedLayerIds: mergedSourceLayerIds
        };
      },
      verify({ beforeState, afterState, target, result }) {
        const merged = stateLayer(afterState, result.resultLayerId);
        if (!merged) throw new Error("向下合并后没有找到结果图层。");
        const beforeSiblingCount = beforeState.flatLayers.filter((layer) => Number(layer.parentId) === Number(target.parentId)).length;
        const afterSiblingCount = afterState.flatLayers.filter((layer) => Number(layer.parentId) === Number(target.parentId)).length;
        if (afterSiblingCount !== beforeSiblingCount - 1) throw new Error(`向下合并后的同级图层数量不正确：合并前${beforeSiblingCount}，合并后${afterSiblingCount}。`);
        if (Number(merged.parentId) !== Number(target.parentId)) throw new Error("向下合并结果离开了原图层层级。");
        return "目标图层已与下方同级图层合并。";
      }
    }),
    capability({
      id: "layer.reorder",
      label: "调整图层前后顺序",
      targetTypes: ["layer"],
      preflight: requireEditable,
      async execute({ target, params }) {
        const layer = findLiveLayer(target.id);
        if (params.position === "front") await layer.bringToFront(); else await layer.sendToBack();
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        const layer = stateLayer(afterState, target.id);
        const siblings = afterState.flatLayers.filter((item) => item.parentId === layer.parentId);
        const expected = params.position === "front" ? Math.min(...siblings.map((item) => item.index)) : Math.max(...siblings.map((item) => item.index));
        assertEqual(layer.index, expected, "图层顺序验收失败");
        return params.position === "front" ? "目标图层已置于同级最前方。" : "目标图层已置于同级最后方。";
      }
    }),
    capability({
      id: "layer.move_to_group",
      label: "把图层移入指定图层组",
      targetTypes: ["layer"],
      preflight(target, params, beforeState) {
        requireEditable(target, { position: true });
        if (params.groupResultOf && params.groupId == null) return;
        const destination = resolveDestinationGroup(beforeState, params);
        if (Number(destination.id) === Number(target.id)) throw new Error("不能把图层组移入自身。");
        let parentId = destination.parentId;
        while (parentId != null) {
          if (Number(parentId) === Number(target.id)) throw new Error("不能把图层组移入自己的子图层组。");
          const parent = stateLayer(beforeState, parentId);
          parentId = parent ? parent.parentId : null;
        }
      },
      async execute({ target, params, beforeState }) {
        const destinationState = resolveDestinationGroup(beforeState, params);
        const layer = findLiveLayer(target.id);
        const destination = findLiveLayer(destinationState.id);
        if (!layer || !destination) throw new Error("执行前目标图层或目标图层组已经不存在。");
        await layer.move(destination, constants.ElementPlacement.PLACEINSIDE);
        return {
          resultLayerId: target.id,
          destinationGroupId: Number(destinationState.id)
        };
      },
      verify({ afterState, target, params, result }) {
        const layer = stateLayer(afterState, target.id);
        if (!layer) throw new Error("移动后目标图层不存在。");
        assertEqual(Number(layer.parentId), Number(result.destinationGroupId), "图层所属组验收失败");
        return `图层已移入图层组“${params.groupName}”。`;
      }
    }),
    capability({
      id: "layer.align_to_reference",
      label: "对齐图层到目标区域",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target, params, beforeState) { requireEditable(target, { position: true }); referenceBounds(beforeState, params); },
      async execute({ target, params, beforeState }) {
        const destination = referenceBounds(beforeState, params);
        await moveLayerTo(findLiveLayer(target.id), destination, params);
        return { resultLayerId: target.id, referenceBounds: destination };
      },
      verify({ afterState, target, params, result }) {
        verifyAlignment(boundsOfState(stateLayer(afterState, target.id)), result.referenceBounds, params, 1.5);
        return `图层已按${params.horizontal}/${params.vertical}对齐到${params.reference === "selection" ? "当前选区" : "画布"}。`;
      }
    }),
    capability({
      id: "layer.fit_to_reference",
      label: "缩放并放入目标区域",
      targetTypes: ["layer"],
      authorizedScope: "subtree",
      preflight(target, params, beforeState) { requireEditable(target, { position: true }); referenceBounds(beforeState, params); },
      async execute({ target, params, beforeState }) {
        return { resultLayerId: target.id, ...(await fitLayerToReference(findLiveLayer(target.id), beforeState, params)) };
      },
      verify({ afterState, target, params, result }) {
        // The execute result is a synchronous native readback taken immediately
        // after the transform. Prefer it over a later DOM snapshot, which can
        // lag behind Photoshop 2026 after geometry changes.
        const actual = result.fittedBounds || boundsOfState(stateLayer(afterState, target.id));
        if (!inside(actual, result.referenceBounds, 1.5)) throw new Error("目标图层没有完整进入参考区域。");
        verifyAlignment(actual, result.referenceBounds, params, 1.5);
        return `图层已完整放入${params.reference === "selection" ? "当前选区" : "画布"}。`;
      }
    }),
    capability({
      id: "text.set_content",
      label: "修改文字内容",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params }) { findLiveLayer(target.id).textItem.contents = params.content; return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) {
        assertEqual(stateLayer(afterState, target.id).text.contents, params.content, "文字内容验收失败");
        return `文字内容已修改为“${params.content}”。`;
      }
    }),
    capability({
      id: "text.set_color",
      label: "修改文字颜色",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params }) { findLiveLayer(target.id).textItem.characterStyle.color = makeColor(params.color); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), params); return `文字颜色已修改为${params.color}。`; }
    }),
    capability({
      id: "text.set_size",
      label: "修改文字字号",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) { await applyTextStyle(findLiveLayer(target.id), params, beforeState); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), params); return `文字字号已调整为${params.size}点。`; }
    }),
    ...[
      ["text.set_font", "修改文字字体", "font"],
      ["text.set_leading", "修改文字行距", "leading"],
      ["text.set_tracking", "修改文字字距", "tracking"],
      ["text.set_justification", "修改段落对齐", "justification"],
      ["text.set_baseline_shift", "修改文字基线偏移", "baselineShift"]
    ].map(([id, label, key]) => capability({
      id,
      label,
      targetTypes: ["text_layer"],
      preflight(target, params) { requireEditable(target, { text: true }); requireInstalledFont(params); },
      async execute({ target, params, beforeState }) { await applyTextStyle(findLiveLayer(target.id), params, beforeState); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), params); return `${label}已通过Photoshop属性回读验收（${params[key]}）。`; }
    })),
    ...[
      ["text.set_faux_bold", "修改仿粗体", "fauxBold"],
      ["text.set_faux_italic", "修改仿斜体", "fauxItalic"]
    ].map(([id, label, key]) => capability({
      id,
      label,
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) { await applyTextStyle(findLiveLayer(target.id), { [key]: params.enabled }, beforeState); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), { [key]: params.enabled }); return `${label}已${params.enabled ? "启用" : "关闭"}。`; }
    })),
    ...[
      ["text.set_horizontal_scale", "修改文字水平缩放", "horizontalScale"],
      ["text.set_vertical_scale", "修改文字垂直缩放", "verticalScale"]
    ].map(([id, label, key]) => capability({
      id,
      label,
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) { await applyTextStyle(findLiveLayer(target.id), { [key]: params.scale }, beforeState); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), { [key]: params.scale }); return `${label}已调整为${params.scale}%。`; }
    })),
    capability({
      id: "text.set_hyphenation",
      label: "修改文字连字符",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) {
        await applyTextStyle(findLiveLayer(target.id), { hyphenation: params.enabled }, beforeState);
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        verifyTextStyle(stateLayer(afterState, target.id), { hyphenation: params.enabled });
        return `文字连字符已${params.enabled ? "启用" : "关闭"}。`;
      }
    }),
    capability({
      id: "text.set_paragraph_spacing",
      label: "修改段落缩进与间距",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) {
        await applyTextStyle(findLiveLayer(target.id), params, beforeState);
        return { resultLayerId: target.id };
      },
      verify({ afterState, target, params }) {
        verifyTextStyle(stateLayer(afterState, target.id), params);
        return "段落缩进与段前段后间距已逐项回读验收。";
      }
    }),
    capability({
      id: "text.set_orientation",
      label: "修改文字横竖排",
      targetTypes: ["text_layer"],
      preflight(target) { requireEditable(target, { text: true }); },
      async execute({ target, params, beforeState }) { await applyTextStyle(findLiveLayer(target.id), params, beforeState); return { resultLayerId: target.id }; },
      verify({ afterState, target, params }) { verifyTextStyle(stateLayer(afterState, target.id), params); return params.orientation === "vertical" ? "文字已经改为竖排。" : "文字已经改为横排。"; }
    }),
    capability({
      id: "text.fit_to_reference",
      label: "文字适配目标区域",
      targetTypes: ["text_layer"],
      preflight(target, params, beforeState) { requireEditable(target, { text: true, position: true }); referenceBounds(beforeState, params); },
      async execute({ target, params, beforeState }) { return { resultLayerId: target.id, ...(await fitLayerToReference(findLiveLayer(target.id), beforeState, params)) }; },
      verify({ afterState, target, params, result }) {
        const actual = result.fittedBounds || boundsOfState(stateLayer(afterState, target.id));
        if (!inside(actual, result.referenceBounds, 1.5)) throw new Error("文字没有完整进入参考区域。");
        verifyAlignment(actual, result.referenceBounds, params, 1.5);
        return `文字已缩放并完整放入${params.reference === "selection" ? "当前选区" : "画布"}。`;
      }
    }),
    capability({
      id: "group.set_text_style",
      label: "批量修改组内文字",
      targetTypes: ["group"],
      authorizedScope: "self",
      preflight(target, params, beforeState) { requireEditableGroup(target, beforeState, { position: false }); requireInstalledFont(params); },
      async execute({ target, params, beforeState }) {
        const layers = liveDescendants(findLiveLayer(target.id)).filter((layer) => {
          try { return layer.textItem && layer.textItem.contents != null; } catch (_) { return false; }
        });
        for (const layer of layers) await applyTextStyle(layer, params, beforeState);
        return { resultLayerId: target.id, affectedLayerIds: layers.map((layer) => Number(layer.id)) };
      },
      verify({ afterState, params, result }) {
        for (const id of result.affectedLayerIds) verifyTextStyle(stateLayer(afterState, id), params);
        return `组内${result.affectedLayerIds.length}个文字层已逐一回读并通过验收。`;
      }
    }),
    capability({
      id: "group.fit_text_to_reference",
      label: "排列并适配组内文字",
      targetTypes: ["group"],
      authorizedScope: "self",
      preflight(target, params, beforeState) { requireEditableGroup(target, beforeState, { position: true }); referenceBounds(beforeState, params); },
      async execute({ target, params, beforeState }) {
        return { resultLayerId: target.id, ...(await arrangeTextGroup(findLiveLayer(target.id), beforeState, params)) };
      },
      verify({ afterState, params, result }) {
        const bounds = result.affectedLayerIds.map((id) => boundsOfState(stateLayer(afterState, id)));
        if (bounds.some((item) => !inside(item, result.referenceBounds, 2))) throw new Error("组内仍有文字没有完整进入参考区域。");
        for (const id of result.affectedLayerIds) verifyTextStyle(stateLayer(afterState, id), params);
        return `组内${result.affectedLayerIds.length}个文字层已排列到目标区域并逐一验收。`;
      }
    }),
    ...[
      ["filter.gaussian_blur", "高斯模糊", async (layer, params) => layer.applyGaussianBlur(params.radius)],
      ["filter.motion_blur", "动感模糊", async (layer, params) => layer.applyMotionBlur(params.angle, params.distance)],
      ["filter.add_noise", "添加杂色", async (layer, params) => layer.applyAddNoise(
        params.amount,
        params.distribution === "gaussian" ? constants.NoiseDistribution.GAUSSIAN : constants.NoiseDistribution.UNIFORM,
        params.monochromatic
      )],
      ["filter.high_pass", "高反差保留", async (layer, params) => layer.applyHighPass(params.radius)],
      ["filter.unsharp_mask", "USM锐化", async (layer, params) => layer.applyUnSharpMask(params.amount, params.radius, params.threshold)],
      ["filter.sharpen", "锐化", async (layer) => layer.applySharpen()]
    ].map(([id, label, runner]) => capability({
      id,
      label,
      targetTypes: ["layer"],
      authorizedScope: "none",
      risk: "medium",
      preflight(target, params, beforeState) {
        requireReadable(target);
        if (isGroup(target)) throw new Error(`${label}不能直接作用于图层组，请选择组内具体图层。`);
        if (params.useSelection && !beforeState.selectionBounds) throw new Error(`${label}要求使用当前选区，但执行前没有活动选区。`);
        if (params.useSelection && target.hasLayerMask == null) {
          throw new Error(`无法确认图层“${target.name}”是否已有用户蒙版，不能安全建立局部滤镜副本。`);
        }
        if (params.useSelection && target.hasLayerMask === true) {
          throw new Error(`图层“${target.name}”已有用户蒙版；为避免覆盖或错误合并蒙版，局部滤镜已停止。`);
        }
      },
      async execute({ target, params, beforeState }) {
        const source = findLiveLayer(target.id);
        if (!source) throw new Error(`滤镜源图层“${target.name}”不存在。`);
        const duplicate = await source.duplicate();
        if (!duplicate || !Number.isFinite(Number(duplicate.id))) throw new Error(`${label}未能创建非破坏性图层副本。`);
        for (const property of ["allLocked", "pixelsLocked", "transparentPixelsLocked"]) {
          try { if (duplicate[property] === true) duplicate[property] = false; } catch (_) {}
        }
        const resultLayerId = Number(duplicate.id);
        const digestBounds = params.useSelection ? beforeState.selectionBounds : null;
        const expectedSelection = params.useSelection
          ? await selectionMaskProof(beforeState.selectionBounds, beforeState)
          : null;
        const beforePixelDigest = await pixelDigest(resultLayerId, digestBounds);
        const runFilter = async () => {
          await selectLayer(resultLayerId);
          const resultLayer = findLiveLayer(resultLayerId);
          if (!resultLayer) throw new Error(`${label}的非破坏性副本在执行前消失。`);
          await runner(resultLayer, params);
        };
        if (params.useSelection) {
          await withRetainedSelection(async () => {
            await runFilter();
            await makeUserMask(resultLayerId, "revealSelection");
          });
        }
        else await withPreservedSelection(runFilter);
        const afterPixelDigest = await pixelDigest(resultLayerId, digestBounds);
        return {
          resultLayerId,
          resultScope: "subtree",
          sourceLayerId: Number(target.id),
          beforePixelDigest,
          afterPixelDigest,
          usedSelection: params.useSelection === true,
          createdSelectionMask: params.useSelection === true,
          expectedSelection
        };
      },
      async verify({ afterState, target, result }) {
        if (!stateLayer(afterState, target.id)) throw new Error(`${label}后源图层不存在。`);
        if (!stateLayer(afterState, result.resultLayerId)) throw new Error(`${label}后没有找到非破坏性结果副本。`);
        if (!result.beforePixelDigest || result.beforePixelDigest === result.afterPixelDigest) {
          throw new Error(`${label}执行前后像素摘要相同，不能判定为成功。`);
        }
        if (result.createdSelectionMask) {
          await verifySelectionMask(result.resultLayerId, `${label}结果副本`, result.expectedSelection);
          return `${label}已在非破坏性副本上按获准选区执行，且结果蒙版与该选区一致。`;
        }
        return `${label}已在非破坏性副本上对整层执行，源图层保持不变。`;
      }
    })),
    capability({
      id: "selection.select_all",
      label: "全选画布",
      targetTypes: ["document"],
      preflight: requireDocument,
      async execute() { await app.activeDocument.selection.selectAll(); return { documentWide: false }; },
      verify({ afterState }) {
        if (!afterState.selectionBounds) throw new Error("全选后没有活动选区。");
        return "已建立覆盖当前画布/活动画板的选区。";
      }
    }),
    capability({
      id: "selection.deselect",
      label: "取消选区",
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute() { await app.activeDocument.selection.deselect(); return { documentWide: false }; },
      verify({ afterState }) {
        if (afterState.selectionBounds) throw new Error("取消选区验收失败，仍存在活动选区。");
        return "活动选区已取消。";
      }
    }),
    ...[
      ["selection.rectangle", "建立矩形选区", "selectRectangle"],
      ["selection.ellipse", "建立椭圆选区", "selectEllipse"]
    ].map(([id, label, method]) => capability({
      id,
      label,
      targetTypes: ["document"],
      preflight: requireSelectionForMergeMode,
      async execute({ params, beforeState }) {
        const bounds = percentBounds(params, beforeState);
        const beforeSelectionDigest = params.mode === "replace" ? null : await selectionDigest();
        await app.activeDocument.selection[method](bounds, selectionTypeForMode(params.mode), params.feather, params.antiAlias);
        return { selectionBounds: bounds, mode: params.mode, beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ afterState, result }) {
        if (result.mode !== "replace") {
          if (result.beforeSelectionDigest === result.afterSelectionDigest) throw new Error(`${label}的${result.mode}模式没有改变选区摘要。`);
          return `${label}已按${result.mode}模式执行，并通过选区像素摘要回读。`;
        }
        const actual = afterState.selectionBounds;
        if (!actual) throw new Error(`${label}后没有活动选区。`);
        for (const key of ["left", "top", "right", "bottom"]) assertClose(actual[key], result.selectionBounds[key], 1.5, `${label}${key}验收失败`);
        return `${label}已按像素边界回读验收。`;
      }
    })),
    capability({
      id: "selection.polygon",
      label: "建立不规则多边形选区",
      targetTypes: ["document"],
      preflight: requireSelectionForMergeMode,
      async execute({ params, beforeState }) {
        const scaleX = params.unit === "percent" ? Number(beforeState.document.width) / 100 : 1;
        const scaleY = params.unit === "percent" ? Number(beforeState.document.height) / 100 : 1;
        const points = params.points.map((point) => ({ x: Number(point.x) * scaleX, y: Number(point.y) * scaleY }));
        const beforeSelectionDigest = params.mode === "replace" ? null : await selectionDigest();
        await app.activeDocument.selection.selectPolygon(points, selectionTypeForMode(params.mode), params.feather, params.antiAlias);
        return {
          mode: params.mode,
          beforeSelectionDigest,
          afterSelectionDigest: await selectionDigest(),
          selectionBounds: {
            left: Math.min(...points.map((point) => point.x)),
            top: Math.min(...points.map((point) => point.y)),
            right: Math.max(...points.map((point) => point.x)),
            bottom: Math.max(...points.map((point) => point.y))
          }
        };
      },
      verify({ afterState, result }) {
        if (result.mode !== "replace") {
          if (result.beforeSelectionDigest === result.afterSelectionDigest) throw new Error(`多边形选区的${result.mode}模式没有改变选区摘要。`);
          return `多边形选区已按${result.mode}模式执行，并通过选区像素摘要回读。`;
        }
        if (!afterState.selectionBounds) throw new Error("建立不规则选区后没有活动选区。");
        for (const key of ["left", "top", "right", "bottom"]) assertClose(afterState.selectionBounds[key], result.selectionBounds[key], 2, `不规则选区${key}验收失败`);
        return "不规则多边形选区已由Photoshop建立并回读边界。";
      }
    }),
    capability({
      id: "selection.subject",
      label: "选择画面主体",
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireDocument,
      async execute({ params }) {
        const result = await action.batchPlay([{
          _obj: "autoCutout",
          sampleAllLayers: Boolean(params.sampleAllLayers),
          _options: { dialogOptions: "silent" }
        }], {});
        batchPlayError(result, "选择主体");
        return {};
      },
      verify({ afterState }) {
        if (!afterState.selectionBounds) throw new Error("Photoshop没有识别出可用主体。请改用当前手工选区或批注多边形。");
        return "Photoshop已识别主体并生成活动选区。";
      }
    }),
    capability({
      id: "selection.subject_region",
      label: "选择主体后裁剪到区域（兼容旧计划）",
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireDocument,
      async execute({ params, beforeState }) { return selectSubjectRegion(params, beforeState); },
      verify({ afterState, result, params }) {
        if (!afterState.selectionBounds || !result.selectedPixels) throw new Error(`Photoshop没有在“${params.description}”范围内生成有效主体选区。`);
        return `已先运行 Photoshop“选择主体”，再把结果裁剪到“${params.description}”范围；这不是 Photoshop 对象选择工具。`;
      }
    }),
    capability({
      id: "selection.color_range",
      label: "按颜色范围建立选区",
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireDocument,
      async execute({ params, beforeState }) { return selectColorRange(params, beforeState); },
      verify({ afterState, result, params }) {
        if (!afterState.selectionBounds || !result.selectedPixels) throw new Error("按颜色范围选择后没有活动选区。");
        return `已按${params.color}建立颜色范围选区，命中${result.selectedPixels}个像素。`;
      }
    }),
    capability({
      id: "selection.visual_object",
      label: "自动定位画面对象",
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireDocument,
      async execute({ params, beforeState }) { return selectVisualObject(params, beforeState); },
      verify({ afterState, result, params }) {
        if (!afterState.selectionBounds || !result.selectedPixels) throw new Error(`自动定位“${params.description}”后没有生成有效选区。`);
        const search = result.searchBounds;
        const actual = afterState.selectionBounds;
        // The generated mask is physically clipped to searchBounds. Photoshop can
        // report wider soft-edge bounds after antialiasing/feathering, especially
        // in high-resolution documents, so only reject a material escape.
        const slack = Math.max(12, Number(params.feather || 0) * 6 + 4);
        if (actual.left < search.left - slack || actual.top < search.top - slack || actual.right > search.right + slack || actual.bottom > search.bottom + slack) {
          throw new Error(`自动定位“${params.description}”的选区越出了允许搜索范围。`);
        }
        return `已自动定位“${params.description}”，命中${result.selectedPixels}个目标像素（搜索区覆盖${Math.round(result.coverage * 100)}%）。`;
      }
    }),
    capability({
      id: "selection.invert",
      label: "反选",
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute() {
        const beforeSelectionDigest = await selectionDigest();
        await app.activeDocument.selection.inverse();
        return { beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ result }) {
        if (result.beforeSelectionDigest === result.afterSelectionDigest) throw new Error("反选前后选区摘要相同，不能判定为成功。");
        return "选区已反选。";
      }
    }),
    ...[
      ["selection.expand", "扩展选区", "expand"],
      ["selection.contract", "收缩选区", "contract"],
      ["selection.feather", "羽化选区", "feather"]
    ].map(([id, label, method]) => capability({
      id,
      label,
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute({ params }) {
        const beforeSelectionDigest = await selectionDigest();
        if (params.applyAtCanvasBounds) await app.activeDocument.selection[method](params.by, true);
        else await app.activeDocument.selection[method](params.by);
        return { beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ beforeState, afterState, result }) {
        if (!afterState.selectionBounds) throw new Error(`${label}后选区消失，参数可能过大。`);
        // A low-resolution digest cannot reliably see a 1-5px edge change on a large poster.
        // Expand/contract have measurable bounds; feather is accepted when Photoshop
        // completes without throwing and leaves a valid selection.
        if (method !== "feather" && !selectionChanged(beforeState, afterState)) throw new Error(`${label}后选区边界没有变化。`);
        return `${label}已由Photoshop执行并保留有效选区。`;
      }
    })),
    capability({
      id: "selection.border",
      label: "建立选区边界",
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute({ params }) {
        const beforeSelectionDigest = await selectionDigest();
        await app.activeDocument.selection.selectBorder(params.width);
        return { beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ afterState, result }) {
        if (!afterState.selectionBounds) throw new Error("建立选区边界后选区消失。");
        if (result.beforeSelectionDigest === result.afterSelectionDigest) throw new Error("建立边界前后选区摘要相同，不能判定为成功。");
        return "已按指定宽度建立选区边界。";
      }
    }),
    capability({
      id: "selection.grow",
      label: "扩大选取相似相邻像素",
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute({ params }) {
        const beforeSelectionDigest = await selectionDigest();
        await app.activeDocument.selection.grow(params.tolerance, params.antiAlias);
        return { beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ afterState, result }) {
        if (!afterState.selectionBounds) throw new Error("扩大选取后选区消失。");
        return result.beforeSelectionDigest === result.afterSelectionDigest
          ? "Photoshop已接受扩大选取命令；当前像素内容未产生可量化的选区变化。"
          : "已扩大选取相似的相邻像素。";
      }
    }),
    capability({
      id: "selection.smooth",
      label: "平滑选区",
      targetTypes: ["document"],
      preflight: requireSelection,
      async execute({ params }) {
        const beforeSelectionDigest = await selectionDigest();
        if (params.applyAtCanvasBounds) await app.activeDocument.selection.smooth(params.radius, true);
        else await app.activeDocument.selection.smooth(params.radius);
        return { beforeSelectionDigest, afterSelectionDigest: await selectionDigest() };
      },
      verify({ afterState, result }) {
        if (!afterState.selectionBounds) throw new Error("平滑后选区消失，半径可能过大。");
        return result.beforeSelectionDigest === result.afterSelectionDigest
          ? "Photoshop已接受平滑命令；当前边缘在缩略摘要中变化不明显。"
          : "选区已平滑并保持有效。";
      }
    }),
    capability({
      id: "selection.load_layer",
      label: "载入图层透明度为选区",
      targetTypes: ["layer"],
      preflight: requireReadable,
      async execute({ target }) { await app.activeDocument.selection.load(findLiveLayer(target.id)); return { resultLayerId: target.id }; },
      verify({ afterState, target }) {
        if (!afterState.selectionBounds) throw new Error(`图层“${target.name}”没有产生可用选区，可能没有不透明像素。`);
        return `已把图层“${target.name}”的不透明度载入为选区。`;
      }
    }),
    ...[
      ["mask.create_from_selection", "按当前选区创建图层蒙版", "revealSelection"],
      ["mask.create_reveal_all", "创建显示全部图层蒙版", "revealAll"],
      ["mask.create_hide_all", "创建隐藏全部图层蒙版", "hideAll"]
    ].map(([id, label, mode]) => capability({
      id,
      label,
      targetTypes: ["layer"],
      risk: "medium",
      preflight(target, params, beforeState) {
        requireEditable(target);
        if (target.hasLayerMask == null) throw new Error(`无法确认图层“${target.name}”是否已有用户蒙版，已停止执行。`);
        if (target.hasLayerMask === true) throw new Error(`图层“${target.name}”已经有用户蒙版。`);
        if (mode === "revealSelection" && !beforeState.selectionBounds) throw new Error("按选区创建蒙版前必须存在活动选区。");
      },
      async execute({ target }) {
        if (await maskExists(target.id)) throw new Error(`图层“${target.name}”已经有用户蒙版。`);
        await makeUserMask(target.id, mode);
        return { resultLayerId: target.id, maskMode: mode };
      },
      async verify({ target, result }) {
        const stats = await layerMaskStats(target.id);
        if (result.maskMode === "hideAll" && stats.selected !== 0) throw new Error("隐藏全部蒙版不是全黑蒙版。");
        if (result.maskMode !== "hideAll" && stats.selected === 0) throw new Error(`${label}生成了空蒙版。`);
        return `${label}已创建并读取到有效用户蒙版。`;
      }
    })),
    capability({
      id: "mask.invert",
      label: "反相图层蒙版",
      targetTypes: ["layer"],
      risk: "medium",
      preflight(target, params, beforeState) {
        requireEditable(target, params, beforeState);
        if (target.hasLayerMask == null) throw new Error(`无法确认图层“${target.name}”是否有用户蒙版，已停止执行。`);
        if (target.hasLayerMask !== true) throw new Error(`图层“${target.name}”没有可反相的用户蒙版。`);
      },
      async execute({ target }) {
        const beforeMask = await layerMaskStats(target.id);
        await invertUserMask(target.id);
        return { resultLayerId: target.id, beforeMask, afterMask: await layerMaskStats(target.id) };
      },
      verify({ result }) {
        if (result.beforeMask.digest === result.afterMask.digest) throw new Error("反相前后蒙版摘要相同。");
        return "图层蒙版已反相并通过像素摘要验收。";
      }
    }),
    ...[
      ["mask.delete", "删除图层蒙版", false],
      ["mask.apply", "应用图层蒙版", true]
    ].map(([id, label, apply]) => capability({
      id,
      label,
      targetTypes: ["layer"],
      risk: "high",
      preflight(target, params, beforeState) {
        requireEditable(target, params, beforeState);
        if (target.hasLayerMask == null) throw new Error(`无法确认图层“${target.name}”是否有用户蒙版，已停止执行。`);
        if (target.hasLayerMask !== true) throw new Error(`图层“${target.name}”没有可${label}的用户蒙版。`);
      },
      async execute({ target }) {
        if (!(await maskExists(target.id))) throw new Error(`图层“${target.name}”没有可${label}的用户蒙版。`);
        await removeUserMask(target.id, apply);
        return { resultLayerId: target.id };
      },
      async verify({ target, afterState }) {
        const afterTarget = stateLayer(afterState, target.id);
        if (!afterTarget || afterTarget.hasLayerMask == null) throw new Error(`${label}后无法确认用户蒙版状态，不能判定为成功。`);
        if (afterTarget.hasLayerMask === true) throw new Error(`${label}后用户蒙版仍然存在。`);
        return `${label}已完成，并确认用户蒙版不再存在。`;
      }
    })),
    ...[
      ["mask.set_density", "设置图层蒙版密度", "density", "layerMaskDensity", 0.21],
      ["mask.set_feather", "设置图层蒙版羽化", "feather", "layerMaskFeather", 0.11]
    ].map(([id, label, paramName, propertyName, tolerance]) => capability({
      id,
      label,
      targetTypes: ["layer"],
      risk: "medium",
      preflight(target, params, beforeState) {
        requireEditable(target, params, beforeState);
        if (target.hasLayerMask == null) throw new Error(`无法确认图层“${target.name}”是否有用户蒙版，已停止执行。`);
        if (target.hasLayerMask !== true) throw new Error(`图层“${target.name}”没有可调整的用户蒙版。`);
      },
      async execute({ target, params }) {
        if (!(await maskExists(target.id))) throw new Error(`图层“${target.name}”没有可调整的用户蒙版。`);
        const layer = findLiveLayer(target.id);
        layer[propertyName] = params[paramName];
        return { resultLayerId: target.id, expectedValue: params[paramName] };
      },
      verify({ afterState, target, result }) {
        const layer = stateLayer(afterState, target.id);
        if (!layer) throw new Error(`${label}后目标图层不存在。`);
        assertClose(Number(layer[propertyName]), Number(result.expectedValue), tolerance, `${label}验收失败`);
        return `${label}已设为${result.expectedValue}并回读确认。`;
      }
    })),
    ...[
      ["adjustment.brightness_contrast", "亮度/对比度", createBrightnessContrastAdjustment],
      ["adjustment.levels", "色阶", createLevelsAdjustment],
      ["adjustment.curves", "曲线", createCurvesAdjustment],
      ["adjustment.vibrance", "自然饱和度", createVibranceAdjustment],
      ["adjustment.exposure", "曝光度", createExposureAdjustment],
      ["adjustment.black_white", "黑白", createBlackWhiteAdjustment],
      ["adjustment.hue_saturation", "色相/饱和度", createHueSaturationAdjustment]
    ].map(([id, label, createAdjustment]) => capability({
      id,
      label: `对当前选区建立${label}调整层`,
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireSelection,
      async execute({ params, beforeState }) {
        const selectionBounds = beforeState.selectionBounds;
        const expectedSelection = await selectionMaskProof(selectionBounds, beforeState);
        const beforeRegionDigest = await compositeRegionDigest(selectionBounds);
        const resultLayerId = await withRetainedSelection(() => createAdjustment(params));
        return {
          resultLayerId,
          selectionBounds,
          expectedSelection,
          beforeRegionDigest,
          afterRegionDigest: await waitForCompositeChange(selectionBounds, beforeRegionDigest)
        };
      },
      async verify({ afterState, result }) {
        const layer = stateLayer(afterState, result.resultLayerId);
        if (!layer) throw new Error(`${label}调整层没有创建成功。`);
        await verifySelectionMask(result.resultLayerId, `${label}调整层`, result.expectedSelection);
        if (result.beforeRegionDigest === result.afterRegionDigest) {
          throw new Error(`${label}调整层虽然已创建，但目标区域的可见像素没有变化，不能判定任务成功。`);
        }
        return `已创建带当前选区蒙版的${label}调整层“${layer.name}”。`;
      }
    })),
    capability({
      id: "adjustment.colorize",
      label: "对当前选区建立颜色化图层",
      targetTypes: ["document"],
      risk: "medium",
      preflight: requireSelection,
      async execute({ params, beforeState }) {
        const selectionBounds = beforeState.selectionBounds;
        const expectedSelection = await selectionMaskProof(selectionBounds, beforeState);
        const beforeRegionDigest = await compositeRegionDigest(selectionBounds);
        const resultLayerId = await withRetainedSelection(() => createColorizeLayer(params));
        return {
          resultLayerId,
          selectionBounds,
          expectedSelection,
          beforeRegionDigest,
          afterRegionDigest: await waitForCompositeChange(selectionBounds, beforeRegionDigest)
        };
      },
      async verify({ afterState, result, params }) {
        const layer = stateLayer(afterState, result.resultLayerId);
        if (!layer) throw new Error("局部改色图层没有创建成功。");
        await verifySelectionMask(result.resultLayerId, "局部改色图层", result.expectedSelection);
        if (result.beforeRegionDigest === result.afterRegionDigest) {
          throw new Error("改色层虽然已创建，但目标区域的可见像素没有变化，不能判定任务成功。");
        }
        assertClose(layer.opacity, params.opacity, 0.21, "局部改色不透明度验收失败");
        const expectedMode = String(params.blendMode || "normal").toLowerCase();
        if (String(layer.blendMode).toLowerCase() !== expectedMode) throw new Error(`局部改色混合模式验收失败，预期${expectedMode}，实际为${layer.blendMode}。`);
        return `已用${params.color}对当前选区建立可回退的局部改色层。`;
      }
    }),
    capability({
      id: "document.resize_image",
      label: "调整图像大小",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight: requireDocument,
      async execute({ params, beforeState }) {
        const widthValue = params.width == null ? beforeState.document.width * params.height / beforeState.document.height : params.width;
        const heightValue = params.height == null ? beforeState.document.height * params.width / beforeState.document.width : params.height;
        const result = await action.batchPlay([{
          _obj: "imageSize",
          width: { _unit: "pixelsUnit", _value: Number(widthValue) },
          height: { _unit: "pixelsUnit", _value: Number(heightValue) },
          resolution: { _unit: "densityUnit", _value: Number(params.resolution || beforeState.document.resolution) },
          constrainProportions: Boolean(params.constrainProportions),
          scaleStyles: true,
          interpolation: { _enum: "interpolationType", _value: "automaticInterpolation" },
          _options: { dialogOptions: "dontDisplay" }
        }], {});
        batchPlayError(result, "调整图像大小");
        return { documentWide: true, expectedWidth: widthValue, expectedHeight: heightValue };
      },
      verify({ afterState, params, result }) {
        assertClose(afterState.document.width, result.expectedWidth, 1, "图像宽度验收失败");
        assertClose(afterState.document.height, result.expectedHeight, 1, "图像高度验收失败");
        if (params.resolution != null) assertClose(afterState.document.resolution, params.resolution, 0.1, "分辨率验收失败");
        return `图像大小已调整为${Math.round(result.expectedWidth)}×${Math.round(result.expectedHeight)}px。`;
      }
    }),
    capability({
      id: "document.resize_canvas",
      label: "调整画布大小",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight: requireDocument,
      async execute({ params }) {
        await app.activeDocument.resizeCanvas(params.width, params.height, anchorValue(params.anchor));
        return { documentWide: true };
      },
      verify({ afterState, params }) {
        assertClose(afterState.document.width, params.width, 1, "画布宽度验收失败");
        assertClose(afterState.document.height, params.height, 1, "画布高度验收失败");
        return `画布大小已调整为${Math.round(params.width)}×${Math.round(params.height)}px。`;
      }
    }),
    capability({
      id: "document.crop",
      label: "裁剪文档",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight(target, params, beforeState) {
        requireDocument(target);
        if (params.reference === "selection" && !beforeState.selectionBounds) throw new Error("当前没有用于裁剪的活动选区。");
      },
      async execute({ params, beforeState }) {
        const bounds = params.reference === "selection" ? beforeState.selectionBounds : percentBounds(params, beforeState);
        await app.activeDocument.crop(bounds);
        return { documentWide: true, cropBounds: bounds, expectedWidth: width(bounds), expectedHeight: height(bounds) };
      },
      verify({ afterState, result }) {
        assertClose(afterState.document.width, result.expectedWidth, 1.5, "裁剪后宽度验收失败");
        assertClose(afterState.document.height, result.expectedHeight, 1.5, "裁剪后高度验收失败");
        return `文档已裁剪为${Math.round(result.expectedWidth)}×${Math.round(result.expectedHeight)}px。`;
      }
    }),
    capability({
      id: "document.rotate",
      label: "旋转画布",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight: requireDocument,
      async execute({ params }) {
        const beforeDocumentDigest = await documentDigest();
        await app.activeDocument.rotate(params.angle);
        return { documentWide: true, beforeDocumentDigest, afterDocumentDigest: await documentDigest() };
      },
      verify({ beforeState, afterState, params, result }) {
        if (result.beforeDocumentDigest === result.afterDocumentDigest) throw new Error("旋转前后画面摘要相同，不能判定为成功。");
        const quarterTurn = Math.abs(Math.abs(params.angle) % 180 - 90) < 0.001;
        if (quarterTurn) {
          assertClose(afterState.document.width, beforeState.document.height, 1.5, "旋转后宽度验收失败");
          assertClose(afterState.document.height, beforeState.document.width, 1.5, "旋转后高度验收失败");
        }
        return `画布已顺时针旋转${params.angle}度。`;
      }
    }),
    capability({
      id: "document.trim",
      label: "裁切画布边缘",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight: requireDocument,
      async execute({ params, beforeState }) {
        const type = {
          transparent: constants.TrimType.TRANSPARENT,
          top_left: constants.TrimType.TOPLEFT,
          bottom_right: constants.TrimType.BOTTOMRIGHT
        }[params.type];
        await app.activeDocument.trim(type, params.top, params.left, params.bottom, params.right);
        return { documentWide: true, ...commandAcceptedResult(beforeState) };
      },
      verify({ beforeState, afterState, result }) {
        if (afterState.document.width === beforeState.document.width && afterState.document.height === beforeState.document.height) {
          throw new Error("裁切后画布尺寸没有变化，当前边缘可能没有可裁切内容。");
        }
        return `画布边缘已裁切为${afterState.document.width}×${afterState.document.height}px。`;
      }
    }),
    capability({
      id: "document.reveal_all",
      label: "显示全部画布外内容",
      targetTypes: ["document"],
      risk: "medium",
      documentWide: true,
      preflight: requireDocument,
      async execute({ beforeState }) { await app.activeDocument.revealAll(); return { documentWide: true, ...commandAcceptedResult(beforeState) }; },
      verify({ beforeState, afterState, result }) {
        if (afterState.document.width === beforeState.document.width && afterState.document.height === beforeState.document.height) {
          throw new Error("显示全部后画布尺寸没有变化，当前可能没有画布外内容。");
        }
        return `画布已扩展为${afterState.document.width}×${afterState.document.height}px以显示全部内容。`;
      }
    }),
    capability({
      id: "document.merge_visible",
      label: "合并可见图层",
      targetTypes: ["document"],
      risk: "high",
      documentWide: true,
      preflight(target, params, beforeState) {
        requireDocument(target, params, beforeState);
        const visibleCount = (beforeState.flatLayers || []).filter((layer) => layer.visible !== false).length;
        if (visibleCount < 2) throw new Error("当前不足两个可见图层，无法执行合并可见图层。");
      },
      async execute() {
        const merged = await app.activeDocument.mergeVisibleLayers();
        const layer = merged || app.activeDocument.activeLayers[0];
        return { documentWide: true, resultLayerId: Number(layer && layer.id) };
      },
      verify({ beforeState, afterState, result }) {
        if (!stateLayer(afterState, result.resultLayerId)) throw new Error("合并可见图层后没有找到结果图层。");
        if (afterState.flatLayers.length >= beforeState.flatLayers.length) throw new Error("合并可见图层后图层数量没有减少。");
        return "可见图层已合并，并确认图层数量减少。";
      }
    }),
    capability({
      id: "document.flatten",
      label: "拼合图像",
      targetTypes: ["document"],
      risk: "high",
      documentWide: true,
      preflight(target, params, beforeState) {
        requireDocument(target, params, beforeState);
        if ((beforeState.flatLayers || []).length < 2) throw new Error("当前文档只有一个图层，无需拼合图像。");
      },
      async execute() {
        await app.activeDocument.flatten();
        const layer = app.activeDocument.activeLayers[0];
        return { documentWide: true, resultLayerId: Number(layer && layer.id) };
      },
      verify({ afterState, result }) {
        if (afterState.flatLayers.length !== 1) throw new Error(`拼合图像验收失败，当前仍有${afterState.flatLayers.length}个图层。`);
        if (!stateLayer(afterState, result.resultLayerId)) throw new Error("拼合图像后没有找到结果图层。");
        return "文档已拼合为单个图层并回读确认。";
      }
    }),
    capability({
      id: "document.export",
      label: "导出图像",
      targetTypes: ["document"],
      reversible: false,
      risk: "high",
      preflight: requireDocument,
      async execute({ params, resource }) {
        if (!resource || !resource.file) throw new Error("尚未选择导出位置。");
        const options = params.format === "jpg"
          ? { quality: params.quality, embedColorProfile: true }
          : { embedColorProfile: true };
        const saver = app.activeDocument.saveAs[params.format];
        if (typeof saver !== "function") throw new Error(`Photoshop不支持${params.format}导出方法。`);
        await saver.call(app.activeDocument.saveAs, resource.file, options, params.asCopy);
        return { exportedFile: resource.file, exportedName: resource.file.name };
      },
      async verify({ result }) {
        const metadata = await result.exportedFile.getMetadata();
        if (!metadata || Number(metadata.size || 0) < 1) throw new Error("导出文件不存在或为空。");
        return `已确认导出文件“${result.exportedName}”写入磁盘（${metadata.size}字节）。`;
      }
    })
  ];

  const registry = new Map(definitions.map((item) => [item.id, item]));

  async function materializeSelectionCandidate(actionId, params, beforeState, resolvedTarget) {
    const item = registry.get(String(actionId || ""));
    if (!item || typeof item.execute !== "function" || !String(item.id).startsWith("selection.")) {
      throw new Error(`无法把“${actionId}”建立为候选选区。`);
    }
    const candidateParams = { ...(params || {}) };
    delete candidateParams.selectionSessionToken;
    const target = resolvedTarget || { id: Number(beforeState && beforeState.document && beforeState.document.id), kind: "document", name: "当前文档" };
    const candidateState = String(candidateParams.mode || "replace") === "replace" || !selectionSessions
      ? beforeState
      : { ...beforeState, selectionBounds: selectionSessions.activeBounds() || beforeState.selectionBounds };
    if (typeof item.preflight === "function") item.preflight(target, candidateParams, candidateState);
    const result = await item.execute({ target, params: candidateParams, beforeState: candidateState });
    const refinements = Array.isArray(candidateParams._preLockSelectionRefinements)
      ? candidateParams._preLockSelectionRefinements
      : [];
    for (const refinement of refinements) {
      const values = refinement.params || {};
      if (refinement.action === "selection.invert") await app.activeDocument.selection.inverse();
      else if (refinement.action === "selection.expand") {
        if (values.applyAtCanvasBounds) await app.activeDocument.selection.expand(Number(values.by), true);
        else await app.activeDocument.selection.expand(Number(values.by));
      } else if (refinement.action === "selection.contract") {
        if (values.applyAtCanvasBounds) await app.activeDocument.selection.contract(Number(values.by), true);
        else await app.activeDocument.selection.contract(Number(values.by));
      } else if (refinement.action === "selection.feather") {
        if (values.applyAtCanvasBounds) await app.activeDocument.selection.feather(Number(values.by), true);
        else await app.activeDocument.selection.feather(Number(values.by));
      }
      else if (refinement.action === "selection.border") await app.activeDocument.selection.selectBorder(Number(values.width));
      else if (refinement.action === "selection.grow") await app.activeDocument.selection.grow(Number(values.tolerance), values.antiAlias !== false);
      else if (refinement.action === "selection.smooth") {
        if (values.applyAtCanvasBounds) await app.activeDocument.selection.smooth(Number(values.radius), true);
        else await app.activeDocument.selection.smooth(Number(values.radius));
      }
    }
    return { ...(result || {}), preLockRefinementsApplied: refinements.map((item) => item.action) };
  }

  function get(id) {
    const item = registry.get(id);
    if (!item) throw new Error(`能力“${id}”未注册，已停止执行。`);
    return item;
  }

  function catalog() {
    return definitions.map((item) => ({ id: item.id, label: item.label, targetTypes: item.targetTypes, risk: item.risk }));
  }

  return {
    get,
    catalog,
    findLiveLayer,
    stateLayer,
    stateDescendants,
    subtreeIds,
    referenceBounds,
    probeVisualObject,
    registerSemanticMask,
    materializeSelectionCandidate,
    clearSemanticMasks,
    releaseSemanticMask,
    decodeSegmentationRleCrop,
    pointUnit,
    batchPlayError,
    nativeTextStyleTarget,
    buildNativeTextStyleCommands,
    assertNativeTextStyleResults,
    applyNativeTextStylePoints,
    assertClose
  };
});
