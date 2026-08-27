(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantMaskRle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function validateDimensions(pixelWidth, pixelHeight) {
    const width = Number(pixelWidth);
    const height = Number(pixelHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error("语义分割蒙版尺寸无效。");
    }
    const expectedLength = width * height;
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1) {
      throw new Error("语义分割蒙版尺寸过大或无效。");
    }
    return { width, height, expectedLength };
  }

  function walkSegmentationRle(counts, expectedLength, onSelectedRun) {
    if (!Array.isArray(counts) || !Number.isSafeInteger(expectedLength) || expectedLength < 1) {
      throw new Error("语义分割服务没有返回有效蒙版。");
    }
    let offset = 0;
    let selected = 0;
    let bit = 0;
    for (const raw of counts) {
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count < 0 || offset + count > expectedLength) {
        throw new Error("语义分割蒙版编码损坏。");
      }
      if (bit && count) {
        selected += count;
        if (onSelectedRun) onSelectedRun(offset, offset + count);
      }
      offset += count;
      bit = bit ? 0 : 1;
    }
    if (offset !== expectedLength || selected < 9) {
      throw new Error("语义分割蒙版为空或尺寸不完整。");
    }
    return selected;
  }

  function numberField(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // v9.8 accepts both the legacy full-canvas RLE array and the cropped form
  // returned by the local bridge. Cropped coordinates are always explicit;
  // callers never have to guess whether a number is normalized or percent.
  function normalizeRlePayload(payload, pixelWidth, pixelHeight) {
    const canvas = validateDimensions(pixelWidth, pixelHeight);
    if (Array.isArray(payload)) {
      return {
        counts: payload,
        origin: { left: 0, top: 0 },
        width: canvas.width,
        height: canvas.height,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        expectedLength: canvas.expectedLength,
        cropped: false
      };
    }
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.counts)) {
      throw new Error("语义分割服务没有返回有效的 RLE 蒙版。");
    }
    if (payload.encoding && payload.encoding !== "rle-cropped-v1") throw new Error("不支持的裁剪 RLE 编码。");
    if (payload.order && payload.order !== "row-major") throw new Error("裁剪 RLE 必须使用 row-major 顺序。");
    if (payload.startsWith != null && Number(payload.startsWith) !== 0) throw new Error("裁剪 RLE 必须从未选中游程开始。");
    const originValue = payload.origin && typeof payload.origin === "object" ? payload.origin : {};
    const sizeValue = payload.size && typeof payload.size === "object" ? payload.size : {};
    const canvasValue = payload.canvas && typeof payload.canvas === "object" ? payload.canvas : {};
    const left = Math.round(numberField(originValue.left, numberField(originValue.x, numberField(payload.originX, 0))));
    const top = Math.round(numberField(originValue.top, numberField(originValue.y, numberField(payload.originY, 0))));
    const width = Math.round(numberField(sizeValue.width, payload.width));
    const height = Math.round(numberField(sizeValue.height, payload.height));
    const canvasWidth = Math.round(numberField(canvasValue.width, numberField(payload.canvasWidth, canvas.width)));
    const canvasHeight = Math.round(numberField(canvasValue.height, numberField(payload.canvasHeight, canvas.height)));
    if (canvasWidth !== canvas.width || canvasHeight !== canvas.height) {
      throw new Error("裁剪 RLE 声明的画布尺寸与当前 Photoshop 文档不一致。");
    }
    if (!Number.isInteger(left) || !Number.isInteger(top) || !Number.isInteger(width) || !Number.isInteger(height)
      || left < 0 || top < 0 || width < 1 || height < 1
      || left + width > canvas.width || top + height > canvas.height) {
      throw new Error("裁剪 RLE 的原点或尺寸无效。");
    }
    const expectedLength = width * height;
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1) throw new Error("裁剪 RLE 尺寸过大或无效。");
    return {
      counts: payload.counts,
      origin: { left, top },
      width,
      height,
      canvasWidth,
      canvasHeight,
      expectedLength,
      cropped: true
    };
  }

  function decodeSegmentationRleCrop(counts, pixelWidth, pixelHeight, selectionBounds, padding = 2) {
    const dimensions = validateDimensions(pixelWidth, pixelHeight);
    const payload = normalizeRlePayload(counts, dimensions.width, dimensions.height);
    if (!selectionBounds) throw new Error("语义分割选区范围不完整。");
    const bounds = {
      left: Math.floor(Number(selectionBounds.left)),
      top: Math.floor(Number(selectionBounds.top)),
      right: Math.ceil(Number(selectionBounds.right)),
      bottom: Math.ceil(Number(selectionBounds.bottom))
    };
    if (!Object.values(bounds).every(Number.isFinite)
      || bounds.left < 0 || bounds.top < 0
      || bounds.right > dimensions.width || bounds.bottom > dimensions.height
      || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
      throw new Error("语义分割选区范围无效。");
    }
    const safePadding = Math.max(0, Math.min(8, Math.round(Number(padding) || 0)));
    const crop = {
      left: Math.max(0, bounds.left - safePadding),
      top: Math.max(0, bounds.top - safePadding),
      right: Math.min(dimensions.width, bounds.right + safePadding),
      bottom: Math.min(dimensions.height, bounds.bottom + safePadding)
    };
    const cropWidth = crop.right - crop.left;
    const cropHeight = crop.bottom - crop.top;
    const cropLength = cropWidth * cropHeight;
    if (!Number.isSafeInteger(cropLength) || cropLength < 1 || cropLength > 64 * 1024 * 1024) {
      throw new Error("语义分割选区范围过大，已停止以保护 Photoshop。");
    }
    const mask = new Uint8Array(cropLength);
    let copied = 0;
    const selected = walkSegmentationRle(payload.counts, payload.expectedLength, (start, end) => {
      let cursor = start;
      while (cursor < end) {
        const localY = Math.floor(cursor / payload.width);
        const rowStart = localY * payload.width;
        const xStart = payload.origin.left + cursor - rowStart;
        const rowEnd = Math.min(end, rowStart + payload.width);
        const xEnd = payload.origin.left + rowEnd - rowStart;
        const y = payload.origin.top + localY;
        if (y >= crop.top && y < crop.bottom) {
          const intersectionLeft = Math.max(xStart, crop.left);
          const intersectionRight = Math.min(xEnd, crop.right);
          if (intersectionRight > intersectionLeft) {
            const destination = (y - crop.top) * cropWidth + intersectionLeft - crop.left;
            const count = intersectionRight - intersectionLeft;
            mask.fill(255, destination, destination + count);
            copied += count;
          }
        }
        cursor = rowEnd;
      }
    });
    if (copied !== selected) {
      throw new Error("语义分割选区范围没有包含完整蒙版。");
    }
    return {
      mask,
      selected,
      width: cropWidth,
      height: cropHeight,
      origin: { left: crop.left, top: crop.top },
      selectionBounds: bounds
    };
  }

  function summarizeSegmentationRle(counts, pixelWidth, pixelHeight, region) {
    const dimensions = validateDimensions(pixelWidth, pixelHeight);
    const payload = normalizeRlePayload(counts, dimensions.width, dimensions.height);
    if (!region || !region.bounds || !region.targetBounds || !region.seed) {
      throw new Error("语义分割目标范围不完整。");
    }
    let left = dimensions.width;
    let top = dimensions.height;
    let right = -1;
    let bottom = -1;
    let insideTarget = 0;
    let outsideSearch = 0;
    let seedDistance = Infinity;
    const seedX = Number(region.seed.x);
    const seedY = Number(region.seed.y);
    if (!Number.isFinite(seedX) || !Number.isFinite(seedY)) {
      throw new Error("语义分割目标落点无效。");
    }

    const selected = walkSegmentationRle(payload.counts, payload.expectedLength, (start, end) => {
      let cursor = start;
      while (cursor < end) {
        const localY = Math.floor(cursor / payload.width);
        const rowStart = localY * payload.width;
        const xStart = payload.origin.left + cursor - rowStart;
        const rowEnd = Math.min(end, rowStart + payload.width);
        const xEnd = payload.origin.left + rowEnd - rowStart;
        const y = payload.origin.top + localY;
        left = Math.min(left, xStart);
        top = Math.min(top, y);
        right = Math.max(right, xEnd);
        bottom = Math.max(bottom, y + 1);

        const targetLeft = Math.max(xStart, Number(region.targetBounds.left));
        const targetRight = Math.min(xEnd, Number(region.targetBounds.right));
        if (y >= Number(region.targetBounds.top)
          && y < Number(region.targetBounds.bottom)
          && targetRight > targetLeft) {
          insideTarget += targetRight - targetLeft;
        }

        const searchLeft = Math.max(xStart, Number(region.bounds.left));
        const searchRight = Math.min(xEnd, Number(region.bounds.right));
        const insideSearch = y >= Number(region.bounds.top) && y < Number(region.bounds.bottom)
          ? Math.max(0, searchRight - searchLeft)
          : 0;
        outsideSearch += (xEnd - xStart) - insideSearch;

        const nearestX = seedX < xStart ? xStart : seedX >= xEnd ? xEnd - 1 : seedX;
        seedDistance = Math.min(seedDistance, Math.hypot(nearestX - seedX, y - seedY));
        cursor = rowEnd;
      }
    });

    return {
      selected,
      bounds: { left, top, right, bottom },
      insideTarget,
      outsideSearch,
      seedDistance
    };
  }

  return {
    decodeSegmentationRleCrop,
    summarizeSegmentationRle,
    normalizeRlePayload
  };
});
