(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV97SelectionSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const { app, constants, imaging } = require("photoshop");
  const sessions = new Map();
  let sequence = 0;
  const SESSION_LIMIT = 32;
  const MAX_CAPTURE_PIXELS = 64 * 1024 * 1024;
  const TOTAL_MASK_BYTES_LIMIT = 128 * 1024 * 1024;

  function numberValue(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.value === "number") return value.value;
    if (value && typeof value._value === "number") return value._value;
    return Number(value) || 0;
  }

  function safeDispose(value) {
    if (value && typeof value.dispose === "function") value.dispose();
  }

  function activeBounds() {
    try {
      const bounds = app.activeDocument.selection.bounds;
      if (!bounds) return null;
      const result = {
        left: Math.floor(numberValue(bounds.left)),
        top: Math.floor(numberValue(bounds.top)),
        right: Math.ceil(numberValue(bounds.right)),
        bottom: Math.ceil(numberValue(bounds.bottom))
      };
      return result.right > result.left && result.bottom > result.top ? result : null;
    } catch (_) {
      return null;
    }
  }

  function boundsEqual(actual, expected) {
    if (!actual || !expected) return actual === expected;
    return ["left", "top", "right", "bottom"].every((key) => (
      Math.round(numberValue(actual[key])) === Math.round(numberValue(expected[key]))
    ));
  }

  function digestBytes(bytes, width, height) {
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= Number(bytes[index]) & 255;
      hash = Math.imul(hash, 16777619);
    }
    return `${width}x${height}:${(hash >>> 0).toString(16)}`;
  }

  function selectedPixelCount(bytes) {
    let selected = 0;
    for (const value of bytes) if (Number(value) > 8) selected += 1;
    return selected;
  }

  async function captureCurrent(options = {}) {
    if (!app.documents.length) throw new Error("请先打开 Photoshop 文档。");
    const bounds = activeBounds();
    if (!bounds) throw new Error("当前没有可采用的 Photoshop 活动选区。");
    const documentID = Number(app.activeDocument.id);
    const image = await imaging.getSelection({ documentID, sourceBounds: bounds });
    if (!image || !image.imageData) throw new Error("Photoshop 没有返回可保存的活动选区数据。");
    try {
      const raw = new Uint8Array(await image.imageData.getData({ chunky: true }));
      const width = Number(image.imageData.width);
      const height = Number(image.imageData.height);
      const pixelCount = width * height;
      if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || pixelCount > MAX_CAPTURE_PIXELS) {
        throw new Error("当前选区数据过大，无法安全锁定；请缩小选区范围后重试。");
      }
      const components = Math.max(1, Math.round(raw.length / pixelCount));
      const mask = components === 1 ? new Uint8Array(raw) : new Uint8Array(pixelCount);
      if (components !== 1) {
        for (let index = 0; index < pixelCount; index += 1) mask[index] = raw[index * components];
      }
      const selectedPixels = selectedPixelCount(mask);
      if (selectedPixels < 1) throw new Error("当前 Photoshop 活动选区为空。");
      const sourceBounds = image.sourceBounds || bounds;
      const token = String(options.token || `selection_${Date.now()}_${sequence += 1}`);
      const previous = sessions.get(token);
      const metadata = { ...((previous && previous.metadata) || {}), ...(options.metadata || {}) };
      const session = {
        token,
        documentID,
        documentWidth: Math.round(numberValue(app.activeDocument.width)),
        documentHeight: Math.round(numberValue(app.activeDocument.height)),
        width,
        height,
        origin: {
          left: Math.round(numberValue(sourceBounds.left == null ? bounds.left : sourceBounds.left)),
          top: Math.round(numberValue(sourceBounds.top == null ? bounds.top : sourceBounds.top))
        },
        selectionBounds: { ...bounds },
        mask,
        selectedPixels,
        digest: digestBytes(mask, width, height),
        corrected: options.corrected === true || Boolean(previous && previous.corrected),
        correctionSource: String(options.correctionSource || (previous && previous.correctionSource) || ""),
        lowConfidenceAccepted: options.lowConfidenceAccepted === true || Boolean(previous && previous.lowConfidenceAccepted),
        metadata,
        updatedAt: Date.now()
      };
      if (sessions.has(token)) sessions.delete(token);
      sessions.set(token, session);
      const totalBytes = () => Array.from(sessions.values()).reduce((sum, value) => sum + value.mask.byteLength, 0);
      while (sessions.size > SESSION_LIMIT || totalBytes() > TOTAL_MASK_BYTES_LIMIT) {
        const oldest = Array.from(sessions.entries()).find(([key, value]) => key !== token && value.metadata.pinned !== true)?.[0]
          || Array.from(sessions.entries()).find(([key]) => key !== token)?.[0]
          || sessions.keys().next().value;
        if (oldest === token && sessions.size === 1) break;
        sessions.delete(oldest);
      }
      if (!sessions.has(token)) throw new Error("权威选区会话超出 128MB 总内存预算，最旧候选已被淘汰；请重新采用当前选区。");
      return describe(token);
    } finally {
      safeDispose(image && image.imageData);
    }
  }

  async function restore(token) {
    const session = sessions.get(String(token || ""));
    if (!session) throw new Error("锁定的权威选区已失效，请重新采用当前 Photoshop 选区。");
    if (!app.documents.length || Number(app.activeDocument.id) !== session.documentID) {
      throw new Error("当前文档与锁定选区不一致，请重新分析。");
    }
    if (Math.round(numberValue(app.activeDocument.width)) !== session.documentWidth
      || Math.round(numberValue(app.activeDocument.height)) !== session.documentHeight) {
      throw new Error("画布尺寸已变化，锁定选区不能继续使用，请重新分析。");
    }
    let imageData = null;
    try {
      imageData = await imaging.createImageDataFromBuffer(new Uint8Array(session.mask), {
        width: session.width,
        height: session.height,
        components: 1,
        chunky: false,
        colorSpace: "Grayscale",
        colorProfile: "Gray Gamma 2.2"
      });
      await imaging.putSelection({
        documentID: session.documentID,
        imageData,
        replace: true,
        targetBounds: { ...session.origin },
        commandName: "Natural Edit Agent v0.9.8：恢复已锁定选区"
      });
    } finally {
      safeDispose(imageData);
    }

    // putSelection resolving only means Photoshop accepted the command. Read the
    // live selection back before treating the locked mask as authoritative: a
    // stale document, host-side clipping, or a misplaced targetBounds must not
    // silently turn into edits on a different region.
    const liveBounds = activeBounds();
    if (!boundsEqual(liveBounds, session.selectionBounds)) {
      throw new Error("Photoshop 恢复的选区位置与锁定选区不一致，已停止执行；请重新分析。 ");
    }
    const live = await imaging.getSelection({
      documentID: session.documentID,
      sourceBounds: { ...session.selectionBounds }
    });
    if (!live || !live.imageData) {
      throw new Error("Photoshop 未返回恢复后的选区数据，无法验证选区是否正确，已停止执行。 ");
    }
    try {
      const raw = new Uint8Array(await live.imageData.getData({ chunky: true }));
      const width = Number(live.imageData.width);
      const height = Number(live.imageData.height);
      const pixelCount = width * height;
      if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || pixelCount > MAX_CAPTURE_PIXELS) {
        throw new Error("恢复后的选区数据大小异常，已停止执行。 ");
      }
      const components = Math.max(1, Math.round(raw.length / pixelCount));
      const mask = components === 1 ? new Uint8Array(raw) : new Uint8Array(pixelCount);
      if (components !== 1) {
        for (let index = 0; index < pixelCount; index += 1) mask[index] = raw[index * components];
      }
      const sourceBounds = live.sourceBounds || session.selectionBounds;
      const liveOrigin = {
        left: Math.round(numberValue(sourceBounds.left == null ? liveBounds.left : sourceBounds.left)),
        top: Math.round(numberValue(sourceBounds.top == null ? liveBounds.top : sourceBounds.top))
      };
      const maskMatches = width === session.width
        && height === session.height
        && liveOrigin.left === session.origin.left
        && liveOrigin.top === session.origin.top
        && selectedPixelCount(mask) === session.selectedPixels
        && digestBytes(mask, width, height) === session.digest;
      if (!maskMatches) {
        throw new Error("Photoshop 恢复后的选区内容与锁定选区不一致，已停止执行；请重新分析。 ");
      }
    } finally {
      safeDispose(live && live.imageData);
    }
    return describe(session.token);
  }

  function selectionType(mode) {
    const normalized = String(mode || "replace").toLowerCase();
    const table = {
      replace: constants.SelectionType.REPLACE,
      add: constants.SelectionType.EXTEND || constants.SelectionType.ADD,
      subtract: constants.SelectionType.DIMINISH || constants.SelectionType.SUBTRACT,
      intersect: constants.SelectionType.INTERSECT
    };
    if (!table[normalized]) throw new Error(`不支持的套索合并模式：${normalized}`);
    return table[normalized];
  }

  async function applyPolygon(token, points, mode) {
    if (!Array.isArray(points) || points.length < 3) throw new Error("自由套索至少需要 3 个有效点。");
    if (!app.documents.length) throw new Error("请先打开 Photoshop 文档。");
    const normalizedMode = String(mode || "replace").toLowerCase();
    if (token) {
      if (!sessions.has(String(token))) {
        throw new Error("要纠正的锁定选区已失效，已停止套索操作；请重新分析。");
      }
      await restore(token);
    } else if (normalizedMode !== "replace" && !activeBounds()) {
      throw new Error("没有可用于套索加减的活动选区；请先生成候选选区或改用替换模式。");
    }
    const safePoints = points.slice(0, 800).map((point) => ({
      x: Math.max(0, Math.min(numberValue(app.activeDocument.width), Number(point.x))),
      y: Math.max(0, Math.min(numberValue(app.activeDocument.height), Number(point.y)))
    }));
    await app.activeDocument.selection.selectPolygon(safePoints, selectionType(normalizedMode), 0, true);
    return captureCurrent({
      token: token || undefined,
      corrected: true,
      correctionSource: `panel-lasso:${normalizedMode}`
    });
  }

  function setLowConfidenceAccepted(token, accepted) {
    const session = sessions.get(String(token || ""));
    if (!session) return null;
    session.lowConfidenceAccepted = accepted === true;
    session.updatedAt = Date.now();
    return describe(session.token);
  }

  function describe(token) {
    const session = sessions.get(String(token || ""));
    if (!session) return null;
    return {
      token: session.token,
      documentID: session.documentID,
      selectionBounds: { ...session.selectionBounds },
      width: session.width,
      height: session.height,
      origin: { ...session.origin },
      selectedPixels: session.selectedPixels,
      digest: session.digest,
      corrected: session.corrected,
      correctionSource: session.correctionSource,
      lowConfidenceAccepted: session.lowConfidenceAccepted,
      metadata: { ...session.metadata },
      updatedAt: session.updatedAt
    };
  }

  function release(token) {
    if (token) sessions.delete(String(token));
  }

  function clear() {
    sessions.clear();
  }

  return {
    captureCurrent,
    restore,
    applyPolygon,
    setLowConfidenceAccepted,
    describe,
    release,
    clear,
    activeBounds
  };
});
