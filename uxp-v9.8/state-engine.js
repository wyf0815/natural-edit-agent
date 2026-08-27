(function (root, factory) {
  root.PhotoshopAssistantV8State = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const { app, action, constants, imaging } = require("photoshop");

  function numberValue(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.value === "number") return value.value;
    if (value && typeof value._value === "number") return value._value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function read(getter, fallback) {
    try {
      const value = getter();
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  // Safety-sensitive properties are three-state values. `null` means that
  // Photoshop did not let us prove either true or false; callers must not
  // silently treat that as an unlocked/unmasked layer.
  function readSafetyBoolean(getter) {
    try {
      const value = getter();
      return value == null ? null : Boolean(value);
    } catch (_) {
      return null;
    }
  }

  function safeDispose(value) {
    if (value && typeof value.dispose === "function") value.dispose();
  }

  function hashBytes(data) {
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 1) {
      hash ^= Number(data[index]) & 255;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function boundsValue(bounds) {
    if (!bounds) return null;
    return {
      left: numberValue(bounds.left),
      top: numberValue(bounds.top),
      right: numberValue(bounds.right),
      bottom: numberValue(bounds.bottom)
    };
  }

  function rgbHex(color) {
    const rgb = read(() => color.rgb, null);
    if (!rgb) return null;
    const hex = [rgb.red, rgb.green, rgb.blue]
      .map((value) => Math.max(0, Math.min(255, Math.round(numberValue(value)))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    return `#${hex}`;
  }

  function enumName(value) {
    const raw = String(value == null ? "" : value);
    const tail = raw.split(".").pop();
    return tail || raw;
  }

  function describeText(layer, resolution) {
    const textItem = read(() => layer.textItem, null);
    if (!textItem || textItem.contents == null) return null;
    const character = read(() => textItem.characterStyle, null);
    const paragraph = read(() => textItem.paragraphStyle, null);
    const toPoints = (value) => numberValue(value) * 72 / Math.max(1, Number(resolution || 72));
    return {
      contents: String(textItem.contents),
      orientation: enumName(read(() => textItem.orientation, "")),
      type: read(() => textItem.isParagraphText, false) ? "paragraph" : "point",
      clickPoint: read(() => {
        const point = textItem.textClickPoint;
        return { x: numberValue(point.x), y: numberValue(point.y) };
      }, null),
      font: character ? String(read(() => character.font, "")) : "",
      size: character ? numberValue(read(() => character.size, 0)) : 0,
      color: character ? rgbHex(read(() => character.color, null)) : null,
      leading: character ? toPoints(read(() => character.leading, 0)) : 0,
      tracking: character ? numberValue(read(() => character.tracking, 0)) : 0,
      fauxBold: character ? Boolean(read(() => character.fauxBold, false)) : false,
      fauxItalic: character ? Boolean(read(() => character.fauxItalic, false)) : false,
      horizontalScale: character ? numberValue(read(() => character.horizontalScale, 100)) : 100,
      verticalScale: character ? numberValue(read(() => character.verticalScale, 100)) : 100,
      baselineShift: character ? toPoints(read(() => character.baselineShift, 0)) : 0,
      justification: paragraph ? enumName(read(() => paragraph.justification, "")) : "",
      hyphenation: paragraph ? Boolean(read(() => paragraph.hyphenation, false)) : false,
      firstLineIndent: paragraph ? toPoints(read(() => paragraph.firstLineIndent, 0)) : 0,
      leftIndent: paragraph ? toPoints(read(() => paragraph.leftIndent, 0)) : 0,
      rightIndent: paragraph ? toPoints(read(() => paragraph.rightIndent, 0)) : 0,
      spaceBefore: paragraph ? toPoints(read(() => paragraph.spaceBefore, 0)) : 0,
      spaceAfter: paragraph ? toPoints(read(() => paragraph.spaceAfter, 0)) : 0
    };
  }

  function actionUnitValue(value, fallback, options) {
    if (typeof value === "number") return value;
    if (value && typeof value._value === "number") {
      const raw = Number(value._value);
      const unit = String(value._unit || "").toLowerCase();
      if (unit.includes("pixel")) {
        const resolution = Math.max(1, Number(options && options.resolution || 72));
        const scale = Math.max(0.0001, Math.abs(Number(options && options.scale || 1)));
        return raw * 72 / resolution / scale;
      }
      return raw;
    }
    return fallback == null ? null : fallback;
  }

  function actionStyleUnit(style, key, impliedKey, options) {
    const sources = [
      style,
      style && style.baseParentStyle
    ].filter(Boolean);
    // Photoshop exposes implied* as the final value shown in its UI after
    // text transforms have been resolved. Prefer it whenever available.
    for (const source of sources) {
      const implied = impliedKey ? actionUnitValue(source[impliedKey], null, options) : null;
      if (Number.isFinite(implied)) return implied;
    }
    for (const source of sources) {
      const explicit = actionUnitValue(source[key], null, options);
      if (Number.isFinite(explicit)) return explicit;
    }
    return null;
  }

  function actionTextStyleRanges(descriptor, options) {
    const textKey = descriptor && descriptor.textKey;
    const ranges = textKey && Array.isArray(textKey.textStyleRange) ? textKey.textStyleRange : [];
    return ranges.map((range) => {
      const style = range && range.textStyle ? range.textStyle : {};
      return {
        from: Number(range.from || 0),
        to: Number(range.to || 0),
        sizePoints: actionStyleUnit(style, "size", "impliedFontSize", {
          resolution: options && options.resolution,
          scale: options && options.scaleY
        }),
        leading: actionStyleUnit(style, "leading", "impliedLeading", {
          resolution: options && options.resolution,
          scale: options && options.scaleY
        }),
        baselineShift: actionStyleUnit(style, "baselineShift", "impliedBaselineShift", {
          resolution: options && options.resolution,
          scale: options && options.scaleY
        })
      };
    });
  }

  function actionParagraphStyleRanges(descriptor, options) {
    const textKey = descriptor && descriptor.textKey;
    const ranges = textKey && Array.isArray(textKey.paragraphStyleRange) ? textKey.paragraphStyleRange : [];
    return ranges.map((range) => {
      const style = range && range.paragraphStyle ? range.paragraphStyle : {};
      return {
        from: Number(range.from || 0),
        to: Number(range.to || 0),
        firstLineIndent: actionStyleUnit(style, "firstLineIndent", "impliedFirstLineIndent", {
          resolution: options && options.resolution,
          scale: options && options.scaleX
        }),
        leftIndent: actionStyleUnit(style, "startIndent", "impliedStartIndent", {
          resolution: options && options.resolution,
          scale: options && options.scaleX
        }),
        rightIndent: actionStyleUnit(style, "endIndent", "impliedEndIndent", {
          resolution: options && options.resolution,
          scale: options && options.scaleX
        }),
        spaceBefore: actionStyleUnit(style, "spaceBefore", "impliedSpaceBefore", {
          resolution: options && options.resolution,
          scale: options && options.scaleY
        }),
        spaceAfter: actionStyleUnit(style, "spaceAfter", "impliedSpaceAfter", {
          resolution: options && options.resolution,
          scale: options && options.scaleY
        })
      };
    });
  }

  function uniformRangeValue(ranges, key) {
    const values = ranges.map((range) => Number(range[key])).filter(Number.isFinite);
    if (!values.length || values.length !== ranges.length) return null;
    const first = values[0];
    return values.every((value) => Math.abs(value - first) <= 0.0001) ? first : null;
  }

  function actionTextTransform(descriptor) {
    const transform = descriptor && descriptor.textKey && descriptor.textKey.transform
      ? descriptor.textKey.transform
      : {};
    const xx = Number(transform.xx == null ? 1 : transform.xx);
    const xy = Number(transform.xy || 0);
    const yx = Number(transform.yx || 0);
    const yy = Number(transform.yy == null ? 1 : transform.yy);
    return {
      xx,
      xy,
      yx,
      yy,
      scaleX: Math.hypot(xx, yx) || 1,
      scaleY: Math.hypot(xy, yy) || 1
    };
  }

  function usableDescriptor(value) {
    if (!value || typeof value !== "object") return null;
    const kind = String(value._obj || "").toLowerCase();
    return kind === "error" || kind === "failure" ? null : value;
  }

  async function readDescriptorBatch(commands, options) {
    if (!commands.length) return [];
    if (commands.length > 48) {
      const output = [];
      for (let index = 0; index < commands.length; index += 48) {
        output.push(...await readDescriptorBatch(commands.slice(index, index + 48), options));
      }
      return output;
    }
    try {
      const values = await action.batchPlay(commands, options || {});
      return commands.map((_, index) => usableDescriptor(values && values[index]));
    } catch (_) {
      if (commands.length === 1) return [null];
      const middle = Math.floor(commands.length / 2);
      return [
        ...await readDescriptorBatch(commands.slice(0, middle), options),
        ...await readDescriptorBatch(commands.slice(middle), options)
      ];
    }
  }

  async function enrichLayerBounds(documentId, flatLayers) {
    if (!flatLayers.length) return;
    const commands = flatLayers.map((layer) => ({
      _obj: "get",
      _target: [
        { _ref: "layer", _id: layer.id },
        { _ref: "document", _id: Number(documentId) }
      ],
      _options: { dialogOptions: "dontDisplay" }
    }));
    const descriptors = await readDescriptorBatch(commands, { synchronousExecution: true });
    flatLayers.forEach((layer, index) => {
      const descriptor = descriptors[index] || {};
      const raw = descriptor.boundsNoEffects || descriptor.bounds;
      const bounds = boundsValue(raw);
      if (bounds) {
        layer.boundsNoEffects = bounds;
        layer.bounds = bounds;
      }
      const locking = descriptor.layerLocking || {};
      const lockMap = {
        all: locking.protectAll,
        pixels: locking.protectComposite,
        position: locking.protectPosition,
        transparentPixels: locking.protectTransparency
      };
      for (const [key, value] of Object.entries(lockMap)) {
        if (typeof value === "boolean") layer.locks[key] = value;
      }
      if (typeof descriptor.hasUserMask === "boolean") layer.hasLayerMask = descriptor.hasUserMask;
      if (typeof descriptor.hasVectorMask === "boolean") layer.hasVectorMask = descriptor.hasVectorMask;
      if (typeof descriptor.userMaskEnabled === "boolean") layer.layerMaskEnabled = descriptor.userMaskEnabled;
      if (typeof descriptor.vectorMaskEnabled === "boolean") layer.vectorMaskEnabled = descriptor.vectorMaskEnabled;
      const integrityDescriptor = {
        adjustment: descriptor.adjustment || null,
        layerEffects: descriptor.layerEffects || null,
        filterFX: descriptor.filterFX || null,
        smartObject: descriptor.smartObject || null,
        smartObjectMore: descriptor.smartObjectMore || null,
        userMaskEnabled: descriptor.userMaskEnabled,
        userMaskDensity: descriptor.userMaskDensity,
        userMaskFeather: descriptor.userMaskFeather,
        vectorMaskEnabled: descriptor.vectorMaskEnabled,
        vectorMaskDensity: descriptor.vectorMaskDensity,
        vectorMaskFeather: descriptor.vectorMaskFeather
      };
      layer.integrityDescriptorDigest = hashText(JSON.stringify(integrityDescriptor));
    });
  }

  async function readDocumentDescriptor(documentId) {
    try {
      const result = await action.batchPlay([{
        _obj: "get",
        _target: [{ _ref: "document", _id: documentId }],
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
      return result[0] || null;
    } catch (_) {
      return null;
    }
  }

  async function enrichTextStyles(documentId, flatLayers, resolution) {
    const textLayers = flatLayers.filter((layer) => Boolean(layer.text));
    if (!textLayers.length) return;
    const commands = textLayers.map((layer) => ({
      _obj: "get",
      _target: [
        { _ref: "layer", _id: layer.id },
        { _ref: "document", _id: documentId }
      ],
      _options: { dialogOptions: "dontDisplay" }
    }));
    const descriptors = await readDescriptorBatch(commands, {});
    textLayers.forEach((layer, index) => {
      const descriptor = descriptors[index];
      if (!descriptor) return;
      const transform = actionTextTransform(descriptor);
      const unitContext = {
        resolution: Math.max(1, Number(resolution || 72)),
        scaleX: transform.scaleX,
        scaleY: transform.scaleY
      };
      const ranges = actionTextStyleRanges(descriptor, unitContext);
      const paragraphRanges = actionParagraphStyleRanges(descriptor, unitContext);
      const sizedRanges = ranges.filter((range) => Number.isFinite(range.sizePoints) && range.sizePoints > 0);
      const effectiveSizes = [...new Set(sizedRanges.map((range) => Number(range.sizePoints.toFixed(4))))];
      // actionTextStyleRanges already normalizes to Photoshop's displayed
      // point value. Multiplying by the transform again turns 80 pt into
      // 88.3358 pt on a layer with scaleY=1.1041975.
      const uiSizes = effectiveSizes.slice();
      const nativeReadback = {};
      for (const key of ["leading", "baselineShift"]) {
        const value = uniformRangeValue(ranges, key);
        if (Number.isFinite(value)) nativeReadback[key] = value;
      }
      for (const key of ["firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"]) {
        const value = uniformRangeValue(paragraphRanges, key);
        if (Number.isFinite(value)) nativeReadback[key] = value;
      }
      layer.text.styleRanges = ranges;
      layer.text.paragraphStyleRanges = paragraphRanges;
      layer.text.transform = transform;
      layer.text.effectiveSizesPoints = effectiveSizes;
      layer.text.uiSizesPoints = uiSizes;
      layer.text.uiSizePoints = uiSizes.length === 1 ? uiSizes[0] : null;
      layer.text.nativeReadback = nativeReadback;
      for (const [key, value] of Object.entries(nativeReadback)) layer.text[key] = value;
    });
  }

  function describeLayer(layer, parentId, parentPath, depth, index, resolution) {
    const name = String(read(() => layer.name, "未命名图层"));
    const path = parentPath ? `${parentPath}/${name}` : name;
    const kind = enumName(read(() => layer.kind, "unknown"));
    const entry = {
      id: Number(layer.id),
      name,
      path,
      parentId,
      depth,
      index,
      kind,
      visible: Boolean(read(() => layer.visible, true)),
      opacity: numberValue(read(() => layer.opacity, 100)),
      fillOpacity: numberValue(read(() => layer.fillOpacity, 100)),
      blendMode: enumName(read(() => layer.blendMode, "normal")),
      locks: {
        all: readSafetyBoolean(() => layer.allLocked),
        pixels: readSafetyBoolean(() => layer.pixelsLocked),
        position: readSafetyBoolean(() => layer.positionLocked),
        transparentPixels: readSafetyBoolean(() => layer.transparentPixelsLocked)
      },
      bounds: boundsValue(read(() => layer.bounds, null)),
      boundsNoEffects: boundsValue(read(() => layer.boundsNoEffects, null)),
      clippingMask: Boolean(read(() => layer.isClippingMask, false)),
      // `layerMaskEnabled` describes whether an existing mask is enabled; it
      // does not prove that a mask exists. Existence stays unknown until the
      // layer descriptor supplies `hasUserMask`.
      hasLayerMask: null,
      layerMaskEnabled: readSafetyBoolean(() => layer.layerMaskEnabled),
      layerMaskDensity: numberValue(read(() => layer.layerMaskDensity, 100)),
      layerMaskFeather: numberValue(read(() => layer.layerMaskFeather, 0)),
      hasVectorMask: null,
      vectorMaskEnabled: readSafetyBoolean(() => layer.vectorMaskEnabled),
      vectorMaskDensity: numberValue(read(() => layer.vectorMaskDensity, 100)),
      vectorMaskFeather: numberValue(read(() => layer.vectorMaskFeather, 0)),
      text: null,
      children: []
    };
    if (kind.toLowerCase().includes("text") || read(() => layer.textItem && layer.textItem.contents != null, false)) {
      entry.text = describeText(layer, resolution);
    }
    return { entry, path };
  }

  function collectLayerTree(layers, parentId, parentPath, depth, flat, resolution) {
    const tree = [];
    let index = 0;
    for (const layer of Array.from(layers || [])) {
      const described = describeLayer(layer, parentId, parentPath, depth, index++, resolution);
      const entry = described.entry;
      flat.push(entry);
      const children = read(() => layer.layers, null);
      if (children && children.length) {
        entry.children = collectLayerTree(children, entry.id, described.path, depth + 1, flat, resolution);
      }
      tree.push(entry);
    }
    return tree;
  }

  async function readSelectionBounds(doc) {
    try {
      const result = await action.batchPlay([{
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _id: Number(doc.id) }
        ],
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
      const selection = result[0] && result[0].selection;
      if (selection) return boundsValue(selection);
    } catch (_) {}
    try {
      const bounds = await doc.selection.bounds;
      return boundsValue(bounds);
    } catch (_) {
      return null;
    }
  }

  async function readCompositeDigest(documentId) {
    let image = null;
    try {
      image = await imaging.getPixels({
        documentID: Number(documentId),
        targetSize: { width: 96, height: 96 },
        colorSpace: "RGB",
        componentSize: 8,
        applyAlpha: true
      });
      if (!image || !image.imageData) return null;
      const data = await image.imageData.getData({ chunky: true });
      return `${image.imageData.width}x${image.imageData.height}:${hashBytes(data)}`;
    } catch (_) {
      return null;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function readSelectionDigest(documentId, selectionBounds) {
    if (!selectionBounds) return "none";
    let image = null;
    try {
      image = await imaging.getSelection({
        documentID: Number(documentId),
        sourceBounds: selectionBounds,
        targetSize: { width: 96, height: 96 }
      });
      if (!image || !image.imageData) return null;
      const data = await image.imageData.getData({ chunky: true });
      return `${image.imageData.width}x${image.imageData.height}:${hashBytes(data)}`;
    } catch (_) {
      return null;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function fingerprintLayerState(snapshot) {
    return snapshot.flatLayers.map((layer) => ({
      id: layer.id,
      parentId: layer.parentId,
      index: layer.index,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      opacity: layer.opacity,
      fillOpacity: layer.fillOpacity,
      blendMode: layer.blendMode,
      locks: layer.locks,
      bounds: layer.boundsNoEffects || layer.bounds,
      clippingMask: layer.clippingMask,
      hasLayerMask: layer.hasLayerMask,
      layerMaskEnabled: layer.layerMaskEnabled,
      layerMaskDensity: layer.layerMaskDensity,
      layerMaskFeather: layer.layerMaskFeather,
      hasVectorMask: layer.hasVectorMask,
      vectorMaskEnabled: layer.vectorMaskEnabled,
      vectorMaskDensity: layer.vectorMaskDensity,
      vectorMaskFeather: layer.vectorMaskFeather,
      integrityDescriptorDigest: layer.integrityDescriptorDigest || null,
      text: layer.text ? {
        contents: layer.text.contents,
        orientation: layer.text.orientation,
        font: layer.text.font,
        color: layer.text.color,
        uiSizesPoints: layer.text.uiSizesPoints,
        leading: layer.text.leading,
        tracking: layer.text.tracking,
        fauxBold: layer.text.fauxBold,
        fauxItalic: layer.text.fauxItalic,
        horizontalScale: layer.text.horizontalScale,
        verticalScale: layer.text.verticalScale,
        baselineShift: layer.text.baselineShift,
        justification: layer.text.justification,
        hyphenation: layer.text.hyphenation,
        firstLineIndent: layer.text.firstLineIndent,
        leftIndent: layer.text.leftIndent,
        rightIndent: layer.text.rightIndent,
        spaceBefore: layer.text.spaceBefore,
        spaceAfter: layer.text.spaceAfter
      } : null
    }));
  }

  function buildContentFingerprint(snapshot) {
    return hashText(JSON.stringify([
      snapshot.document.id,
      snapshot.document.width,
      snapshot.document.height,
      snapshot.document.resolution,
      snapshot.document.compositeDigest,
      fingerprintLayerState(snapshot)
    ]));
  }

  function buildFingerprint(snapshot) {
    const layerState = fingerprintLayerState(snapshot);
    return hashText(JSON.stringify([
      snapshot.document.id,
      snapshot.document.width,
      snapshot.document.height,
      snapshot.document.resolution,
      snapshot.document.historyStateId,
      snapshot.document.compositeDigest,
      snapshot.activeLayers.map((layer) => layer.id),
      snapshot.selectionBounds,
      snapshot.selectionDigest,
      layerState
    ]));
  }

  function normalizedEvidenceRequirements(requirements) {
    // Omission keeps the v9.7 full-integrity contract for callers that have not
    // declared their dependencies. A compiled plan may explicitly relax only
    // evidence it cannot read or affect.
    if (!requirements || typeof requirements !== "object") {
      return {
        needsCompositeDigest: true,
        needsSelectionDigest: true,
        needsActiveLayers: true,
        needsLayerTree: true
      };
    }
    return {
      needsCompositeDigest: requirements.needsCompositeDigest === true,
      needsSelectionDigest: requirements.needsSelectionDigest === true,
      needsActiveLayers: requirements.needsActiveLayers === true,
      needsLayerTree: requirements.needsLayerTree === true
    };
  }

  function isCompleteIntegritySnapshot(state, requirements) {
    if (!state || !state.hasDocument || !state.fingerprint || !state.contentFingerprint) return false;
    if (!state.document || !Number.isFinite(Number(state.document.historyStateId))
      || Number(state.document.historyStateId) <= 0) return false;
    const needed = normalizedEvidenceRequirements(requirements);
    if (needed.needsActiveLayers && !Array.isArray(state.activeLayers)) return false;
    if (needed.needsLayerTree && !Array.isArray(state.flatLayers)) return false;
    const integrity = state.integrity || {};
    if (integrity.consistentRead === false) return false;
    if (needed.needsCompositeDigest
      && (integrity.compositeDigestAvailable !== true || !state.document.compositeDigest)) return false;
    if (needed.needsSelectionDigest) {
      if (integrity.selectionDigestAvailable !== true) return false;
      if (state.selectionBounds && (state.selectionDigest == null || state.selectionDigest === "none")) return false;
      if (!state.selectionBounds && state.selectionDigest !== "none") return false;
    }
    return true;
  }

  function buildEvidenceFingerprint(state, requirements) {
    if (!state || !state.hasDocument || !state.document) return null;
    const needed = normalizedEvidenceRequirements(requirements);
    const payload = {
      documentId: Number(state.document.id),
      width: Number(state.document.width),
      height: Number(state.document.height),
      resolution: Number(state.document.resolution),
      historyStateId: Number(state.document.historyStateId)
    };
    if (needed.needsCompositeDigest) payload.compositeDigest = state.document.compositeDigest || null;
    if (needed.needsSelectionDigest) {
      payload.selectionBounds = state.selectionBounds || null;
      payload.selectionDigest = state.selectionDigest == null ? null : state.selectionDigest;
    }
    if (needed.needsActiveLayers) {
      payload.activeLayerIds = Array.isArray(state.activeLayers)
        ? state.activeLayers.map((layer) => Number(layer.id))
        : null;
    }
    if (needed.needsLayerTree) payload.layerState = fingerprintLayerState(state);
    return hashText(JSON.stringify(payload));
  }

  function lightweightLayerState(flatLayers) {
    return (flatLayers || []).map((layer) => ({
      id: Number(layer.id),
      parentId: layer.parentId == null ? null : Number(layer.parentId),
      index: Number(layer.index),
      name: String(layer.name || ""),
      kind: String(layer.kind || ""),
      visible: Boolean(layer.visible),
      opacity: Number(layer.opacity),
      fillOpacity: Number(layer.fillOpacity),
      blendMode: String(layer.blendMode || ""),
      clippingMask: Boolean(layer.clippingMask),
      locks: layer.locks || null,
      textContents: layer.text ? String(layer.text.contents || "") : null
    }));
  }

  function buildLightweightGateFingerprint(value, requirements) {
    const document = value && value.document || {};
    const needed = normalizedEvidenceRequirements(requirements);
    const payload = {
      documentId: Number(document.id),
      width: Number(document.width),
      height: Number(document.height),
      resolution: Number(document.resolution),
      historyStateId: Number(document.historyStateId),
      historyStateName: String(document.historyStateName || "")
    };
    if (needed.needsActiveLayers) {
      payload.activeLayerIds = (value && value.activeLayers || []).map((layer) => Number(layer.id));
    }
    if (needed.needsSelectionDigest) payload.selectionBounds = value && value.selectionBounds || null;
    if (needed.needsLayerTree) payload.layerState = lightweightLayerState(value && value.flatLayers || []);
    return hashText(JSON.stringify(payload));
  }

  async function captureLightweightGateSnapshot() {
    if (!app.documents.length) return { hasDocument: false, complete: false };
    const doc = app.activeDocument;
    const documentId = Number(doc.id);
    const historyStateId = Number(read(() => doc.activeHistoryState.id, 0));
    const historyStateName = String(read(() => doc.activeHistoryState.name, ""));
    const flatLayers = [];
    collectLayerTree(doc.layers, null, "", 0, flatLayers, numberValue(doc.resolution));
    const activeLayers = Array.from(doc.activeLayers || []).map((layer) => ({ id: Number(layer.id) }));
    const selectionBounds = await readSelectionBounds(doc);
    const endDocumentId = Number(read(() => app.activeDocument.id, 0));
    const endHistoryStateId = Number(read(() => app.activeDocument.activeHistoryState.id, 0));
    const gate = {
      hasDocument: true,
      complete: documentId === endDocumentId
        && historyStateId > 0
        && historyStateId === endHistoryStateId
        && Array.isArray(activeLayers),
      document: {
        id: documentId,
        width: numberValue(doc.width),
        height: numberValue(doc.height),
        resolution: numberValue(doc.resolution),
        historyStateId,
        historyStateName
      },
      activeLayers,
      selectionBounds,
      flatLayers
    };
    gate.fingerprint = buildLightweightGateFingerprint(gate);
    return gate;
  }

  function lightweightGateMatches(fullState, gate, requirements) {
    if (!fullState || !gate || gate.complete !== true || !gate.hasDocument) return false;
    const needed = normalizedEvidenceRequirements(requirements);
    if (!fullState.document || Number(fullState.document.id) !== Number(gate.document.id)) return false;
    if (!Number.isFinite(Number(fullState.document.historyStateId)) || Number(fullState.document.historyStateId) <= 0
      || Number(fullState.document.historyStateId) !== Number(gate.document.historyStateId)) return false;
    if (String(fullState.document.historyStateName || "") !== String(gate.document.historyStateName || "")) return false;
    if (needed.needsActiveLayers) {
      const expectedActive = (fullState.activeLayers || []).map((layer) => Number(layer.id));
      const actualActive = (gate.activeLayers || []).map((layer) => Number(layer.id));
      if (expectedActive.length !== actualActive.length
        || expectedActive.some((id, index) => id !== actualActive[index])) return false;
    }
    if (needed.needsSelectionDigest) {
      const expectedBounds = fullState.selectionBounds;
      const actualBounds = gate.selectionBounds;
      if (Boolean(expectedBounds) !== Boolean(actualBounds)) return false;
      if (expectedBounds && !["left", "top", "right", "bottom"]
        .every((key) => Number(expectedBounds[key]) === Number(actualBounds[key]))) return false;
    }
    return buildLightweightGateFingerprint(fullState, requirements)
      === buildLightweightGateFingerprint(gate, requirements);
  }

  async function snapshot() {
    if (!app.documents.length) return { hasDocument: false, createdAt: new Date().toISOString() };
    const doc = app.activeDocument;
    const documentId = Number(doc.id);
    const readStartHistoryStateId = Number(read(() => doc.activeHistoryState.id, 0));
    const flatLayers = [];
    const layerTree = collectLayerTree(doc.layers, null, "", 0, flatLayers, numberValue(doc.resolution));
    await enrichLayerBounds(documentId, flatLayers);
    await enrichTextStyles(documentId, flatLayers, numberValue(doc.resolution));
    const documentDescriptor = await readDocumentDescriptor(documentId);
    // BatchPlay exposes document width/height as points in some Photoshop
    // states (for example 620 px at 300 ppi is reported as 148.8 pt). The DOM
    // document dimensions are pixel values, which is the unit used by the
    // planner, capabilities, and verification layer.
    const documentWidth = numberValue(doc.width) || numberValue(documentDescriptor && documentDescriptor.width);
    const documentHeight = numberValue(doc.height) || numberValue(documentDescriptor && documentDescriptor.height);
    const activeLayers = Array.from(doc.activeLayers || []).map((layer) => ({
      id: Number(layer.id),
      name: String(layer.name),
      kind: enumName(read(() => layer.kind, "unknown"))
    }));
    const selectionBounds = await readSelectionBounds(doc);
    const compositeDigest = await readCompositeDigest(documentId);
    const selectionDigest = await readSelectionDigest(documentId, selectionBounds);
    const historyStateId = Number(read(() => doc.activeHistoryState.id, 0));
    const historyStateName = String(read(() => doc.activeHistoryState.name, ""));
    const readEndDocumentId = Number(read(() => app.activeDocument.id, 0));
    const readEndHistoryStateId = Number(read(() => app.activeDocument.activeHistoryState.id, 0));
    const consistentRead = documentId === readEndDocumentId
      && readStartHistoryStateId > 0
      && readStartHistoryStateId === historyStateId
      && historyStateId === readEndHistoryStateId;
    const safetyUnknownLayers = flatLayers.filter((layer) =>
      Object.values(layer.locks || {}).some((value) => value == null)
      || layer.hasLayerMask == null
      || layer.hasVectorMask == null
    );
    const state = {
      hasDocument: true,
      createdAt: new Date().toISOString(),
      document: {
        id: Number(doc.id),
        name: String(read(() => doc.name, read(() => doc.title, "未命名文档"))),
        title: String(read(() => doc.title, read(() => doc.name, "未命名文档"))),
        width: documentWidth,
        height: documentHeight,
        aspectRatio: documentHeight ? documentWidth / documentHeight : 0,
        resolution: numberValue(documentDescriptor && documentDescriptor.resolution) || numberValue(doc.resolution),
        mode: enumName(read(() => doc.mode, "")),
        bitsPerChannel: enumName(read(() => doc.bitsPerChannel, "")),
        historyStateId,
        historyStateName,
        compositeDigest
      },
      activeLayers,
      selectionBounds,
      selectionDigest,
      layerTree,
      flatLayers,
      integrity: {
        compositeDigestAvailable: Boolean(compositeDigest),
        selectionDigestAvailable: selectionDigest != null,
        consistentRead,
        safetyStateComplete: safetyUnknownLayers.length === 0,
        safetyUnknownLayerIds: safetyUnknownLayers.map((layer) => layer.id)
      },
      metrics: {
        layers: flatLayers.length,
        groups: flatLayers.filter((layer) => layer.children.length > 0 || layer.kind.toLowerCase().includes("group")).length,
        textLayers: flatLayers.filter((layer) => Boolean(layer.text)).length,
        hiddenLayers: flatLayers.filter((layer) => !layer.visible).length,
        lockedLayers: flatLayers.filter((layer) => Object.values(layer.locks).some(Boolean)).length,
        maskedLayers: flatLayers.filter((layer) => layer.hasLayerMask || layer.hasVectorMask || layer.clippingMask).length,
        safetyUnknownLayers: safetyUnknownLayers.length
      }
    };
    state.contentFingerprint = buildContentFingerprint(state);
    state.fingerprint = buildFingerprint(state);
    return state;
  }

  async function digestLayerPixels(documentId, layer) {
    const bounds = layer && (layer.boundsNoEffects || layer.bounds);
    if (!bounds || Number(bounds.right) <= Number(bounds.left) || Number(bounds.bottom) <= Number(bounds.top)) return "empty";
    let image = null;
    try {
      image = await imaging.getPixels({
        documentID: Number(documentId),
        layerID: Number(layer.id),
        sourceBounds: bounds,
        targetSize: { width: 48, height: 48 },
        colorSpace: "RGB",
        componentSize: 8,
        applyAlpha: true
      });
      if (!image || !image.imageData) return null;
      const data = await image.imageData.getData({ chunky: true });
      return `${image.imageData.width}x${image.imageData.height}:${hashBytes(data)}`;
    } catch (_) {
      return null;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function digestLayerMask(documentId, layer) {
    if (layer.hasLayerMask === false) return "none";
    if (layer.hasLayerMask == null) return null;
    let image = null;
    try {
      image = await imaging.getLayerMask({
        documentID: Number(documentId),
        layerID: Number(layer.id),
        kind: "user",
        targetSize: { width: 48, height: 48 }
      });
      if (!image || !image.imageData) return null;
      const data = await image.imageData.getData({ chunky: true });
      return `${image.imageData.width}x${image.imageData.height}:${hashBytes(data)}`;
    } catch (_) {
      return null;
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function captureLayerEvidence(state, layerIds, options) {
    const ids = new Set(Array.from(layerIds || []).map(Number));
    const maxLayers = Math.max(1, Number(options && options.maxLayers || 64));
    const candidates = (state.flatLayers || []).filter((layer) => {
      if (ids.size && !ids.has(Number(layer.id))) return false;
      return !((layer.children && layer.children.length) || String(layer.kind || "").toLowerCase().includes("group"));
    });
    const selected = candidates.slice(0, maxLayers);
    const evidence = {};
    for (const layer of selected) {
      const pixelDigest = await digestLayerPixels(state.document.id, layer);
      const userMaskDigest = layer.hasLayerMask === false
        ? "absent"
        : layer.hasLayerMask === true
          ? await digestLayerMask(state.document.id, layer)
          : null;
      const vectorMaskCoverage = layer.hasVectorMask === false ? "absent" : "not_sampled";
      evidence[layer.id] = {
        pixelDigest,
        userMaskDigest,
        maskDigest: userMaskDigest,
        vectorMaskDigest: null,
        vectorMaskCoverage
      };
    }
    return {
      evidence,
      requested: candidates.length,
      captured: selected.length,
      complete: candidates.length <= maxLayers
        && selected.every((layer) => evidence[layer.id].pixelDigest != null
          && evidence[layer.id].userMaskDigest != null
          && evidence[layer.id].vectorMaskCoverage === "absent")
    };
  }

  function compactForModel(state) {
    if (!state || !state.hasDocument) return { hasDocument: false };
    return {
      document: state.document,
      activeLayers: state.activeLayers,
      selectionBounds: state.selectionBounds,
      metrics: state.metrics,
      integrity: state.integrity,
      palette: Array.isArray(state.palette) ? state.palette : [],
      layers: state.flatLayers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        path: layer.path,
        parentId: layer.parentId,
        kind: layer.kind,
        childCount: layer.children.length,
        visible: layer.visible,
        locked: Object.values(layer.locks).some((value) => value === true)
          ? true
          : (Object.values(layer.locks).some((value) => value == null) ? null : false),
        bounds: layer.boundsNoEffects || layer.bounds,
        hasLayerMask: layer.hasLayerMask,
        hasVectorMask: layer.hasVectorMask,
        clippingMask: layer.clippingMask,
        text: layer.text ? {
          contents: layer.text.contents,
          orientation: layer.text.orientation,
          font: layer.text.font,
          size: layer.text.uiSizePoints || layer.text.size,
          color: layer.text.color,
          leading: layer.text.leading,
          tracking: layer.text.tracking,
          justification: layer.text.justification,
          hyphenation: layer.text.hyphenation,
          firstLineIndent: layer.text.firstLineIndent,
          leftIndent: layer.text.leftIndent,
          rightIndent: layer.text.rightIndent,
          spaceBefore: layer.text.spaceBefore,
          spaceAfter: layer.text.spaceAfter
        } : null
      }))
    };
  }

  return {
    numberValue,
    snapshot,
    compactForModel,
    buildContentFingerprint,
    buildFingerprint,
    isCompleteIntegritySnapshot,
    buildEvidenceFingerprint,
    buildLightweightGateFingerprint,
    captureLightweightGateSnapshot,
    lightweightGateMatches,
    describeText,
    actionUnitValue,
    actionStyleUnit,
    actionTextStyleRanges,
    actionParagraphStyleRanges,
    uniformRangeValue,
    actionTextTransform,
    readDescriptorBatch,
    captureLayerEvidence
  };
});
