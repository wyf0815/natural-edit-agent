(function (root, factory) {
  root.PhotoshopAssistantV8Engine = factory(
    root.PhotoshopAssistantV8Protocol,
    root.PhotoshopAssistantV8State,
    root.PhotoshopAssistantV8Capabilities,
    root.PhotoshopAssistantV9Planner
  );
})(typeof globalThis !== "undefined" ? globalThis : this, function (protocol, stateEngine, capabilities, planner) {
  "use strict";

  const { app, core, action, constants } = require("photoshop");
  const selectionSessions = typeof globalThis !== "undefined"
    ? globalThis.PhotoshopAssistantV97SelectionSession || null
    : null;
  if (!planner) throw new Error("Natural Edit Agent 规划器未加载。");

  function assertBatchPlayResults(results, label) {
    if (!Array.isArray(results)) throw new Error(`${label}没有返回Photoshop结果。`);
    results.forEach((item, index) => {
      capabilities.batchPlayError([item], `${label}（第${index + 1}项）`);
    });
  }

  async function selectDocument(documentId) {
    const results = await action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "document", _id: Number(documentId) }],
      _options: { dialogOptions: "dontDisplay" }
    }], {});
    assertBatchPlayResults(results, "选择文档");
    if (!app.documents.length || Number(app.activeDocument.id) !== Number(documentId)) {
      throw new Error(`无法把文档${documentId}设为当前文档。`);
    }
  }

  async function selectLayers(layerIds) {
    const ids = (layerIds || []).map(Number).filter(Number.isFinite);
    if (!ids.length) return;
    const commands = ids.map((id, index) => ({
      _obj: "select",
      _target: [{ _ref: "layer", _id: id }],
      makeVisible: false,
      ...(index ? { selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" } } : {}),
      _options: { dialogOptions: "dontDisplay" }
    }));
    const results = await action.batchPlay(commands, {});
    assertBatchPlayResults(results, "选择图层");
    const selected = new Set(Array.from(app.activeDocument.activeLayers || []).map((layer) => Number(layer.id)));
    const missing = ids.filter((id) => !selected.has(id));
    if (missing.length) throw new Error(`Photoshop没有选中目标图层：${missing.join("、")}。`);
  }

  const COLOR_WORDS = Object.freeze(Object.fromEntries(
    Object.entries(protocol.NAMED_COLORS || {}).map(([name, value]) => [`${name}色`, value])
  ));

  const BLEND_WORDS = {
    正常: "normal", 正片叠底: "multiply", 滤色: "screen", 叠加: "overlay",
    柔光: "softLight", 强光: "hardLight", 变暗: "darken", 变亮: "lighten",
    颜色: "color", 色相: "hue", 饱和度: "saturation", 明度: "luminosity", 差值: "difference"
  };

  function operation(action, params) {
    return { action, target: { scope: "active_layer" }, params, reason: "本地快速指令" };
  }

  function parseSingleInstruction(instruction) {
    const text = String(instruction || "").trim();
    if (!text) return null;
    const semantics = planner && typeof planner.analyzeInstructionClause === "function"
      ? planner.analyzeInstructionClause(text)
      : {};
    const operations = [];
    const currentTarget = /(当前|选中|这个|该|副本)(文字|图层|层|组)?/.test(text) || /(当前|选中|这个|该)?图层组/.test(text);
    const documentTarget = { scope: "document" };

    const createdLayer = semantics.createdLayer || null;
    if (createdLayer && createdLayer.action === "layer.create_pixel") {
      operations.push({
        action: "layer.create_pixel",
        target: documentTarget,
        params: { name: createdLayer.name },
        reason: "本地快速指令"
      });
    }

    if (createdLayer && createdLayer.action === "text.create") {
      operations.push({
        action: "text.create",
        target: documentTarget,
        params: { name: createdLayer.name, content: createdLayer.content },
        reason: "本地快速指令"
      });
    }

    const createNamedGroup = text.match(/(?:建立|创建|新建)(?:一个)?(?:名为|叫做|叫|名称为)\s*([^的，。,\n]+)(?:的)?(?:图层)?组/)
      || text.match(/(?:建立|创建|新建)(?:一个)?(?:图层)?组(?:叫做|名为|命名为|名称为|叫|为)\s*([^，。,\n]+)/);
    if (createNamedGroup) {
      const name = createNamedGroup[1]
        .trim()
        .replace(/^[“”‘’"'「」『』]+|[“”‘’"'「」『』]+$/g, "")
        .trim();
      if (name) {
        operations.push({
          action: "layer.create_group",
          target: documentTarget,
          params: { name },
          reason: "本地快速指令"
        });
      }
    }

    const exportMatch = text.match(/(?:导出|另存)(?:为|成)?\s*(PNG|JPG|JPEG|PSD|PSB|GIF|BMP)/i);
    if (exportMatch) operations.push({ action: "document.export", target: documentTarget, params: { format: exportMatch[1].toLowerCase() }, reason: "本地快速指令" });

    const imageSize = text.match(/(?:图像|图片)(?:大小|尺寸)?\s*(?:调整|修改|改)?(?:为|成|到)?\s*(\d+)\s*[x×*]\s*(\d+)\s*(?:像素|px)?/i);
    if (imageSize) operations.push({ action: "document.resize_image", target: documentTarget, params: { width: Number(imageSize[1]), height: Number(imageSize[2]), constrainProportions: /保持比例|等比/.test(text) }, reason: "本地快速指令" });
    const canvasSize = text.match(/画布(?:大小|尺寸)?\s*(?:调整|修改|改)?(?:为|成|到)?\s*(\d+)\s*[x×*]\s*(\d+)\s*(?:像素|px)?/i);
    if (canvasSize) operations.push({ action: "document.resize_canvas", target: documentTarget, params: { width: Number(canvasSize[1]), height: Number(canvasSize[2]), anchor: /左上/.test(text) ? "top_left" : /右上/.test(text) ? "top_right" : /左下/.test(text) ? "bottom_left" : /右下/.test(text) ? "bottom_right" : "middle_center" }, reason: "本地快速指令" });

    const explicitSelection = text.match(/(?:建立|创建|新建|选择)(?:一个)?\s*左\s*(\d+(?:\.\d+)?)\s*[、,，]?\s*上\s*(\d+(?:\.\d+)?)\s*[、,，]?\s*右\s*(\d+(?:\.\d+)?)\s*[、,，]?\s*下\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?(?:的)?\s*(矩形|椭圆|圆形)选区/i);
    if (explicitSelection) {
      operations.push({
        action: explicitSelection[5] === "矩形" ? "selection.rectangle" : "selection.ellipse",
        target: documentTarget,
        params: {
          unit: "pixels",
          left: Number(explicitSelection[1]),
          top: Number(explicitSelection[2]),
          right: Number(explicitSelection[3]),
          bottom: Number(explicitSelection[4]),
          feather: 0,
          antiAlias: true
        },
        reason: "本地快速指令"
      });
    }
    if (/(?:选择|选中|选取|识别)(?:画面|图像|图片|当前画面)?(?:中的)?(?:主体|主要人物)|(?:选择主体|主体抠图)/.test(text)) {
      operations.push({ action: "selection.subject", target: documentTarget, params: { sampleAllLayers: true }, reason: "本地快速指令" });
    }
    let requestedColor = (text.match(/#[0-9a-fA-F]{6}\b/) || [])[0] || null;
    if (!requestedColor) {
      for (const [word, color] of Object.entries(COLOR_WORDS)) {
        if (text.includes(word)) { requestedColor = color; break; }
      }
    }
    const colorTolerance = text.match(/(?:颜色)?容差\s*(?:为|设为|设置为)?\s*(\d+(?:\.\d+)?)/);
    const exactColorReplacement = semantics.globalColorReplacement || null;
    if (exactColorReplacement) {
      operations.push({
        action: "selection.color_range",
        target: documentTarget,
        params: {
          color: exactColorReplacement.sourceColor,
          tolerance: exactColorReplacement.tolerance,
          softness: exactColorReplacement.softness
        },
        reason: "本地精确换色"
      });
      operations.push({
        action: "adjustment.colorize",
        target: documentTarget,
        params: {
          color: exactColorReplacement.targetColor,
          opacity: exactColorReplacement.opacity,
          blendMode: exactColorReplacement.blendMode,
          name: `替换颜色 ${exactColorReplacement.sourceColor} → ${exactColorReplacement.targetColor}`
        },
        reason: "本地精确换色"
      });
    }
    if (requestedColor && /(?:选择|选中|选取).*(?:颜色|色块|像素|区域)/.test(text) && !/(文字|文本|字体)/.test(text)) {
      const defaults = protocol.defaultsForAction("selection.color_range");
      operations.push({ action: "selection.color_range", target: documentTarget, params: { color: requestedColor, tolerance: Number(colorTolerance ? colorTolerance[1] : defaults.tolerance), softness: defaults.softness }, reason: "本地快速指令" });
    }

    const contract = text.match(/(?:当前)?选区(?:向内)?收缩\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
    if (contract) operations.push({ action: "selection.contract", target: documentTarget, params: { by: Number(contract[1]), applyAtCanvasBounds: false }, reason: "本地快速指令" });
    const expand = text.match(/(?:当前)?选区(?:向外)?(?:扩展|扩大)\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
    if (expand) operations.push({ action: "selection.expand", target: documentTarget, params: { by: Number(expand[1]), applyAtCanvasBounds: false }, reason: "本地快速指令" });
    const feather = text.match(/(?:当前)?选区(?:边缘)?羽化\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
    if (feather) operations.push({ action: "selection.feather", target: documentTarget, params: { by: Number(feather[1]), applyAtCanvasBounds: false }, reason: "本地快速指令" });
    const grow = text.match(/(?:按)?(?:颜色)?容差\s*(\d+(?:\.\d+)?)\s*(?:扩展|扩大)(?:当前)?选区|(?:扩展|扩大)(?:当前)?选区.*?(?:颜色)?容差\s*(\d+(?:\.\d+)?)/i);
    if (grow) operations.push({ action: "selection.grow", target: documentTarget, params: { tolerance: Number(grow[1] || grow[2]), antiAlias: true }, reason: "本地快速指令" });
    const smooth = text.match(/(?:当前)?选区(?:边缘)?(?:平滑|平滑处理)\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?|把(?:当前)?选区平滑\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
    if (smooth) operations.push({ action: "selection.smooth", target: documentTarget, params: { radius: Number(smooth[1] || smooth[2]), applyAtCanvasBounds: false }, reason: "本地快速指令" });
    if (semantics.selectionAction === "selection.select_all") {
      operations.push({ action: "selection.select_all", target: documentTarget, params: {}, reason: "本地快速指令" });
    }
    if (/(?:取消|清除)(?:当前)?选区|取消选择|取消选取/.test(text)) {
      operations.push({ action: "selection.deselect", target: documentTarget, params: {}, reason: "本地快速指令" });
    }
    if (/(?:反选|反相)(?:当前)?选区|(?:当前)?选区(?:反选|反相)/.test(text)) {
      operations.push({ action: "selection.invert", target: documentTarget, params: {}, reason: "本地快速指令" });
    }
    const border = text.match(/(?:当前)?选区(?:建立|创建|变成|转成)?\s*(?:宽度为)?\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?(?:的)?边界|给(?:当前)?选区建立\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?(?:的)?边界/i);
    if (border) operations.push({ action: "selection.border", target: documentTarget, params: { width: Number(border[1] || border[2]) }, reason: "本地快速指令" });
    if (/(?:载入|加载|读取)(?:当前|选中|这个|该)?图层(?:的)?(?:透明区域|像素|选区)|把(?:当前|选中|这个|该)?图层(?:的)?(?:透明区域|像素)载入选区/.test(text)) {
      operations.push(operation("selection.load_layer", {}));
    }
    const adjustmentText = text.replace(/(?:填充)?(?:不透明度|透明度)/g, "");
    const hue = adjustmentText.match(/色相\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/);
    const saturation = adjustmentText.match(/饱和度\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/);
    const lightness = adjustmentText.match(/(?:明度|亮度)\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/);
    if (/(当前选区|选中的区域|局部区域)/.test(text) && (hue || saturation || lightness)) {
      operations.push({ action: "adjustment.hue_saturation", target: documentTarget, params: { hue: Number(hue ? hue[1] : 0), saturation: Number(saturation ? saturation[1] : 0), lightness: Number(lightness ? lightness[1] : 0) }, reason: "本地快速指令" });
    } else if (requestedColor && /(当前选区|选中的区域|局部区域).*(?:改成|改为|换成|变成|上色)/.test(text) && !/(文字|文本|字体)/.test(text)) {
      const localOpacity = text.match(/(?<!填充)(?:不透明度|透明度)\s*(?:为|改为|设置为|调到|设为)?\s*(\d+(?:\.\d+)?)\s*%?/);
      operations.push({ action: "adjustment.colorize", target: documentTarget, params: { color: requestedColor, opacity: Number(localOpacity ? localOpacity[1] : 100), blendMode: "normal" }, reason: "本地快速指令" });
    }
    if (/(?:把|将|用)?(?:当前)?选区(?:转换|转成|建立|创建|添加|作为|给).*(?:当前|选中|这个|该)?图层.*蒙版|(?:给|为)(?:当前|选中|这个|该)?图层.*(?:按|用)(?:当前)?选区.*蒙版/.test(text)) {
      operations.push(operation("mask.create_from_selection", {}));
    } else if (/(?:给|为)(?:当前|选中|这个|该)?图层(?:添加|创建|建立)(?:一个)?(?:显示全部|全白)蒙版/.test(text)) {
      operations.push(operation("mask.create_reveal_all", {}));
    } else if (/(?:给|为)(?:当前|选中|这个|该)?图层(?:添加|创建|建立)(?:一个)?(?:隐藏全部|全黑)蒙版/.test(text)) {
      operations.push(operation("mask.create_hide_all", {}));
    }
    if (/(?:反相|反转)(?:当前|选中|这个|该)?图层蒙版|(?:当前|选中|这个|该)?图层蒙版(?:反相|反转)/.test(text)) operations.push(operation("mask.invert", {}));
    if (/(?:删除|移除)(?:当前|选中|这个|该)?图层蒙版/.test(text)) operations.push(operation("mask.delete", {}));
    if (/(?:应用)(?:当前|选中|这个|该)?图层蒙版/.test(text)) operations.push(operation("mask.apply", {}));
    if (/按(?:当前)?选区裁剪(?:文档)?|裁剪(?:文档)?到(?:当前)?选区/.test(text)) operations.push({ action: "document.crop", target: documentTarget, params: { reference: "selection" }, reason: "本地快速指令" });
    if (/(?:裁掉|裁切|裁剪)(?:文档)?四周透明(?:像素|边缘)|去掉(?:文档)?四周透明(?:像素|边缘)/.test(text)) operations.push({ action: "document.trim", target: documentTarget, params: { type: "transparent", top: true, left: true, bottom: true, right: true }, reason: "本地快速指令" });
    if (semantics.documentAction === "document.reveal_all") operations.push({ action: "document.reveal_all", target: documentTarget, params: {}, reason: "本地快速指令" });
    if (semantics.documentAction === "document.rotate") {
      operations.push({ action: "document.rotate", target: documentTarget, params: { angle: semantics.documentAngle }, reason: "本地快速指令" });
    }

    if (!currentTarget && !operations.length) return null;

    if (/(复制|拷贝)(当前|选中|这个|该)?(文字|图层|层)/.test(text) || /(当前|选中|这个|该)(文字|图层|层).*(复制|拷贝)/.test(text)) {
      operations.push(operation("layer.duplicate", {}));
    }
    if (!/蒙版/.test(text) && (/(删除|移除)(当前|选中|这个|该)?(文字|图层|层|组)/.test(text) || /(当前|选中|这个|该)(文字|图层|层|组).*(删除|移除)/.test(text))) {
      operations.push(operation("layer.delete", {}));
    }

    const rename = text.match(/(?:重命名|名称改为|名字改为)(?:为|成)?\s*([^，。,\n]+)/);
    if (rename) {
      const name = rename[1]
        .trim()
        .replace(/^[“”‘’"'「」『』]+|[“”‘’"'「」『』]+$/g, "")
        .trim();
      if (name) operations.push(operation("layer.rename", { name }));
    }

    if (/(隐藏|不可见)(当前|选中|这个|该)?(文字|图层|层)/.test(text) || /(当前|选中|这个|该)(文字|图层|层).*(隐藏|不可见)/.test(text)) {
      operations.push(operation("layer.set_visibility", { visible: false }));
    } else if (/(显示|可见)(当前|选中|这个|该)?(文字|图层|层)/.test(text) || /(当前|选中|这个|该)(文字|图层|层).*(显示|可见)/.test(text)) {
      operations.push(operation("layer.set_visibility", { visible: true }));
    }

    const hasLocalAdjustment = operations.some((item) => item.action.startsWith("adjustment."));
    const fillOpacity = text.match(/填充(?:不透明度|透明度)\s*(?:调整|修改|设置|调|改)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)\s*%?/);
    if (!hasLocalAdjustment && fillOpacity) {
      operations.push(operation("layer.set_fill_opacity", { fillOpacity: Number(fillOpacity[1]) }));
    } else if (!hasLocalAdjustment) {
      const opacity = text.match(/(?<!填充)(?:不透明度|透明度)\s*(?:调整|修改|设置|调|改)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)\s*%?/);
      if (opacity) operations.push(operation("layer.set_opacity", { opacity: Number(opacity[1]) }));
    }

    for (const [word, blendMode] of Object.entries(BLEND_WORDS)) {
      if (text.includes(word) && /混合模式/.test(text)) {
        operations.push(operation("layer.set_blend_mode", { blendMode }));
        break;
      }
    }

    if (/(解除完全锁定|取消完全锁定|解锁图层|解锁当前)/.test(text)) {
      operations.push(operation("layer.set_lock", { lock: "all", locked: false }));
    } else if (/(完全锁定|锁定图层|锁定当前)/.test(text)) {
      operations.push(operation("layer.set_lock", { lock: "all", locked: true }));
    }

    const moves = [...text.matchAll(/向(左|右|上|下)(?:移动)?\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/gi)];
    if (moves.length) {
      const delta = moves.reduce((sum, match) => {
        const amount = Number(match[2]);
        const part = { 左: [-amount, 0], 右: [amount, 0], 上: [0, -amount], 下: [0, amount] }[match[1]];
        return [sum[0] + part[0], sum[1] + part[1]];
      }, [0, 0]);
      operations.push(operation("layer.move_by", { deltaX: delta[0], deltaY: delta[1] }));
    }
    const scale = semantics.fit || /(?:文字|文本|字体)?(?:水平|垂直)缩放/.test(text)
      ? null
      : text.match(/(?:图层|文字|对象)?\s*(?:宽高)?\s*(?:缩放|放大|缩小)(?:为|到)?\s*(\d+(?:\.\d+)?)\s*%/);
    if (scale) operations.push(operation("layer.scale", { scale: Number(scale[1]) }));
    const rotate = /(?:整个)?(?:文档|画布)/.test(text) ? null : text.match(/(?:顺时针|向右)?\s*旋转\s*(\d+(?:\.\d+)?)\s*度/);
    const counterRotate = /(?:整个)?(?:文档|画布)/.test(text) ? null : text.match(/(?:逆时针|向左)\s*旋转\s*(\d+(?:\.\d+)?)\s*度/);
    if (counterRotate) operations.push(operation("layer.rotate", { angle: -Number(counterRotate[1]) }));
    else if (rotate) operations.push(operation("layer.rotate", { angle: Number(rotate[1]) }));
    if (/水平翻转|左右翻转|左右镜像/.test(text)) operations.push(operation("layer.flip", { axis: "horizontal" }));
    else if (/垂直翻转|上下翻转|上下镜像/.test(text)) operations.push(operation("layer.flip", { axis: "vertical" }));
    if (/(?:栅格化|像素化)(?:当前|选中|这个|该)?(?:文字|形状|智能对象|图层|层)|(?:当前|选中|这个|该)?(?:文字|形状|智能对象|图层|层)(?:进行)?(?:栅格化|像素化)/.test(text)) {
      operations.push(operation("layer.rasterize", { target: "entire_layer" }));
    }
    const horizontalSkew = text.match(/水平斜切\s*(-?\d+(?:\.\d+)?)\s*度/);
    const verticalSkew = text.match(/垂直斜切\s*(-?\d+(?:\.\d+)?)\s*度/);
    if (horizontalSkew || verticalSkew) operations.push(operation("layer.skew", {
      angleH: horizontalSkew ? Number(horizontalSkew[1]) : 0,
      angleV: verticalSkew ? Number(verticalSkew[1]) : 0
    }));
    if (/(置于最前|移到最前|置顶图层)/.test(text)) operations.push(operation("layer.reorder", { position: "front" }));
    if (/(置于最后|移到最后|置底图层)/.test(text)) operations.push(operation("layer.reorder", { position: "back" }));
    const moveToGroupMatch = text.match(/(?:放到|放入|移到|移入|移动到|拖到)\s*([^，。,\n]+)/);
    if (
      moveToGroupMatch &&
      /(?:放到|放入|移到|移入|移动到|拖到).*(?:图层组|组)/.test(text)
    ) {
      const groupName = moveToGroupMatch[1]
        .trim()
        .replace(/[“”‘’"'「」『』]/g, "")
        .replace(/\s*(?:里面|中|内)\s*$/, "")
        .replace(/\s*的图层组\s*$/, "")
        .trim();
      if (groupName) operations.push(operation("layer.move_to_group", { groupName }));
    }

    const quotedContent = text.match(/(?:文字内容|文本内容)\s*(?:修改|改|替换)?\s*(?:为|成)?\s*[“"']([^”"']*)[”"']/)
      || text.match(/(?:把|将)\s*(?:当前|选中|这个|该)?\s*(?:文字|文本)(?:内容)?\s*(?:修改|改|替换)?\s*(?:为|成)\s*[“"']([^”"']*)[”"']/);
    if (quotedContent) operations.push(operation("text.set_content", { content: quotedContent[1] }));

    const size = text.match(/(?:字号|文字大小)\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)/);
    if (size) operations.push(operation("text.set_size", { size: Number(size[1]) }));
    const font = text.match(/(?:字体|字型)\s*(?:调整|修改|改|设)?\s*(?:为|成|到)?\s*[“"']?([^，。,\n”"']+)/);
    if (font && !/(颜色|大小|字号|行距|字距)/.test(font[1])) operations.push(operation("text.set_font", { font: font[1].trim() }));
    const leading = text.match(/行距\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)/);
    if (leading) operations.push(operation("text.set_leading", { leading: Number(leading[1]) }));
    const tracking = text.match(/字距\s*(?:调整|修改|改)?\s*(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/);
    if (tracking) operations.push(operation("text.set_tracking", { tracking: Number(tracking[1]) }));
    if (semantics.baselineShift != null) operations.push(operation("text.set_baseline_shift", { baselineShift: semantics.baselineShift }));
    const horizontalScale = text.match(/(?:文字|文本|字体)?水平缩放\s*(?:调整|修改|改|设)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)\s*%?/);
    if (horizontalScale) operations.push(operation("text.set_horizontal_scale", { scale: Number(horizontalScale[1]) }));
    const verticalScale = text.match(/(?:文字|文本|字体)?垂直缩放\s*(?:调整|修改|改|设)?\s*(?:为|成|到)?\s*(\d+(?:\.\d+)?)\s*%?/);
    if (verticalScale) operations.push(operation("text.set_vertical_scale", { scale: Number(verticalScale[1]) }));
    if (/(?:关闭|取消|禁用)(?:当前|选中|这个|该)?(?:文字|文本)?连字符|(?:当前|选中|这个|该)?(?:文字|文本)?连字符(?:关闭|取消|禁用)/.test(text)) {
      operations.push(operation("text.set_hyphenation", { enabled: false }));
    } else if (/(?:开启|启用|使用)(?:当前|选中|这个|该)?(?:文字|文本)?连字符|(?:当前|选中|这个|该)?(?:文字|文本)?连字符(?:开启|启用)/.test(text)) {
      operations.push(operation("text.set_hyphenation", { enabled: true }));
    }
    const paragraphParams = {};
    const paragraphPatterns = {
      firstLineIndent: /首行缩进(?:设|设置|调整|修改|改)?(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/,
      leftIndent: /左缩进(?:设|设置|调整|修改|改)?(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/,
      rightIndent: /右缩进(?:设|设置|调整|修改|改)?(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/,
      spaceBefore: /段前(?:间距)?(?:设|设置|调整|修改|改)?(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/,
      spaceAfter: /段后(?:间距)?(?:设|设置|调整|修改|改)?(?:为|成|到)?\s*(-?\d+(?:\.\d+)?)/
    };
    for (const [key, pattern] of Object.entries(paragraphPatterns)) {
      const match = text.match(pattern);
      if (match) paragraphParams[key] = Number(match[1]);
    }
    if (Object.keys(paragraphParams).length) operations.push(operation("text.set_paragraph_spacing", paragraphParams));
    if (/(文字|文本).*(左对齐)/.test(text)) operations.push(operation("text.set_justification", { justification: "left" }));
    if (/(文字|文本).*(居中|中对齐)/.test(text)) operations.push(operation("text.set_justification", { justification: "center" }));
    if (/(文字|文本).*(右对齐)/.test(text)) operations.push(operation("text.set_justification", { justification: "right" }));
    if (/(文字|文本).*(取消加粗|取消粗体)/.test(text)) operations.push(operation("text.set_faux_bold", { enabled: false }));
    else if (/(文字|文本).*(加粗|粗体)/.test(text)) operations.push(operation("text.set_faux_bold", { enabled: true }));
    if (/(文字|文本).*(取消斜体)/.test(text)) operations.push(operation("text.set_faux_italic", { enabled: false }));
    else if (/(文字|文本).*(斜体)/.test(text)) operations.push(operation("text.set_faux_italic", { enabled: true }));

    const textColorContext = /(文字|字体|文本)/.test(text);
    const namedDestination = text.match(/(?:颜色.{0,8})?(?:改成|改为|设为|设置为|换成|变成|改|换)\s*(红色|蓝色|绿色|黄色|黑色|白色|灰色|紫色|橙色|粉色)/);
    const hexDestinations = [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)];
    const explicitHexDestination = text.match(/(?:改成|改为|设为|设置为|换成|变成|替换为)\s*(#[0-9a-fA-F]{6})\b/);
    const textColor = namedDestination
      ? COLOR_WORDS[namedDestination[1]]
      : explicitHexDestination
        ? explicitHexDestination[1]
        : hexDestinations.length === 1
          ? hexDestinations[0][0]
          : null;
    if (textColorContext && textColor) operations.push(operation("text.set_color", { color: textColor }));

    if (!/缩放/.test(text) && /(文字|文本).*(竖排|垂直)/.test(text)) operations.push(operation("text.set_orientation", { orientation: "vertical" }));
    if (!/缩放/.test(text) && /(文字|文本).*(横排|水平)/.test(text)) operations.push(operation("text.set_orientation", { orientation: "horizontal" }));

    const reference = /选区/.test(text) ? "selection" : /画布/.test(text) ? "canvas" : null;
    const paddingMatch = text.match(/(?:四周|边缘|边距)(?:留|保留|设置为|为)?\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
    const padding = paddingMatch ? Number(paddingMatch[1]) : 0;
    if (semantics.fit) {
      operations.push(operation(semantics.fit.action, semantics.fit.params));
    } else if (reference && /(对齐|居中)/.test(text)) {
      const horizontalCenter = /(?:水平|横向)居中/.test(text);
      const verticalCenter = /(?:垂直|纵向)居中/.test(text);
      const genericCenter = /居中/.test(text) && !horizontalCenter && !verticalCenter;
      const horizontal = /左/.test(text) ? "left" : /右/.test(text) ? "right" : (horizontalCenter || genericCenter) ? "center" : "preserve";
      const vertical = /顶部|上边/.test(text) ? "top" : /底部|下边/.test(text) ? "bottom" : (verticalCenter || genericCenter) ? "middle" : "preserve";
      operations.push(operation("layer.align_to_reference", { reference, padding, horizontal, vertical }));
    }

    if (semantics.filter) operations.push(operation(semantics.filter.action, semantics.filter.params));

    if (/组内|图层组/.test(text)) {
      const styleParams = {};
      const actionKeys = {
        "text.set_color": "color", "text.set_size": "size", "text.set_font": "font", "text.set_leading": "leading",
        "text.set_tracking": "tracking", "text.set_baseline_shift": "baselineShift", "text.set_justification": "justification", "text.set_orientation": "orientation"
      };
      const remaining = [];
      for (const item of operations) {
        if (actionKeys[item.action]) styleParams[actionKeys[item.action]] = item.params[actionKeys[item.action]];
        else if (item.action === "text.set_paragraph_spacing") Object.assign(styleParams, item.params);
        else if (item.action === "text.set_faux_bold") styleParams.fauxBold = item.params.enabled;
        else if (item.action === "text.set_faux_italic") styleParams.fauxItalic = item.params.enabled;
        else remaining.push(item);
      }
      if (Object.keys(styleParams).length) remaining.push(operation("group.set_text_style", styleParams));
      operations.length = 0;
      operations.push(...remaining);
    }

    if (!operations.length) return null;
    const deduped = [];
    const seen = new Set();
    for (const item of operations) {
      const key = `${item.action}:${JSON.stringify(item.params)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    }
    return protocol.normalizeIntent({
      summary: `将按顺序执行${deduped.length}项修改。`,
      operations: deduped,
      constraints: ["只修改绑定的目标图层", "执行后逐项复读验收"]
    }, { allowUnlinkedRequirements: true });
  }

  function splitDeterministicClauses(text) {
    return planner.splitClauses(text);
  }

  function clauseWithInheritedTarget(clause, context) {
    if (/(当前|选中|这个|该|副本)(文字|图层|层|组)?|图层组|选区|文档|画布/.test(clause)) return clause;
    if (context === "selection" && /^(?:向内|向外)?(?:收缩|扩展|扩大|羽化|平滑)/.test(clause)) return `当前选区${clause}`;
    if (context === "group_text") return `把当前图层组内所有文字${clause.replace(/^把/, "")}`;
    if (context === "text") return `把当前文字${clause.replace(/^把/, "")}`;
    if (context === "layer") return `把当前图层${clause.replace(/^把/, "")}`;
    if (context === "copy") return `把副本${clause.replace(/^把/, "")}`;
    if (context === "created") return `把当前图层${clause.replace(/^把/, "")}`;
    return clause;
  }

  function parseFastInstruction(instruction) {
    const text = String(instruction || "").trim();
    if (!text) return null;
    const clauses = splitDeterministicClauses(text);
    const requirements = planner.buildRequirements(text);
    // A deterministic operation may only be emitted when the authorization
    // ledger contains an explicit requirement for it.  This also keeps
    // informational questions such as "怎么删除图层？" on the explanation path.
    if (!requirements.length) return null;
    const combined = [];
    let context = null;
    let resultProducer = null;
    const groupProducers = new Map();
    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      const rawClause = clauses[clauseIndex];
      const clause = clauseWithInheritedTarget(rawClause, context);
      const parsed = parseSingleInstruction(clause);
      if (!parsed) return null;
      const requirementIds = planner.requirementsForClause(requirements, clauseIndex);
      if (!requirementIds.length) return null;
      const localOperations = parsed.operations.map((item) => ({
        ...item,
        target: { ...item.target },
        params: { ...item.params },
        requirementIds: [...requirementIds]
      }));
      const duplicateIndex = localOperations.findIndex((item) => item.action === "layer.duplicate");
      for (let index = 0; index < localOperations.length; index += 1) {
        const item = localOperations[index];
        item.id = `local_${combined.length + 1}`;
        const followsSameClauseCopy = duplicateIndex >= 0 && index > duplicateIndex;
        const explicitlyTargetsCopy = /副本|拷贝层|复制层/.test(rawClause);
        const explicitlyTargetsExisting = /(?:当前|选中)(?:的)?(?:文字|图层|层|组)/.test(rawClause);
        if (item.action === "layer.move_to_group" && groupProducers.has(item.params.groupName)) {
          item.params.groupResultOf = groupProducers.get(item.params.groupName);
        }
        if (item.target.scope === "active_layer" && resultProducer && !explicitlyTargetsExisting && (explicitlyTargetsCopy || context === "copy" || context === "created")) {
          item.target = { scope: "operation_result", resultOf: resultProducer };
        } else if (item.target.scope === "active_layer" && followsSameClauseCopy) {
          item.target = { scope: "operation_result", resultOf: resultProducer || localOperations[duplicateIndex].id };
        }
        const previous = combined[combined.length - 1];
        if (previous && previous.action === "group.set_text_style" && item.action === "group.set_text_style"
          && JSON.stringify(previous.target) === JSON.stringify(item.target)) {
          previous.params = { ...previous.params, ...item.params };
          previous.requirementIds = [...new Set([...(previous.requirementIds || []), ...(item.requirementIds || [])])];
          context = "group_text";
          continue;
        }
        combined.push(item);
        if (item.action === "layer.create_group") {
          groupProducers.set(item.params.name, item.id);
          resultProducer = item.id;
          context = "created";
        } else if (item.action === "layer.duplicate") {
          resultProducer = item.id;
          context = "copy";
        } else if (item.action === "layer.create_pixel" || item.action === "text.create") {
          resultProducer = item.id;
          context = "created";
        } else if (item.action === "group.set_text_style") {
          context = "group_text";
        } else if (item.action.startsWith("selection.")) {
          context = "selection";
        } else if (item.action.startsWith("text.")) {
          context = "text";
        } else if (!item.action.startsWith("document.")) {
          context = resultProducer ? "copy" : "layer";
        }
      }
    }
    if (!combined.length) return null;
    const intent = protocol.normalizeIntent({
      summary: `按顺序执行${combined.length}项确定性修改。`,
      operations: combined,
      constraints: ["严格保持操作先后依赖", "复制后的连续修改只作用于副本", "执行后逐项复读验收"]
    });
    return planner.normalizeDependencies(intent);
  }

  function isModificationInstruction(instruction) {
    return /(改成|改为|修改|调整|重命名|命名为|名称改为|名字改为|移动|缩放|旋转|翻转|斜切|删除|移除|新增|创建|复制|拷贝|合并|裁剪|模糊|锐化|填充|导出|加上|添加|去掉|变成|换成|换色|上色|抠出|抠图|提取|隐藏|显示|保留|反相|应用|建立|放入|放到|设置|转换|栅格化|变亮|变暗|增亮|压暗|提亮|调亮|调暗|降低|提高|增加|减少|改(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?)/.test(String(instruction || ""));
  }

  function requiresVisualGrounding(instruction) {
    const text = String(instruction || "");
    const semanticClauses = planner && typeof planner.analyzeInstructionClause === "function"
      ? planner.splitClauses(text).map((clause) => planner.analyzeInstructionClause(clause))
      : [];
    if (semanticClauses.length && semanticClauses.every((item) => item.structuralGlobalAction || item.globalColorReplacement)) {
      return false;
    }
    const adjustmentText = text.replace(/(?:填充)?(?:不透明度|透明度)/g, "");
    const existingSelectionWorkflow = /(?:当前|已有|现有)选区/.test(text)
      && /(?:羽化|扩展|收缩|平滑|反选|取消选择|创建|建立|添加|生成|应用|载入|加载|边界)/.test(text)
      && !/(选区.{0,16}(?:人物|角色|对象|物体|主体|奖杯|衣服|帽子|背景))/.test(text);
    const nativeWholeSubjectSelectionOnly = /(?:选择|选中|选取).{0,20}(?:完整|整个|全身|主要|画面中)?(?:主体|主要人物|人物主体)/.test(text)
      && !/(改成|改为|修改|调整|换色|上色|抠出|抠图|提取|隐藏|删除|移除|蒙版|模糊|锐化|填充|复制|移动|缩放|旋转)/.test(text);
    const explicitColorSelectionOnly = /(?:选择|选中|选取).{0,28}(?:颜色范围|同色区域|相同颜色区域|同色像素|色块|(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?像素|#[0-9a-fA-F]{3,6})/.test(text)
      && !/(改成|改为|修改|调整|换色|上色|抠出|抠图|提取|隐藏|删除|移除|蒙版|模糊|锐化|填充|复制|移动|缩放|旋转)/.test(text);
    if (existingSelectionWorkflow || nativeWholeSubjectSelectionOnly || explicitColorSelectionOnly) return false;
    const exactGlobalColor = (text.match(/#[0-9a-fA-F]{6}\b/g) || []).length >= 2
      && /(?:图中|画面中)?\s*#[0-9a-fA-F]{6}.*(?:改成|改为|换成|变成)\s*#[0-9a-fA-F]{6}/.test(text)
      && !/(左|右|上|下|附近|局部|人物|角色|奖杯|叶子|衣服|帽子|胡子|污点|图标|色块|眼睛|嘴|数字|背景|主体)/.test(text);
    if (exactGlobalColor) return false;
    const visualQuestion = /(图中|画面|图片|当前图(?!层)).*(内容|人物|对象|物体|主体|构图|哪里|位置|颜色)/.test(text);
    const semanticAction = /(选择|选中|改色|颜色|换色|上色|饱和度|自然饱和度|亮度|明度|对比度|曝光度|抠出|抠图|提取|隐藏|显示|去背景|建立蒙版|创建蒙版|羽化|模糊|锐化|擦除|修掉|去除|删除|移除|变亮|变暗|提亮|压暗)/.test(adjustmentText)
      || /(?:改|换|变)(?:成|为)?\s*(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?/.test(adjustmentText)
      || /(?:改成|改为|换成|变成).{0,8}#[0-9a-fA-F]{3,6}/.test(adjustmentText);
    const explicitlyStructuredTarget = /(?:当前|选中|指定|名为|名称为).{0,10}(?:图层组|图层|文字层|层|文字|文本)|(?:图层|文字|文本|文字层|图层组|层).{0,16}(?:名称|路径|ID)|(?:当前|已有)选区/.test(text)
      || /(?:把|将|给|对|为)\s*[^，。；]{1,30}?(?:图层组|图层|层)(?=.{0,24}(?:隐藏|显示|删除|移除|改|设|调|设置|锁定|解锁|移动|缩放|旋转|翻转|栅格化|转换|合并|添加|应用|不透明度|透明度|混合模式|字号|字体|颜色|模糊|锐化|杂色|亮度|对比度|曝光度))/.test(text)
      || /(?:隐藏|显示|删除|移除|锁定|解锁)\s*[^，。；]{1,30}?(?:图层组|图层|层)/.test(text)
      || /^[^，。；]{1,30}?(?:图层组|图层|层)(?=.{0,24}(?:隐藏|显示|删除|移除|改|设|调|设置|锁定|解锁|移动|缩放|旋转|翻转|栅格化|转换|合并|添加|应用|不透明度|透明度|混合模式|字号|字体|颜色|模糊|锐化|杂色|亮度|对比度|曝光度))/.test(text);
    const wholeDocument = /(?:整张|全图|整个画面|全部画面|整幅图).{0,12}(?:调整|改色|去色|变亮|变暗|模糊|锐化)/.test(text);
    const explicitGeometry = /(?:矩形|椭圆|多边形).{0,8}选区/.test(text)
      && /(?:左|上|右|下|中心|宽|高).{0,8}-?\d/.test(text);
    if (visualQuestion) return true;
    if (!semanticAction || wholeDocument || explicitGeometry) return false;

    // A named layer/text target is enough for metadata edits, but not for a
    // semantic sub-object inside that container (for example “当前图层里人物的帽子”).
    const semanticInsideContainer = /(?:图层|文字层|图层组|组|画面|图片)(?:里|中|内|上(?:的)?).{1,32}(?:改|换|调|选|抠|隐藏|显示|删除|移除|模糊|锐化|擦除|修掉|去除)/.test(text);
    if (semanticInsideContainer) return true;
    if (!explicitlyStructuredTarget) return true;

    const structuredLayerProperty = /(?:不透明度|透明度|填充不透明度|填充透明度|混合模式|图层名|名称|重命名|锁定|解锁|可见|隐藏图层|显示图层|移动|缩放|旋转|翻转|斜切|栅格化|智能对象|剪贴蒙版|向下合并)/.test(text)
      || /(?:当前|选中|指定|名为).{0,10}(?:图层|层)(?:整体|全部)?(?:改|换|调|设|变|隐藏|显示|模糊|锐化|删除|移除)/.test(text)
      || /(?:隐藏|显示|删除|移除|锁定|解锁).{0,12}(?:当前|选中|指定|名为).{0,10}(?:图层|层)/.test(text)
      || /(?:隐藏|显示|删除|移除|锁定|解锁)\s*[^，。；]{1,30}?(?:图层组|图层|层)/.test(text)
      || /(?:当前|选中|指定|名为).{0,10}(?:图层|层).{0,20}(?:色相|饱和度|亮度|明度|对比度|去色|黑白|高斯模糊|动感模糊|杂色|高反差保留|锐化)/.test(text)
      || /(?:当前|选中|指定).{0,10}(?:图层|层).{0,20}(?:放到|放入|移到|移入|移动到|拖到).{0,16}(?:图层组|组)/.test(text)
      || /(?:把|将|给|对|为)\s*[^，。；]{1,30}?(?:图层组|图层|层).{0,24}(?:隐藏|显示|删除|移除|改|设|调|设置|锁定|解锁|移动|缩放|旋转|翻转|斜切|栅格化|转换|合并|添加|应用|不透明度|透明度|混合模式|字号|字体|颜色|模糊|锐化|杂色|亮度|对比度|曝光度)/.test(text);
    const structuredTextProperty = /(?:文字|文本|字体|字号|字型|行距|字距|基线|缩进|段前|段后|横排|竖排|粗体|斜体|对齐|连字符).{0,24}(?:改|换|设|调整|取消|启用|禁用)/.test(text)
      || /(?:改|换|设|调整).{0,24}(?:文字|文本|字体|字号|字型|行距|字距|基线|缩进|段前|段后|横排|竖排|粗体|斜体|对齐|连字符)/.test(text);
    const structuredMaskOnly = /(?:当前|选中|指定|名为).{0,12}(?:图层|层).{0,12}(?:创建|添加|建立|删除|移除|应用|反相|羽化|密度).{0,8}(?:图层)?蒙版/.test(text)
      && !/(主体|对象|物体|局部|根据|来自|从.*选区)/.test(text);
    return !(structuredLayerProperty || structuredTextProperty || structuredMaskOnly);
  }

  function auditIntentCoverage(instruction, intent) {
    const text = String(instruction || "");
    const adjustmentText = text.replace(/(?:填充)?(?:不透明度|透明度)/g, "");
    const operations = intent && intent.operations || [];
    const actions = new Set(operations.map((item) => item.action));
    const missing = [];
    if (/(?:建立|创建|新建)(?:一个)?.{0,20}(?:图层组|组)/.test(text) && !actions.has("layer.create_group")) {
      missing.push("创建图层组");
    }
    if (/(?:放到|放入|移到|移入|移动到|拖到).*(?:图层组|组)/.test(text) && !actions.has("layer.move_to_group")) {
      missing.push("把指定图层移入目标图层组");
    }
    const hasAny = (...ids) => ids.some((id) => actions.has(id));
    const selectionOnly = actions.size > 0 && [...actions].every((id) => id.startsWith("selection."));
    const asksOnlyForSelection = /(选择|选中|选取|选区|全选|反选)/.test(text)
      && !/(改成|改为|修改|调整|换色|上色|饱和度|亮度|明度|抠出|抠图|提取|隐藏|蒙版|复制|移动|缩放|旋转|不透明度|透明度)/.test(text);
    const hasVisualObject = actions.has("selection.visual_object");
    const hasSubject = actions.has("selection.subject");
    const hasColorRange = actions.has("selection.color_range");
    const hasInvertedSelection = actions.has("selection.invert");

    if (isModificationInstruction(text) && selectionOnly && !asksOnlyForSelection) missing.push("实际修改步骤（当前计划只有选区，没有修改画面）");
    if (requiresVisualGrounding(text)) {
      const targetClass = protocol.classifyVisualTargetInstruction(text);
      const explicitGlobalColorRange = /(?:全图|整张(?:图|图片|画面)|所有|全部|每一处).{0,24}(?:像素|颜色范围|同色区域|相同颜色区域|同色像素|色块).{0,24}(?:改|换|替换|调整)/.test(text)
        || /(?:像素|颜色范围|同色区域|相同颜色区域|同色像素|色块).{0,24}(?:全图|整张(?:图|图片|画面)|所有|全部|每一处).{0,24}(?:改|换|替换|调整)/.test(text);
      const explicitWholeSubject = /(?:完整|整个|全身|整体|前景)?(?:主体|主要人物)|(?:抠出|抠图|提取).{0,12}(?:完整|整个|全身)?(?:人物|角色|商品|产品|主体)|(?:隐藏|去掉|移除)背景/.test(text);
      const backgroundTarget = /(?:背景|主体以外|人物以外|角色以外|前景以外)/.test(text);
      const cutoutRequest = /(?:抠出|抠图|提取主体|隐藏背景|去掉背景|移除背景|去背景)/.test(text);
      let grounded = false;
      if (explicitGlobalColorRange) grounded = hasColorRange || hasVisualObject;
      else if (cutoutRequest && explicitWholeSubject && targetClass.scope !== "subpart") grounded = hasSubject || hasVisualObject;
      else if (backgroundTarget) grounded = hasVisualObject || (hasSubject && hasInvertedSelection);
      else if (explicitWholeSubject && targetClass.scope !== "subpart") grounded = hasSubject || hasVisualObject;
      else grounded = hasVisualObject;
      if (!grounded) {
        if (hasColorRange) missing.push("具体对象必须使用对象定位，不能用全图颜色范围代替");
        else if (hasSubject) missing.push("指定实例或局部必须使用对象定位，不能用自动主体代替");
        else missing.push("目标对象定位步骤");
      }
    }
    if (/(复制|拷贝)/.test(text) && !actions.has("layer.duplicate")) missing.push("复制图层");
    if (/(?:重命名|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)/.test(text) && !actions.has("layer.rename")) missing.push("重命名图层");
    if (/(?:不透明度|透明度)/.test(text) && !hasAny("layer.set_opacity", "layer.set_fill_opacity", "adjustment.colorize")) missing.push("设置不透明度");
    const grayRequest = /(去色|黑白|(?:改成|改为|变成)灰色)/.test(text);
    const neutralToGrayRequest = /(黑色|白色|近黑|近白|中性色|胡子|黑胡子).*(?:改成|改为|变成|换成)灰色|(?:把|将).*(?:黑色|白色|近黑|近白|中性色|胡子|黑胡子).*(?:灰色)/.test(text);
    const userVisualContract = protocol && typeof protocol.buildUserVisualContract === "function"
      ? protocol.buildUserVisualContract(text)
      : null;
    const explicitAppearancePreservation = userVisualContract
      ? userVisualContract.preserveAppearance.length > 0
      : /(?:保留|保持|维持).{0,16}(?:高光|阴影|明暗|纹理|质感|立体|褶皱)|(?:高光|阴影|明暗|纹理|质感|立体|褶皱).{0,16}(?:保留|保持|不变)/.test(text);
    const texturedSemanticRecolor = explicitAppearancePreservation
      && /(改色|颜色.*(?:改成|改为|换成|变成)|(?:改成|改为|换成|变成)|上色)/.test(text)
      && !/(纯色覆盖|完全覆盖|扁平纯色)/.test(text)
      && !neutralToGrayRequest;
    const hasColorModification = hasAny("adjustment.colorize", "text.set_color", "group.set_text_style")
      || (grayRequest && hasAny("adjustment.hue_saturation", "adjustment.black_white"));
    if (/(改色|颜色.*(?:改成|改为|换成|变成)|(?:改成|改为|换成|变成)\s*(?:#[0-9a-fA-F]{6}|红色|蓝色|绿色|黄色|黑色|白色|灰色|紫色|橙色|粉色)|改(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?|上色)/.test(text)
      && !hasColorModification) missing.push("颜色修改");
    if (/自然饱和度/.test(adjustmentText)) {
      if (!actions.has("adjustment.vibrance")) missing.push("自然饱和度调整");
    } else if (/(饱和度|明度)/.test(adjustmentText) && !actions.has("adjustment.hue_saturation")) {
      missing.push("色相/饱和度/明度调整");
    }
    if (/(亮度|对比度)/.test(adjustmentText) && !actions.has("adjustment.brightness_contrast")) missing.push("亮度/对比度调整");
    if (/曝光度/.test(adjustmentText) && !actions.has("adjustment.exposure")) missing.push("曝光度调整");
    if (grayRequest
      && !hasAny("adjustment.hue_saturation", "adjustment.black_white", "adjustment.colorize")) missing.push("灰度或灰色处理");
    if (neutralToGrayRequest) {
      const replacement = operations.find((item) => item.action === "adjustment.colorize");
      if (!replacement) {
        missing.push("中性色到灰色的可见颜色替换（降低饱和度不会改变黑白像素）");
      } else if (String(replacement.params && replacement.params.blendMode || "normal").toLowerCase() !== "normal") {
        missing.push("中性色到灰色必须使用normal混合模式精确替换");
      }
    }
    if (texturedSemanticRecolor) {
      const replacement = operations.find((item) => item.action === "adjustment.colorize");
      const objectSelection = operations.find((item) => item.action === "selection.visual_object");
      if (replacement && String(replacement.params && replacement.params.blendMode || "normal").toLowerCase() !== "color") {
        missing.push("人物或材质改色必须保留原有明暗和花纹（使用color混合模式）");
      }
      if (objectSelection && objectSelection.params && objectSelection.params.allowColorFallback === true) {
        missing.push("人物或材质对象必须使用语义分割，不得退回颜色连通域");
      }
    }
    if (/(反相|反转).*蒙版|蒙版.*(?:反相|反转)/.test(text) && !actions.has("mask.invert")) missing.push("反相蒙版");
    if (/(删除|移除).*蒙版/.test(text) && !actions.has("mask.delete")) missing.push("删除蒙版");
    if (/(创建|建立|添加|生成).*蒙版|用.*选区.*蒙版/.test(text)
      && !hasAny("mask.create_from_selection", "mask.create_reveal_all", "mask.create_hide_all")) missing.push("创建蒙版");

    const structuredBackgroundLayerVisibility = /隐藏\s*背景(?:图层|层)|背景(?:图层|层).{0,12}隐藏/.test(text);
    const extractsSubject = !structuredBackgroundLayerVisibility
      && /(?:抠出|抠图|提取).*(?:人物|角色|主体|商品|对象)|(?:人物|角色|主体|商品|对象).*(?:抠出|抠图|提取)|隐藏背景|背景隐藏|去背景/.test(text);
    if (extractsSubject) {
      if (!hasAny("selection.subject", "selection.visual_object")) missing.push("主体或对象定位");
      if (!actions.has("mask.create_from_selection")) missing.push("用主体选区创建蒙版");
      if (!actions.has("layer.duplicate")) missing.push("复制到可回退的新图层");
      if (!actions.has("layer.set_visibility")) missing.push("隐藏原背景图层");
      const duplicate = operations.find((item) => item.action === "layer.duplicate");
      const mask = operations.find((item) => item.action === "mask.create_from_selection");
      const hideOriginal = operations.find((item) => item.action === "layer.set_visibility" && item.params && item.params.visible === false);
      if (duplicate && mask && !(mask.target && mask.target.scope === "operation_result" && mask.target.resultOf === duplicate.id)) {
        missing.push("把主体蒙版明确绑定到复制出的副本");
      }
      if (hideOriginal && hideOriginal.target && hideOriginal.target.scope === "operation_result") {
        missing.push("隐藏原图层而不是隐藏副本");
      }
    }

    const duplicate = operations.find((item) => item.action === "layer.duplicate");
    if (duplicate) {
      const requiresCopyRename = /(副本|复制层|拷贝层).*(重命名|命名为|名称改为|名字改为)|(?:重命名|命名为|名称改为|名字改为).*(副本|复制层|拷贝层)/.test(text);
      const requiresCopyOpacity = /(副本|复制层|拷贝层).{0,30}(?:不透明度|透明度)|(?:不透明度|透明度).{0,30}(副本|复制层|拷贝层)/.test(text);
      const rename = operations.find((item) => item.action === "layer.rename");
      const opacity = operations.find((item) => item.action === "layer.set_opacity");
      if (requiresCopyRename && rename && !(rename.target && rename.target.scope === "operation_result" && rename.target.resultOf === duplicate.id)) {
        missing.push("把重命名明确绑定到复制出的副本");
      }
      if (requiresCopyOpacity && opacity && !(opacity.target && opacity.target.scope === "operation_result" && opacity.target.resultOf === duplicate.id)) {
        missing.push("把不透明度明确绑定到复制出的副本");
      }
    }

    return {
      complete: missing.length === 0,
      missing,
      actions: [...actions]
    };
  }

  function auditPlanningCompleteness(instruction, intent, requirements) {
    const semanticAudit = auditIntentCoverage(instruction, intent);
    const requirementAudit = planner.auditRequirementCoverage(requirements, intent);
    const dependencyAudit = planner.validateDependencyGraph(intent);
    return {
      complete: semanticAudit.complete && requirementAudit.complete && dependencyAudit.valid,
      missing: [
        ...semanticAudit.missing,
        ...requirementAudit.missing,
        ...dependencyAudit.errors
      ],
      semanticAudit,
      requirementAudit,
      dependencyAudit
    };
  }

  function buildIntentPrompt() {
    return [
      "你是 Natural Edit Agent v0.9.8 的 Adobe Photoshop 意图解析器，只返回严格JSON。",
      "你负责把用户口语转成受限操作，不得猜测图层ID，不得生成BatchPlay或JavaScript。只有收到当前Photoshop画面时，才允许为selection.visual_object或selection.polygon给出基于画面的percent坐标。",
      "用户消息里包含由本地程序生成的requirementChecklist，它是本次任务不可删减的验收账本。",
      "返回：{summary,operations:[{id,action,target:{scope,query,resultOf},params,reason,requirementIds:[req_1]}],constraints:[],ambiguities:[]}。",
      "每个operation必须在requirementIds中引用它落实的需求编号；一个操作可落实多个需求，一个需求也可由多个操作共同落实。不得引用不存在的编号。",
      "requirementChecklist中的每一项都必须至少有一个类型相符的操作覆盖。任何一项做不到时写入ambiguities，绝不能静默省略或用无关动作冒充。",
      `action只能从以下列表选择：${capabilities.catalog().map((item) => item.id).join("、")}。`,
      "每项能力的严格参数契约如下（字段名必须完全一致）：",
      ...Object.entries(protocol.ACTION_CONTRACTS).map(([id, contract]) => `${id}: ${contract}`),
      "anchor只能是top_left、top_center、top_right、middle_left、middle_center、middle_right、bottom_left、bottom_center、bottom_right。",
      "target.scope只能是active_layer、active_layers、layer_path、layer_name、text_content、operation_result、document。新建、选区、调整图像/画布和导出使用document。",
      "用户说当前图层时用active_layer；明确说所有选中图层时用active_layers；给出完整图层路径时用layer_path；明确图层名时用layer_name；明确现有文字内容时用text_content。",
      "需要继续修改前一步新建或复制出的图层时，为前一步设置唯一id，后一步使用target:{scope:'operation_result',resultOf:'前一步id'}。",
      "不能可靠完成时不要编造操作，在ambiguities中说明。",
      "颜色必须转换为#RRGGBB；横排为horizontal，竖排为vertical。reference只能是selection或canvas。",
      "用户说组内全部文字或图层组内文字时，使用group.set_text_style；需要排入选区或画布时使用group.fit_text_to_reference。",
      "同名图层无法仅凭名称唯一定位时，在ambiguities中要求用户选中目标或提供完整路径，不得猜测。",
      "如果用户消息带图片：第1张始终是当前Photoshop合成画面；若有第2张，它是用户批注图。第1张图片的左上角是(0,0)，右下角是(100,100)，所有视觉坐标必须映射到这张画布的0到100百分比坐标。",
      "先判断目标类型：whole_subject表示整幅画面的完整主体；single_instance表示多个对象中的指定实例；subpart表示对象的局部部件；fine_edge表示透明、半透明或软边。完整主体优先selection.subject；指定实例或部件使用selection.visual_object先生成自动候选；精细边缘先给粗候选，并由界面提示进入Photoshop原生工具精修。",
      "系统必须先自动给出候选。用户无需事先手工套索；候选出现后，无论置信度高低都允许用点选、面板套索或Photoshop原生套索加选/减选，人工修正是最终权威。",
      "所有unit:'percent'的坐标必须使用0到100，例如画面79%的位置写79，绝不能写0.79。",
      "selection.visual_object使用语义分割，必须同时给出targetBox、searchRegion和seed。targetBox紧密包住用户指定的完整目标；searchRegion只提供消歧上下文并作为安全边界；seed必须落在目标内部。",
      "每个selection.visual_object必须给出visualContract：{version:'1',target:{label,scope,entity,part,positions,sourceColorFamilies},protectedRegions:[],preserveAppearance:[]}。target.label必须忠实复述用户指定的修改目标，不能添加画面中自行观察到的对象或部位。",
      "protectedRegions只列用户明确要求不要修改的空间对象或区域；不得根据画面自行猜测。preserveAppearance只列用户要求保留的外观属性。外观属性仍属于目标内部像素，不能转成excludePoints。",
      "目标修改前的颜色仅作为定位线索写入target.sourceColorFamilies；修改后的目标颜色只写在后续调整步骤。不得用目标色反推源颜色，也不得用单一颜色范围代替语义对象。",
      "完整对象必须设置semanticScope:'whole_object'和colorRefine:'none'；明确局部部件必须设置semanticScope:'subpart'。未能从用户原话判断时使用semanticScope:'unknown'，并在ambiguities中说明，不能自行缩小或扩大目标。",
      "excludePoints只能对应用户明确授权的protectedRegions，不能包含模型自行观察到的内部部件。没有空间保护要求时必须返回空数组。positivePoints只能落在用户目标的不同可见部分，不能落在背景或邻近对象。",
      "targetBox必须完整位于searchRegion内。完整对象的targetBox覆盖所有可见部分；局部目标的targetBox只覆盖指定部件。不得用同色像素集合冒充对象，也不得把批注矩形直接当成像素选区。",
      "selection.subject只用于完整主体。按位置、外观或名称指定单个实例/部件时使用selection.visual_object生成自动候选；候选随后可交给Photoshop原生对象选择、快速选择或套索纠正。不得用selection.subject_region裁剪全局主体选区来冒充对象定位。",
      "用户要求抠出主体并隐藏背景时，必须形成完整链：复制原图层；Photoshop主体识别；用选区给副本创建蒙版；隐藏原图层。后续步骤用operation_result绑定副本，原图层保持可回退。",
      "调整背景但保持主体不变时，使用selection.subject、selection.invert，再创建调整图层；不得直接调整整张画面。",
      "每条修改指令都必须同时包含目标定位和实际修改。绝不能只返回selection步骤后声称已经完成改色、去色、亮度、蒙版或抠图。",
      "复合指令必须逐项覆盖用户的每个要求。例如复制、重命名、局部定位、改色、不透明度五个要求必须有五类对应步骤，不能只执行其中一部分。",
      "批注框只用于辅助确定targetBox与searchRegion，绝不能直接把整个矩形框当成对象选区。指定实例或局部部件使用selection.visual_object；只有用户明确要求整幅画面的主要主体时才使用selection.subject。",
      "allowColorFallback默认必须为false。只有目标明确是无纹理纯色色块、污点或背景小块，并且漏掉内部结构不可能改变语义时，才允许设为true；人物、肢体、衣服、商品、奖杯、徽标和带纹理对象绝不能开启。",
      "把彩色对象去色或变为保持原明暗的灰度时，使用adjustment.hue_saturation且saturation=-100；把黑色、白色或近中性色明确替换成灰色或其他指定色时，必须使用adjustment.colorize且blendMode='normal'，因为降低黑色饱和度不会产生可见变化。",
      "人物身体、皮肤、衣服、商品或其他有阴影和花纹的对象改色时，默认必须保留原明暗与纹理，adjustment.colorize使用blendMode='color'。只有明确要求纯色覆盖、扁平色，或把黑白近中性色替换为指定颜色时才使用blendMode='normal'。",
      "只有几何边界明确、无需像素贴边的区域才使用selection.rectangle或selection.polygon。不得用矩形选区替代人物、奖杯、图标、衣服、污点等对象轮廓。",
      "不要仅因视觉目标confidence较低就写入ambiguities或拒绝计划。仍然返回最佳候选；confidence较低时由界面强制用户纠正或明确接受。只有完全无法产生任何候选、目标描述互相矛盾时才追问。confidence只是未校准的模型自评分，不得描述为正确率。",
      "只输出JSON，不要Markdown和解释。"
    ].join("\n");
  }

  function applyUserVisualContracts(intent, instruction) {
    if (!intent || !Array.isArray(intent.operations) || !protocol || typeof protocol.applyAuthoritativeVisualContract !== "function") {
      return intent;
    }
    for (const operation of intent.operations) {
      if (!operation || operation.action !== "selection.visual_object" || !operation.params) continue;
      protocol.applyAuthoritativeVisualContract(operation.params, instruction, { sanitizeModelExclusions: true });
    }
    return intent;
  }

  async function understand(instruction, snapshot, modelCaller, options) {
    const requirements = planner.buildRequirements(instruction);
    const fast = options && options.forceModel ? null : parseFastInstruction(instruction);
    if (fast) {
      const fastAudit = auditPlanningCompleteness(instruction, fast, requirements);
      if (fastAudit.complete) return { route: "fast", intent: applyUserVisualContracts(fast, instruction), requirements };
      const mismatch = new Error(`本地确定性规划与授权账本不一致：${fastAudit.missing.join("、")}。这是内部规则错误，本次不会改用模型重新猜测。`);
      mismatch.code = "DETERMINISTIC_AUDIT_MISMATCH";
      mismatch.audit = fastAudit;
      throw mismatch;
    }
    if (typeof modelCaller !== "function") throw new Error("该指令需要模型理解，但模型服务不可用。");
    const raw = await modelCaller({
      system: buildIntentPrompt(),
      user: JSON.stringify({
        instruction,
        requirementChecklist: planner.promptChecklist(requirements),
        photoshopState: stateEngine.compactForModel(snapshot),
        ...(options && options.previousPlan ? { previousPlan: options.previousPlan } : {}),
        ...(options && options.correction ? { correction: options.correction } : {})
      })
    });
    let intent;
    try {
      intent = planner.normalizeDependencies(protocol.normalizeIntent(raw));
    } catch (error) {
      if (!error || error.code !== "MODEL_JSON_INVALID") throw error;
      const invalid = new Error("模型返回的操作计划不是有效JSON。插件已经完成本地清理，但仍无法安全解析；为避免重复计费，本次没有再次请求模型，请手动重新分析。");
      invalid.code = "MODEL_JSON_INVALID";
      invalid.rawModelOutput = error.rawModelOutput || String(raw);
      invalid.cause = error;
      throw invalid;
    }
    const audit = auditPlanningCompleteness(instruction, intent, requirements);
    if (!audit.complete) {
      throw new Error(`模型计划不完整，缺少：${audit.missing.join("、")}。为避免隐藏的第二次模型请求和重复计费，本次没有进入执行，请手动重新分析。`);
    }
    return { route: "standard", intent: applyUserVisualContracts(intent, instruction), requirements };
  }

  function exactMatches(snapshot, predicate) {
    return snapshot.flatLayers.filter(predicate);
  }

  function resolveTargets(operation, snapshot) {
    const target = operation.target;
    let matches = [];
    if (target.scope === "active_layer") {
      if (snapshot.activeLayers.length !== 1) {
        throw new Error(snapshot.activeLayers.length
          ? `当前选中了${snapshot.activeLayers.length}个图层，无法确定“当前图层”是哪一个。`
          : "当前没有选中图层。");
      }
      matches = exactMatches(snapshot, (layer) => layer.id === snapshot.activeLayers[0].id);
    } else if (target.scope === "active_layers") {
      if (!snapshot.activeLayers.length) throw new Error("当前没有选中图层。");
      const ids = new Set(snapshot.activeLayers.map((layer) => Number(layer.id)));
      matches = exactMatches(snapshot, (layer) => ids.has(Number(layer.id)));
    } else if (target.scope === "layer_id") {
      matches = exactMatches(snapshot, (layer) => Number(layer.id) === Number(target.id));
    } else if (target.scope === "layer_path") {
      const query = String(target.query).trim().toLowerCase();
      matches = exactMatches(snapshot, (layer) => String(layer.path || "").trim().toLowerCase() === query);
    } else if (target.scope === "layer_name") {
      const query = String(target.query).trim().toLowerCase();
      matches = exactMatches(snapshot, (layer) => layer.name.trim().toLowerCase() === query);
    } else if (target.scope === "text_content") {
      const query = String(target.query).trim();
      matches = exactMatches(snapshot, (layer) => layer.text && layer.text.contents.trim() === query);
    } else if (target.scope === "document") {
      return [{
        id: null,
        name: snapshot.document.title,
        path: snapshot.document.title,
        kind: "document",
        document: snapshot.document,
        children: [],
        locks: {}
      }];
    } else if (target.scope === "operation_result") {
      return [{
        id: null,
        name: `步骤结果 ${target.resultOf}`,
        path: `步骤结果 ${target.resultOf}`,
        kind: "operation_result",
        resultOf: target.resultOf,
        children: [],
        locks: {}
      }];
    }
    if (!matches.length) throw new Error(`没有找到目标：${target.query || "当前图层"}。`);
    if (target.scope !== "active_layers" && matches.length > 1) {
      const paths = matches.slice(0, 5).map((item) => item.path).join("；");
      throw new Error(`找到${matches.length}个相同候选“${target.query}”：${paths}。请选中目标或使用完整图层路径。`);
    }
    return matches;
  }

  function stateEvidenceRequirements(plan) {
    const source = plan && Array.isArray(plan.steps)
      ? plan.steps
      : plan && Array.isArray(plan.operations) ? plan.operations : [];
    const actions = source.map((item) => String(item && item.action || ""));
    const globalPixelActions = new Set([
      "document.resize_image", "document.resize_canvas", "document.crop", "document.rotate",
      "document.trim", "document.reveal_all", "document.merge_visible", "document.flatten", "document.export"
    ]);
    const layerPixelActions = new Set([
      "layer.delete", "layer.rasterize", "layer.merge_down", "mask.create_from_selection",
      "mask.create_reveal_all", "mask.create_hide_all", "mask.invert", "mask.delete", "mask.apply"
    ]);
    const needsCompositeDigest = actions.some((id) => id.startsWith("filter.") || id.startsWith("adjustment.")
      || globalPixelActions.has(id) || layerPixelActions.has(id));
    const needsSelectionDigest = actions.some((id) => id.startsWith("selection.")) || source.some((item) => {
      const id = String(item && item.action || "");
      const params = item && item.params || {};
      return id.startsWith("adjustment.")
        || (id.startsWith("filter.") && params.useSelection === true)
        || id === "mask.create_from_selection"
        || (id === "document.crop" && String(params.reference || "selection") === "selection")
        || (/^(?:layer|text|group)\.(?:align|fit)/.test(id) && params.reference === "selection");
    });
    const needsLayerTree = source.some((item) => {
      const id = String(item && item.action || "");
      const target = item && item.target || {};
      return /^(?:layer|text|group|filter|mask)\./.test(id)
        || ["selection.load_layer", "document.reveal_all", "document.merge_visible", "document.flatten"].includes(id)
        || target.id != null || ["active_layer", "active_layers", "layer_id", "layer_name", "layer_path", "text_content", "operation_result"].includes(target.scope);
    });
    const needsActiveLayers = source.some((item) => {
      const scope = item && item.target && item.target.scope;
      return scope === "active_layer" || scope === "active_layers";
    });
    return { needsCompositeDigest, needsSelectionDigest, needsLayerTree, needsActiveLayers };
  }

  function resolveTarget(operation, snapshot) {
    const matches = resolveTargets(operation, snapshot);
    if (matches.length !== 1) throw new Error(`目标解析得到${matches.length}个图层，当前调用要求唯一目标。`);
    return matches[0];
  }

  function compilePlan(understanding, snapshot) {
    if (understanding.intent.ambiguities.length) throw new Error(`指令存在歧义：${understanding.intent.ambiguities.join("；")}`);
    const dependencyAudit = planner.validateDependencyGraph(understanding.intent);
    if (!dependencyAudit.valid) throw new Error(`操作依赖无效：${dependencyAudit.errors.join("；")}。`);
    if (Array.isArray(understanding.requirements) && understanding.requirements.length) {
      const requirementAudit = planner.auditRequirementCoverage(understanding.requirements, understanding.intent);
      if (!requirementAudit.complete) {
        throw new Error(`计划没有覆盖全部用户要求：${requirementAudit.missing.join("；")}。`);
      }
    }
    const exportIndexes = understanding.intent.operations
      .map((operation, index) => operation.action === "document.export" ? index : -1)
      .filter((index) => index >= 0);
    if (exportIndexes.length > 1) throw new Error("一次计划只能导出一个文件，请拆分多个导出任务。");
    if (exportIndexes.length === 1 && exportIndexes[0] !== understanding.intent.operations.length - 1) {
      throw new Error("导出必须是最后一步，避免文件已经写出后又发生可回滚的编辑失败。");
    }
    const steps = [];
    const operationIds = new Map();
    let plannedSelectionAvailable = Boolean(snapshot.selectionBounds);
    const selectionCreators = new Set([
      "selection.select_all", "selection.rectangle", "selection.ellipse", "selection.polygon",
      "selection.subject", "selection.subject_region", "selection.color_range", "selection.visual_object", "selection.load_layer"
    ]);
    for (let index = 0; index < understanding.intent.operations.length; index += 1) {
      const item = understanding.intent.operations[index];
      const operationId = item.id || `operation_${index + 1}`;
      if (operationIds.has(operationId)) throw new Error(`操作ID重复：${operationId}。`);
      const capability = capabilities.get(item.action);
      const targets = resolveTargets(item, snapshot);
      if (item.action === "layer.move_to_group" && item.params.groupResultOf) {
        const groupProducer = operationIds.get(item.params.groupResultOf);
        if (!groupProducer) throw new Error(`步骤${operationId}引用了尚未创建的目标图层组：${item.params.groupResultOf}。`);
        if (groupProducer.action !== "layer.create_group" || groupProducer.targetCount !== 1) {
          throw new Error(`步骤${item.params.groupResultOf}没有产生唯一图层组，不能作为移动目标。`);
        }
      }
      if (item.target.scope === "operation_result") {
        const producer = operationIds.get(item.target.resultOf);
        if (!producer) throw new Error(`步骤${operationId}引用了尚未执行或不存在的结果：${item.target.resultOf}。`);
        if (producer.targetCount !== 1) throw new Error(`步骤${item.target.resultOf}产生多个目标，不能作为唯一结果继续引用。`);
      }
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        const target = targets[targetIndex];
        if (target.kind !== "operation_result") {
          const planningState = plannedSelectionAvailable && !snapshot.selectionBounds
            ? {
                ...snapshot,
                selectionBounds: {
                  left: 0,
                  top: 0,
                  right: Number(snapshot.document.width),
                  bottom: Number(snapshot.document.height)
                }
              }
            : snapshot;
          capability.preflight(target, item.params, planningState);
        }
        steps.push({
          id: targets.length === 1 ? operationId : `${operationId}_${targetIndex + 1}`,
          operationId,
          index: steps.length,
          action: item.action,
          label: capability.label,
          risk: capability.risk || "low",
          reversible: capability.reversible !== false,
          requiresSeparateConfirmation: capability.risk === "high",
          params: item.params,
          target: {
            id: target.id,
            name: target.name,
            path: target.path,
            kind: target.kind,
            resultOf: target.resultOf || null,
            text: target.text ? target.text.contents : null
          },
          reason: item.reason,
          requirementIds: [...(item.requirementIds || [])]
        });
      }
      operationIds.set(operationId, { targetCount: targets.length, action: item.action });
      if (selectionCreators.has(item.action)) plannedSelectionAvailable = true;
      if (item.action === "selection.deselect") plannedSelectionAvailable = false;
    }
    if (steps.length > 32) throw new Error("展开多选目标后超过32个执行步骤，请拆分指令。");
    const evidenceRequirements = stateEvidenceRequirements({ steps });
    return {
      version: "9.8",
      route: understanding.route,
      summary: understanding.intent.summary,
      constraints: understanding.intent.constraints,
      sourceFingerprint: snapshot.fingerprint,
      sourceContentFingerprint: snapshot.contentFingerprint,
      sourceActiveLayerIds: (snapshot.activeLayers || []).map((layer) => Number(layer.id)),
      sourceHistoryStateId: Number(snapshot.document.historyStateId || 0),
      sourceHistoryStateName: String(snapshot.document.historyStateName || ""),
      sourceCompositeDigest: snapshot.document.compositeDigest || null,
      sourceSelectionDigest: snapshot.selectionDigest == null ? null : snapshot.selectionDigest,
      sourceSelectionBounds: snapshot.selectionBounds || null,
      sourceIntegrity: { ...(snapshot.integrity || {}) },
      sourceEvidenceRequirements: evidenceRequirements,
      sourceEvidenceFingerprint: typeof stateEngine.buildEvidenceFingerprint === "function"
        ? stateEngine.buildEvidenceFingerprint(snapshot, evidenceRequirements)
        : snapshot.fingerprint,
      sourceDocumentId: snapshot.document.id,
      createdAt: new Date().toISOString(),
      steps,
      highRiskStepIds: steps.filter((step) => step.risk === "high").map((step) => step.id),
      containsIrreversibleStep: steps.some((step) => step.reversible === false)
    };
  }

  function protectedSignature(layer) {
    const isContainer = Boolean((layer.children && layer.children.length) || String(layer.kind || "").toLowerCase().includes("group"));
    return JSON.stringify({
      parentId: layer.parentId,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      opacity: Math.round(layer.opacity * 100) / 100,
      fillOpacity: Math.round(layer.fillOpacity * 100) / 100,
      blendMode: layer.blendMode,
      locks: layer.locks,
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
        size: Math.round(layer.text.size * 100) / 100,
        color: layer.text.color,
        leading: layer.text.leading,
        tracking: layer.text.tracking,
        justification: layer.text.justification,
        fauxBold: layer.text.fauxBold,
        fauxItalic: layer.text.fauxItalic,
        horizontalScale: layer.text.horizontalScale,
        verticalScale: layer.text.verticalScale,
        baselineShift: layer.text.baselineShift,
        hyphenation: layer.text.hyphenation,
        firstLineIndent: layer.text.firstLineIndent,
        leftIndent: layer.text.leftIndent,
        rightIndent: layer.text.rightIndent,
        spaceBefore: layer.text.spaceBefore,
        spaceAfter: layer.text.spaceAfter
      } : null
      ,bounds: isContainer ? null : (layer.boundsNoEffects || layer.bounds)
    });
  }

  function verifyProtectedLayers(beforeState, afterState, allowedIds) {
    const afterById = new Map(afterState.flatLayers.map((layer) => [layer.id, layer]));
    const beforeIds = new Set(beforeState.flatLayers.map((layer) => Number(layer.id)));
    for (const layer of beforeState.flatLayers) {
      if (allowedIds.has(layer.id)) continue;
      const after = afterById.get(layer.id);
      if (!after) throw new Error(`非目标图层“${layer.name}”意外消失。`);
      if (protectedSignature(layer) !== protectedSignature(after)) {
        throw new Error(`检测到非目标图层“${layer.path}”发生未授权变化。`);
      }
    }
    for (const layer of afterState.flatLayers) {
      const id = Number(layer.id);
      if (!beforeIds.has(id) && !allowedIds.has(id)) {
        throw new Error(`检测到未由当前能力声明的新图层“${layer.path}”。`);
      }
    }
  }

  function compareProtectedEvidence(beforeEvidence, afterEvidence, allowedIds) {
    const before = beforeEvidence && beforeEvidence.evidence || {};
    const after = afterEvidence && afterEvidence.evidence || {};
    const unverified = [];
    for (const [id, expected] of Object.entries(before)) {
      if (allowedIds.has(Number(id))) continue;
      const actual = after[id];
      if (!actual) throw new Error(`目标外图层 ${id} 在最终像素验收时不存在。`);
      const expectedUserMaskDigest = expected.userMaskDigest == null ? expected.maskDigest : expected.userMaskDigest;
      const actualUserMaskDigest = actual.userMaskDigest == null ? actual.maskDigest : actual.userMaskDigest;
      if (expected.pixelDigest == null || expectedUserMaskDigest == null
        || actual.pixelDigest == null || actualUserMaskDigest == null) {
        unverified.push(Number(id));
        continue;
      }
      if (expected.pixelDigest !== actual.pixelDigest) {
        throw new Error(`检测到目标外图层 ${id} 的像素摘要发生变化。`);
      }
      if (expectedUserMaskDigest !== actualUserMaskDigest) {
        throw new Error(`检测到目标外图层 ${id} 的用户蒙版摘要发生变化。`);
      }
      if (expected.vectorMaskCoverage !== "absent" || actual.vectorMaskCoverage !== "absent") unverified.push(Number(id));
    }
    return {
      level: unverified.length || !beforeEvidence.complete || !afterEvidence.complete ? "partial" : "pixel_and_mask_digest",
      unverifiedLayerIds: unverified,
      sampledLayerCount: Object.keys(before).length,
      evidenceScope: "non_target_pixels_and_user_masks",
      vectorMasks: "not_sampled"
    };
  }

  function addResultLayerIds(allowedIds, result, afterState) {
    if (!result) return;
    if (result.resultLayerId != null) {
      allowedIds.add(Number(result.resultLayerId));
      if (result.resultScope === "subtree" && afterState) {
        for (const id of capabilities.subtreeIds(afterState, result.resultLayerId)) allowedIds.add(Number(id));
      }
    }
    for (const key of ["affectedLayerIds", "deletedLayerIds"]) {
      for (const id of result[key] || []) allowedIds.add(Number(id));
    }
  }

  function extensionForFormat(format) {
    return format === "jpeg" ? "jpg" : format;
  }

  async function prepareResources(plan) {
    const resources = new Map();
    const exportSteps = plan.steps.filter((step) => step.action === "document.export");
    if (!exportSteps.length) return resources;
    const { storage } = require("uxp");
    for (const step of exportSteps) {
      const extension = extensionForFormat(step.params.format);
      const safeTitle = String(app.activeDocument.title || "photoshop-export").replace(/\.[^.]+$/, "").replace(/[\\/:*?\"<>|]/g, "_");
      const file = await storage.localFileSystem.getFileForSaving(`${safeTitle}.${extension}`, { types: [extension] });
      if (!file) throw new Error("已取消选择导出位置，本次没有修改文档。");
      resources.set(step.id, { file });
    }
    return resources;
  }

  function rebasePlanAfterSelection(plan, beforeState, afterState, authority) {
    if (!plan || !beforeState || !afterState) throw new Error("缺少选区会话基线，不能更新执行计划。");
    if (!beforeState.hasDocument || !afterState.hasDocument
      || Number(beforeState.document.id) !== Number(afterState.document.id)
      || Number(plan.sourceDocumentId) !== Number(afterState.document.id)) {
      throw new Error("选区修正期间活动文档发生了变化，请重新分析。");
    }
    if (!beforeState.contentFingerprint || !afterState.contentFingerprint
      || beforeState.contentFingerprint !== afterState.contentFingerprint) {
      throw new Error("选区修正期间图像或图层内容发生了变化；为避免覆盖用户修改，请重新分析。");
    }
    const beforeActiveLayerIds = (beforeState.activeLayers || []).map((layer) => Number(layer.id));
    const afterActiveLayerIds = (afterState.activeLayers || []).map((layer) => Number(layer.id));
    if (beforeActiveLayerIds.length !== afterActiveLayerIds.length
      || beforeActiveLayerIds.some((id, index) => id !== afterActiveLayerIds[index])) {
      throw new Error("选区修正期间活动图层发生了变化，请重新分析。");
    }
    if (!plan.sourceContentFingerprint || plan.sourceContentFingerprint !== afterState.contentFingerprint) {
      throw new Error("选区重新锁定时文档内容已偏离计划的不可变基线，请重新分析。");
    }
    if (!Array.isArray(plan.sourceActiveLayerIds)
      || plan.sourceActiveLayerIds.length !== afterActiveLayerIds.length
      || plan.sourceActiveLayerIds.some((id, index) => Number(id) !== afterActiveLayerIds[index])) {
      throw new Error("选区重新锁定时活动图层已偏离计划的不可变基线，请重新分析。");
    }
    if (!afterState.selectionBounds || !afterState.selectionDigest || afterState.selectionDigest === "none") {
      throw new Error("Photoshop当前没有可采用的选区。");
    }
    if (authority && authority.selectionDigest && authority.selectionDigest !== afterState.selectionDigest) {
      throw new Error("权威选区摘要与Photoshop当前选区不一致，请重新采用当前选区。");
    }
    return {
      ...plan,
      sourceFingerprint: afterState.fingerprint,
      sourceContentFingerprint: afterState.contentFingerprint,
      sourceActiveLayerIds: afterActiveLayerIds,
      sourceHistoryStateId: Number(afterState.document.historyStateId || 0),
      sourceHistoryStateName: String(afterState.document.historyStateName || ""),
      sourceCompositeDigest: afterState.document.compositeDigest || null,
      sourceIntegrity: { ...(afterState.integrity || {}) },
      selectionAuthority: {
        kind: "photoshop_current_selection",
        selectionDigest: afterState.selectionDigest,
        bounds: afterState.selectionBounds,
        sessionId: authority && authority.sessionId || null,
        lockedAt: new Date().toISOString()
      }
    };
  }

  function baselineDiagnostics(plan, current) {
    const authority = plan && plan.selectionAuthority || {};
    const document = current && current.document || {};
    return {
      expected: {
        fingerprint: plan && plan.sourceFingerprint || null,
        contentFingerprint: plan && plan.sourceContentFingerprint || null,
        historyStateId: plan && plan.sourceHistoryStateId != null ? Number(plan.sourceHistoryStateId) : null,
        historyStateName: plan && plan.sourceHistoryStateName != null ? String(plan.sourceHistoryStateName) : null,
        compositeDigest: plan && plan.sourceCompositeDigest || null,
        integrity: plan && plan.sourceIntegrity || null,
        selectionDigest: authority.selectionDigest || null,
        selectionBounds: authority.bounds || null,
        activeLayerIds: Array.isArray(plan && plan.sourceActiveLayerIds) ? plan.sourceActiveLayerIds.map(Number) : []
      },
      current: {
        fingerprint: current && current.fingerprint || null,
        contentFingerprint: current && current.contentFingerprint || null,
        historyStateId: document.historyStateId != null ? Number(document.historyStateId) : null,
        historyStateName: document.historyStateName != null ? String(document.historyStateName) : null,
        compositeDigest: document.compositeDigest || null,
        integrity: current && current.integrity || null,
        selectionDigest: current && current.selectionDigest || null,
        selectionBounds: current && current.selectionBounds || null,
        activeLayerIds: (current && current.activeLayers || []).map((layer) => Number(layer.id))
      }
    };
  }

  function baselineMismatchError(plan, current, message) {
    const mismatch = new Error(message || "规划后PSD状态已经变化，请重新分析后再执行。");
    mismatch.code = "EXECUTION_BASELINE_MISMATCH";
    mismatch.baselineDiagnostics = baselineDiagnostics(plan, current);
    return mismatch;
  }

  function assertSafeSelectionRestoreBaseline(plan, current) {
    if (current && current.hasDocument && Number(current.document.id) === Number(plan.sourceDocumentId)
      && current.fingerprint === plan.sourceFingerprint) return true;
    throw baselineMismatchError(
      plan,
      current,
      "恢复已确认选区前PSD状态已变化，本次没有覆盖当前选区；请重新分析。"
    );
  }

  const COMPLETE_GATE_SNAPSHOT_ATTEMPTS = 4;
  const COMPLETE_GATE_SNAPSHOT_DELAY_MS = 35;

  function hasCompleteGateEvidence(state, requirements) {
    if (typeof stateEngine.isCompleteIntegritySnapshot === "function") {
      return stateEngine.isCompleteIntegritySnapshot(state, requirements);
    }
    // Compatibility for isolated host/test shims; the real v9.8 state engine
    // owns this contract.
    const integrity = state && state.integrity || {};
    const needed = requirements && typeof requirements === "object" ? requirements : {
      needsCompositeDigest: true, needsSelectionDigest: true, needsLayerTree: true, needsActiveLayers: true
    };
    if (!state || !state.hasDocument || !state.fingerprint || !state.contentFingerprint
      || !state.document || !Number.isFinite(Number(state.document.historyStateId))
      || Number(state.document.historyStateId) <= 0) return false;
    if (needed.needsActiveLayers && !Array.isArray(state.activeLayers)) return false;
    if (needed.needsLayerTree && !Array.isArray(state.flatLayers)) return false;
    if (integrity.consistentRead === false) return false;
    if (needed.needsCompositeDigest && (integrity.compositeDigestAvailable !== true || !state.document.compositeDigest)) return false;
    if (!needed.needsSelectionDigest) return true;
    if (integrity.selectionDigestAvailable !== true) return false;
    return state.selectionBounds ? state.selectionDigest != null && state.selectionDigest !== "none" : state.selectionDigest === "none";
  }

  function waitForCompleteGateSnapshot() {
    return new Promise((resolve) => {
      if (typeof setTimeout === "function") setTimeout(resolve, COMPLETE_GATE_SNAPSHOT_DELAY_MS);
      else resolve();
    });
  }

  function stateEvidenceDiagnostics(stage, latest) {
    return {
      stage: stage || "unknown_gate",
      hasDocument: Boolean(latest && latest.hasDocument),
      documentId: latest && latest.document ? Number(latest.document.id) : null,
      fingerprintAvailable: Boolean(latest && latest.fingerprint),
      contentFingerprintAvailable: Boolean(latest && latest.contentFingerprint),
      historyStateId: latest && latest.document ? latest.document.historyStateId : null,
      historyStateName: latest && latest.document ? latest.document.historyStateName || null : null,
      compositeDigest: latest && latest.document && latest.document.compositeDigest || null,
      activeLayerIds: Array.isArray(latest && latest.activeLayers)
        ? latest.activeLayers.map((layer) => Number(layer.id))
        : null,
      selectionBounds: latest && latest.selectionBounds || null,
      selectionDigest: latest && latest.selectionDigest || null,
      integrity: latest && latest.integrity || null
    };
  }

  function incompleteStateEvidenceError(stage, latest) {
    const error = new Error("Photoshop 状态完整性摘要连续读取失败；本次已在修改文档前停止，请稍后重试。");
    error.code = "INCOMPLETE_STATE_EVIDENCE";
    error.stateEvidence = stateEvidenceDiagnostics(stage, latest);
    return error;
  }

  async function readCompleteGateSnapshot(stage, requirements) {
    let latest = null;
    for (let attempt = 0; attempt < COMPLETE_GATE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      latest = await stateEngine.snapshot();
      if (hasCompleteGateEvidence(latest, requirements)) return latest;
      if (attempt + 1 < COMPLETE_GATE_SNAPSHOT_ATTEMPTS) await waitForCompleteGateSnapshot();
    }
    throw incompleteStateEvidenceError(stage, latest);
  }

  function planBaselineMatches(plan, state, requirements) {
    if (!plan || !state || !state.hasDocument || Number(state.document.id) !== Number(plan.sourceDocumentId)) return false;
    if (plan.sourceEvidenceFingerprint && typeof stateEngine.buildEvidenceFingerprint === "function") {
      return stateEngine.buildEvidenceFingerprint(state, requirements) === plan.sourceEvidenceFingerprint;
    }
    return state.fingerprint === plan.sourceFingerprint;
  }

  function lightweightGateDiagnostics(stage, expected, current) {
    const compact = (value) => ({
      complete: Boolean(value && value.complete),
      documentId: value && value.document ? Number(value.document.id) : null,
      width: value && value.document ? Number(value.document.width) : null,
      height: value && value.document ? Number(value.document.height) : null,
      resolution: value && value.document ? Number(value.document.resolution) : null,
      historyStateId: value && value.document ? value.document.historyStateId : null,
      historyStateName: value && value.document ? value.document.historyStateName || null : null,
      activeLayerIds: Array.isArray(value && value.activeLayers)
        ? value.activeLayers.map((layer) => Number(layer.id))
        : null,
      selectionBounds: value && value.selectionBounds || null,
      fingerprint: value && value.fingerprint || null
    });
    return { stage, expected: compact(expected), current: compact(current) };
  }

  async function assertModalLightweightGate(expected, stage, requirements) {
    if (typeof stateEngine.captureLightweightGateSnapshot === "function"
      && typeof stateEngine.lightweightGateMatches === "function") {
      const gate = await stateEngine.captureLightweightGateSnapshot();
      if (stateEngine.lightweightGateMatches(expected, gate, requirements)) return gate;
      const error = new Error("取得 Photoshop 写入锁后，文档的结构、历史记录、活动图层或选区范围已变化；已在修改前停止。");
      error.code = "MODAL_LIGHTWEIGHT_GATE_MISMATCH";
      error.lightweightGateDiagnostics = lightweightGateDiagnostics(stage, expected, gate);
      throw error;
    }
    // Compatibility only for isolated test/legacy shims. Production v9.8
    // supplies the lightweight gate and never requests imaging digests here.
    const gate = await readCompleteGateSnapshot(`${stage}:compatibility_full_snapshot`, requirements);
    const expectedFingerprint = typeof stateEngine.buildEvidenceFingerprint === "function"
      ? stateEngine.buildEvidenceFingerprint(expected, requirements)
      : expected.fingerprint;
    const actualFingerprint = typeof stateEngine.buildEvidenceFingerprint === "function"
      ? stateEngine.buildEvidenceFingerprint(gate, requirements)
      : gate.fingerprint;
    if (gate.hasDocument && Number(gate.document.id) === Number(expected.document.id)
      && actualFingerprint === expectedFingerprint) return gate;
    throw baselineMismatchError(null, gate, "取得 Photoshop 写入锁后文档状态已变化；已在修改前停止。");
  }

  async function executeExportSteps(exportSteps, resources, startState, records) {
    let stepState = startState;
    for (const step of exportSteps) {
      const capability = capabilities.get(step.action);
      const gateState = await stateEngine.snapshot();
      if (!gateState.hasDocument || Number(gateState.document.id) !== Number(stepState.document.id)
        || gateState.fingerprint !== stepState.fingerprint) {
        throw new Error("导出前文档状态已经变化；为避免导出未验收的版本，已停止写文件。");
      }
      const liveTargetState = { ...step.target, document: stepState.document, children: [], locks: {} };
      capability.preflight(liveTargetState, step.params, stepState);
      let result;
      await core.executeAsModal(async () => {
        const modalGateState = await stateEngine.snapshot();
        if (!modalGateState.hasDocument || Number(modalGateState.document.id) !== Number(stepState.document.id)
          || modalGateState.fingerprint !== stepState.fingerprint) {
          throw new Error("导出取得 Photoshop 锁后发现文档状态已变化，已停止写文件。");
        }
        result = await capability.execute({
          target: liveTargetState,
          params: { ...step.params },
          beforeState: stepState,
          resource: resources.get(step.id)
        });
      }, { commandName: `Natural Edit Agent v0.9.8：${step.label}`, timeOut: 5 });
      const afterState = await stateEngine.snapshot();
      const verification = await capability.verify({
        beforeState: stepState,
        afterState,
        target: liveTargetState,
        params: step.params,
        result: result || {}
      });
      records.push({
        step: step.id,
        operationId: step.operationId || step.id,
        action: step.action,
        target: step.target,
        params: step.params,
        result,
        verification,
        phase: "post_commit_export"
      });
      stepState = afterState;
    }
    return stepState;
  }

  function selectionBoundsMatch(left, right) {
    if (!left || !right) return left === right;
    return ["left", "top", "right", "bottom"].every((key) => Number(left[key]) === Number(right[key]));
  }

  function rollbackStateMatches(baseline, restored, requirements) {
    if (!baseline || !restored || !baseline.hasDocument || !restored.hasDocument) return false;
    if (Number(baseline.document.id) !== Number(restored.document.id)) return false;
    const needed = requirements || {
      needsCompositeDigest: true,
      needsSelectionDigest: true,
      needsLayerTree: true,
      needsActiveLayers: true
    };
    const baselineContent = baseline.contentFingerprint || baseline.fingerprint;
    const restoredContent = restored.contentFingerprint || restored.fingerprint;
    if (!baselineContent || baselineContent !== restoredContent) return false;
    if (needed.needsSelectionDigest) {
      if (baseline.selectionDigest == null || restored.selectionDigest == null) return false;
      if (baseline.selectionDigest !== restored.selectionDigest
        || !selectionBoundsMatch(baseline.selectionBounds || null, restored.selectionBounds || null)) return false;
    }
    const baselineActive = (baseline.activeLayers || []).map((layer) => Number(layer.id));
    const restoredActive = (restored.activeLayers || []).map((layer) => Number(layer.id));
    return !needed.needsActiveLayers || JSON.stringify(baselineActive) === JSON.stringify(restoredActive);
  }

  function rollbackEvidenceFor(state) {
    return {
      level: state && state.integrity && state.integrity.compositeDigestAvailable
        ? "sampled_composite_digest"
        : "structure_only",
      exactPixelProof: false
    };
  }

  async function handlePostCommitFailure(error, baseline, undoPoint, records, requirements) {
    const original = error instanceof Error ? error : new Error(String(error));
    let rollbackError = null;
    let restored = null;
    let undoCompleted = false;
    if (undoPoint && undoPoint.afterHistoryStateId != null) {
      try {
        await undo(undoPoint);
        undoCompleted = true;
        restored = await stateEngine.snapshot();
      } catch (candidate) {
        rollbackError = candidate;
      }
    } else {
      rollbackError = new Error("提交后没有取得可安全使用的历史状态撤销点。");
    }
    if (!rollbackError && rollbackStateMatches(baseline, restored, requirements)) {
      original.rollbackVerified = true;
      original.rollbackVerification = rollbackEvidenceFor(baseline);
      original.documentChangesCommitted = false;
      original.records = records;
      return original;
    }
    const combined = new Error(`${String(original.message || original)}；文档修改已经提交，且自动回滚${undoCompleted ? "后的状态无法充分验证" : `失败：${String(rollbackError && rollbackError.message || rollbackError)}`}。请立即检查 Photoshop 历史记录面板。`);
    combined.originalError = original;
    combined.rollbackError = rollbackError;
    combined.rollbackVerified = false;
    combined.documentStateUncertain = true;
    combined.documentChangesCommitted = true;
    combined.undoPoint = undoCompleted ? null : undoPoint;
    combined.records = records;
    return combined;
  }

  function usesTemporarySelection(plan) {
    const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    if (!steps.length || steps.every((step) => String(step.action || "").startsWith("selection."))) return false;
    const createsSelection = steps.some((step) => [
      "selection.select_all", "selection.rectangle", "selection.ellipse", "selection.polygon",
      "selection.subject", "selection.subject_region", "selection.color_range",
      "selection.visual_object", "selection.load_layer"
    ].includes(step.action));
    const consumesSelection = steps.some((step) => String(step.action || "").startsWith("adjustment.")
      || (String(step.action || "").startsWith("filter.") && step.params && step.params.useSelection === true)
      || step.action === "mask.create_from_selection");
    return createsSelection && consumesSelection;
  }

  function temporarySelectionRestoreBaseline(plan) {
    if (!usesTemporarySelection(plan)) return null;
    const hasDeclaredBaseline = plan
      && typeof plan.restoreSelectionHadSelection === "boolean"
      && Object.prototype.hasOwnProperty.call(plan, "restoreSelectionSessionToken");
    if (!hasDeclaredBaseline) {
      const error = new Error("局部修改缺少规划前用户选区恢复凭据；为避免把分析候选当成原选区，本次已在修改前停止。");
      error.code = "SELECTION_RESTORE_BASELINE_REQUIRED";
      throw error;
    }
    const expectedDocumentId = Number(plan.restoreSelectionDocumentId == null
      ? plan.sourceDocumentId
      : plan.restoreSelectionDocumentId);
    if (!Number.isFinite(expectedDocumentId) || expectedDocumentId !== Number(plan.sourceDocumentId)) {
      throw new Error("规划前用户选区恢复凭据属于其他文档，请重新分析。");
    }
    if (!plan.restoreSelectionHadSelection) {
      if (plan.restoreSelectionSessionToken) {
        throw new Error("规划前选区恢复凭据自相矛盾：声明无选区但同时提供了选区令牌。");
      }
      return {
        hadSelection: false,
        token: null,
        documentId: expectedDocumentId,
        selectionDigest: "none",
        selectionBounds: null,
        ownsToken: false
      };
    }
    const token = String(plan.restoreSelectionSessionToken || "");
    if (!token || !selectionSessions || typeof selectionSessions.describe !== "function"
      || typeof selectionSessions.restore !== "function") {
      throw new Error("规划前用户选区恢复令牌不可用，请重新分析。");
    }
    const session = selectionSessions.describe(token);
    if (!session || Number(session.documentID) !== expectedDocumentId) {
      throw new Error("规划前用户选区恢复令牌已失效或属于其他文档，请重新分析。");
    }
    return {
      hadSelection: true,
      token,
      documentId: expectedDocumentId,
      selectionDigest: null,
      selectionBounds: session.selectionBounds || null,
      ownsToken: false
    };
  }

  async function restoreTemporarySelectionBaseline(baseline, documentId) {
    if (!baseline) return null;
    try {
      if (baseline.hadSelection) {
        await selectionSessions.restore(baseline.token);
      } else {
        await app.activeDocument.selection.deselect();
      }
      const restored = await stateEngine.snapshot();
      const sameDocument = restored && restored.hasDocument && Number(restored.document.id) === Number(documentId);
      const sameDigest = baseline.selectionDigest == null
        || (restored && restored.selectionDigest === baseline.selectionDigest);
      const sameBounds = JSON.stringify(restored && restored.selectionBounds || null) === JSON.stringify(baseline.selectionBounds || null);
      if (!sameDocument || !sameDigest || !sameBounds) {
        throw new Error("局部修图后无法证明用户原选区已完整恢复。");
      }
      return restored;
    } finally {
      if (baseline.ownsToken && baseline.token && selectionSessions && typeof selectionSessions.release === "function") {
        selectionSessions.release(baseline.token);
      }
    }
  }

  async function execute(plan, options = {}) {
    let current;
    let resources;
    let selectionRestoreBaseline = null;
    const evidenceRequirements = plan && plan.sourceEvidenceRequirements || stateEvidenceRequirements(plan);
    try {
      current = options.executionBaseline || options.trustedStartState || null;
      if (current && !hasCompleteGateEvidence(current, evidenceRequirements)) {
        throw incompleteStateEvidenceError("trusted_execution_baseline", current);
      }
      if (!current) current = await readCompleteGateSnapshot("initial_preflight", evidenceRequirements);
      if (!current.hasDocument || current.document.id !== plan.sourceDocumentId) throw new Error("当前文档不是生成计划时的文档，请重新分析。");
      if (!planBaselineMatches(plan, current, evidenceRequirements)) {
        throw baselineMismatchError(plan, current);
      }
      selectionRestoreBaseline = temporarySelectionRestoreBaseline(plan);

      // Recompute risk from the immutable capability registry at execution time.
      // Plan fields are display metadata and must not be able to downgrade a
      // destructive capability by replacing `highRiskStepIds` or `step.risk`.
      const highRiskIds = new Set([
        ...(plan.highRiskStepIds || []),
        ...plan.steps.filter((step) => step.risk === "high").map((step) => step.id),
        ...plan.steps.filter((step) => capabilities.get(step.action).risk === "high").map((step) => step.id)
      ]);
      const confirmedHighRiskIds = new Set(plan.confirmedHighRiskStepIds || []);
      const unconfirmedHighRisk = [...highRiskIds].filter((id) => !confirmedHighRiskIds.has(id));
      if (unconfirmedHighRisk.length) {
        const error = new Error(`高风险步骤尚未单独确认：${unconfirmedHighRisk.join("、")}。`);
        error.code = "HIGH_RISK_CONFIRMATION_REQUIRED";
        throw error;
      }

      resources = await prepareResources(plan);
      const hasExportResources = plan.steps.some((step) => step.action === "document.export");
      const afterResourceSelection = hasExportResources
        ? await core.executeAsModal(
          async () => readCompleteGateSnapshot("after_export_resource_selection", evidenceRequirements),
          { commandName: "v9.8 导出位置确认后回读文档", timeOut: 8 }
        )
        : current;
      if (!planBaselineMatches(plan, afterResourceSelection, evidenceRequirements)) {
        throw baselineMismatchError(plan, afterResourceSelection, "选择导出位置期间 PSD 状态已经变化，请重新分析后再执行。");
      }
      current = afterResourceSelection;
    } catch (error) {
      error.executionPhase = "preflight";
      error.documentChangesCommitted = false;
      error.documentStateUncertain = false;
      throw error;
    }
    const editSteps = plan.steps.filter((step) => step.action !== "document.export");
    const exportSteps = plan.steps.filter((step) => step.action === "document.export");
    const records = [];
    const operationResults = new Map();
    const transactionAllowedIds = new Set();
    const documentWideEdit = editSteps.some((step) => capabilities.get(step.action).documentWide);
    const canCaptureLayerEvidence = typeof stateEngine.captureLayerEvidence === "function";
    const beforeLayerEvidence = documentWideEdit || !editSteps.length || !canCaptureLayerEvidence
      ? null
      : await stateEngine.captureLayerEvidence(current, current.flatLayers.map((layer) => layer.id), { maxLayers: 64 });
    let undoPoint = null;
    let committedState = current;
    let historyCommitted = false;

    if (editSteps.length) {
      try {
        await core.executeAsModal(async (executionContext) => {
          const doc = app.activeDocument;
          await assertModalLightweightGate(current, "modal_write_lock", evidenceRequirements);
          const beforeHistory = doc.activeHistoryState;
          if (!beforeHistory || beforeHistory.id == null) throw new Error("无法读取执行前历史状态。");
          undoPoint = {
            documentId: doc.id,
            beforeHistoryStateId: beforeHistory.id,
            afterHistoryStateId: null,
            beforeActiveLayerIds: current.activeLayers.map((layer) => layer.id)
          };
          const suspension = await executionContext.hostControl.suspendHistory({ documentID: doc.id, name: "Natural Edit Agent v0.9.8" });
          let temporarySelectionBaseline = selectionRestoreBaseline;
          let commitAttempted = false;
          try {
            let stepState = current;
            for (let index = 0; index < editSteps.length; index += 1) {
              if (executionContext.isCancelled) throw new Error("用户取消了本次操作。");
              const step = editSteps[index];
              executionContext.reportProgress({ value: index / editSteps.length, commandName: step.label });
              const capability = capabilities.get(step.action);
              let runtimeTarget = step.target;
              if (step.target.kind === "operation_result") {
                const produced = operationResults.get(step.target.resultOf) || [];
                if (produced.length !== 1) throw new Error(`步骤“${step.target.resultOf}”没有产生唯一图层，无法执行${step.label}。`);
                const resolved = capabilities.stateLayer(stepState, produced[0]);
                if (!resolved) throw new Error(`上一步产生的图层${produced[0]}已经不存在。`);
                runtimeTarget = {
                  id: resolved.id,
                  name: resolved.name,
                  path: resolved.path,
                  kind: resolved.kind,
                  text: resolved.text ? resolved.text.contents : null
                };
              }
              const liveTargetState = runtimeTarget.kind === "document"
                ? { ...step.target, document: stepState.document, children: [], locks: {} }
                : capabilities.stateLayer(stepState, runtimeTarget.id);
              if (!liveTargetState) throw new Error(`执行第${index + 1}步前，目标图层已经不存在。`);
              const runtimeParams = { ...step.params };
              if (runtimeParams.groupResultOf) {
                const producedGroups = operationResults.get(runtimeParams.groupResultOf) || [];
                if (producedGroups.length !== 1) {
                  throw new Error(`步骤“${runtimeParams.groupResultOf}”没有产生唯一图层组，无法执行${step.label}。`);
                }
                runtimeParams.groupId = Number(producedGroups[0]);
              }
              capability.preflight(liveTargetState, runtimeParams, stepState);
              let result;
              try {
                result = await capability.execute({
                  target: liveTargetState,
                  params: runtimeParams,
                  beforeState: stepState,
                  resource: resources.get(step.id)
                });
              } catch (error) {
                throw new Error(`第${index + 1}步“${step.label}”执行失败：${String((error && error.message) || error)}`);
              }
              const afterState = await stateEngine.snapshot();
              const authorizedIds = runtimeTarget.id == null || capability.authorizedScope === "none"
                ? []
                : capability.authorizedScope === "subtree"
                  ? capabilities.subtreeIds(stepState, runtimeTarget.id)
                  : [Number(runtimeTarget.id)];
              const allowedIds = new Set(authorizedIds);
              addResultLayerIds(allowedIds, result, afterState);
              for (const id of allowedIds) transactionAllowedIds.add(Number(id));
              if (!(capability.documentWide || (result && result.documentWide))) {
                verifyProtectedLayers(stepState, afterState, allowedIds);
              }
              const verification = await capability.verify({ beforeState: stepState, afterState, target: liveTargetState, params: runtimeParams, result: result || {} });
              const producedIds = [];
              if (result && result.resultLayerId != null) producedIds.push(Number(result.resultLayerId));
              if (producedIds.length) operationResults.set(step.operationId || step.id, producedIds);
              records.push({ step: step.id, operationId: step.operationId || step.id, action: step.action, target: runtimeTarget, params: runtimeParams, result, verification, phase: "document_edit" });
              stepState = afterState;
            }
            if (temporarySelectionBaseline) {
              stepState = await restoreTemporarySelectionBaseline(temporarySelectionBaseline, doc.id);
              temporarySelectionBaseline = null;
            }
            executionContext.reportProgress({ value: 1, commandName: "正在完成回读验收" });
            suspension.finalName = `v9.8 · ${plan.summary.slice(0, 45)}`;
            commitAttempted = true;
            try {
              await executionContext.hostControl.resumeHistory(suspension, true);
            } catch (commitError) {
              // A rejected host promise does not prove Photoshop rejected the
              // commit. If the history state advanced, route through the same
              // verified undo path used by other post-commit failures.
              const observedHistory = doc.activeHistoryState;
              if (observedHistory && observedHistory.id != null
                && Number(observedHistory.id) !== Number(beforeHistory.id)) {
                undoPoint.afterHistoryStateId = observedHistory.id;
                historyCommitted = true;
              }
              throw commitError;
            }
            historyCommitted = true;
            const afterHistory = doc.activeHistoryState;
            undoPoint.afterHistoryStateId = afterHistory && afterHistory.id != null ? afterHistory.id : null;
          } catch (error) {
            if (temporarySelectionBaseline && temporarySelectionBaseline.ownsToken && temporarySelectionBaseline.token
              && selectionSessions && typeof selectionSessions.release === "function") {
              selectionSessions.release(temporarySelectionBaseline.token);
            }
            if (historyCommitted) throw error;
            try {
              await executionContext.hostControl.resumeHistory(suspension, false);
            } catch (rollbackError) {
              const prefix = commitAttempted ? "提交结果不明确" : "执行中止";
              const combined = new Error(`${String(error.message || error)}；${prefix}且自动回滚失败：${String(rollbackError.message || rollbackError)}`);
              combined.originalError = error;
              combined.rollbackError = rollbackError;
              combined.rollbackVerified = false;
              throw combined;
            }
            throw error;
          }
        }, { commandName: "Natural Edit Agent v0.9.8 正在执行", timeOut: 5 });
        committedState = await stateEngine.snapshot();
      } catch (error) {
        if (historyCommitted) throw await handlePostCommitFailure(error, current, undoPoint, records, evidenceRequirements);
        let restored = null;
        try { restored = await stateEngine.snapshot(); } catch (_) {}
        if (!rollbackStateMatches(current, restored, evidenceRequirements)) {
          const combined = new Error(`${String(error.message || error)}；自动回滚后无法证明文档和选区已恢复，请立即使用Photoshop历史记录面板检查执行前状态。`);
          combined.originalError = error;
          combined.rollbackVerified = false;
          combined.documentStateUncertain = true;
          combined.documentChangesCommitted = false;
          throw combined;
        }
        error.rollbackVerified = true;
        error.documentChangesCommitted = false;
        error.rollbackVerification = rollbackEvidenceFor(current);
        throw error;
      }
    }

    let protectedEvidence = { level: documentWideEdit ? "document_wide_not_applicable" : "not_sampled", unverifiedLayerIds: [] };
    if (beforeLayerEvidence) {
      try {
        const afterLayerEvidence = await stateEngine.captureLayerEvidence(
          committedState,
          Object.keys(beforeLayerEvidence.evidence).map(Number),
          { maxLayers: 64 }
        );
        protectedEvidence = compareProtectedEvidence(beforeLayerEvidence, afterLayerEvidence, transactionAllowedIds);
      } catch (error) {
        throw await handlePostCommitFailure(error, current, undoPoint, records, evidenceRequirements);
      }
    }

    let finalState = committedState;
    if (exportSteps.length) {
      try {
        finalState = await executeExportSteps(exportSteps, resources, committedState, records);
      } catch (error) {
        error.code = error.code || "POST_COMMIT_EXPORT_FAILED";
        error.documentChangesCommitted = editSteps.length > 0;
        error.undoPoint = undoPoint;
        error.records = records;
        error.message = editSteps.length
          ? `文档修改已经提交，但导出失败：${String(error.message || error)}。可使用本次撤销点恢复文档；已写出的外部文件不会随Photoshop历史记录自动删除。`
          : `导出失败：${String(error.message || error)}`;
        throw error;
      }
    }
    return {
      records,
      undoPoint,
      finalState,
      protectedEvidence,
      verificationLevel: protectedEvidence.level,
      exportPhase: exportSteps.length ? "post_commit" : "none"
    };
  }

  async function undo(undoPoint) {
    if (!undoPoint) throw new Error("没有可撤销的v9.8操作。");
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (doc.id !== undoPoint.documentId) throw new Error("当前文档不是刚才执行操作的文档。");
      const current = doc.activeHistoryState;
      if (!current || current.id !== undoPoint.afterHistoryStateId) throw new Error("v9.8操作后又发生了其他修改。为保护后续工作，请使用Photoshop历史记录面板撤销。");
      const target = Array.from(doc.historyStates || []).find((item) => item.id === undoPoint.beforeHistoryStateId);
      if (!target) throw new Error("执行前历史状态已经被Photoshop清理。");
      try {
        doc.activeHistoryState = target;
      } catch (_) {
        const results = await action.batchPlay([{
          _obj: "select",
          _target: [{ _ref: "historyState", _id: Number(undoPoint.beforeHistoryStateId) }],
          _options: { dialogOptions: "dontDisplay" }
        }], {});
        assertBatchPlayResults(results, "恢复执行前历史状态");
      }
      if (!doc.activeHistoryState || doc.activeHistoryState.id !== undoPoint.beforeHistoryStateId) throw new Error("Photoshop没有恢复到执行前状态。");
      await selectLayers(undoPoint.beforeActiveLayerIds);
    }, { commandName: "撤销 Natural Edit Agent v0.9.8 操作", timeOut: 5 });
  }

  async function selfTest(options) {
    const reportSelfTestProgress = options && typeof options.onProgress === "function"
      ? options.onProgress
      : () => {};
    let testDocument = null;
    let adjustmentFixtureId = null;
    let targetLayerId = null;
    let groupId = null;
    let deleteLayerId = null;
    let filterLayerId = null;
    let rasterizeLayerId = null;
    const originalDocumentId = app.documents.length ? Number(app.activeDocument.id) : null;
    const allChecks = [];
    const testedCapabilityIds = new Set();
    const excludedCapabilityIds = new Map([
      ["document.export", "requires a user-selected filesystem destination and file verification"],
      ["selection.subject", "depends on representative photographic content"],
      ["selection.subject_region", "depends on representative photographic content and a bounded subject"],
      ["selection.visual_object", "depends on a real document plus the segmentation service"]
    ]);

    async function runPhase(label, rawSteps, targetRef, targetKind) {
      reportSelfTestProgress({ label, status: "running", completed: allChecks.length });
      try {
        const before = await stateEngine.snapshot();
        const target = targetKind === "document"
          ? { id: null, name: before.document.title, path: before.document.title, kind: "document" }
          : typeof targetRef === "string"
            ? (() => {
                const matches = before.flatLayers.filter((layer) => layer.name === targetRef);
                if (matches.length !== 1) throw new Error(`自检目标“${targetRef}”匹配到${matches.length}个图层。`);
                return matches[0];
              })()
            : before.flatLayers.find((layer) => Number(layer.id) === Number(targetRef));
        if (!target) throw new Error("找不到目标");
        const steps = rawSteps.map(([capabilityId, params], index) => ({
          id: `${label}_${index + 1}`,
          action: capabilityId,
          label: capabilities.get(capabilityId).label,
          risk: capabilities.get(capabilityId).risk || "low",
          reversible: capabilities.get(capabilityId).reversible !== false,
          target: { id: target.id, name: target.name, path: target.path, kind: target.kind },
          params
        }));
        rawSteps.forEach(([capabilityId]) => testedCapabilityIds.add(capabilityId));
        const outcome = await execute({
          id: `selftest_${label}_${Date.now()}`,
          version: "9.8",
          route: "selftest",
          summary: `v9.8自检：${label}`,
          constraints: [],
          sourceDocumentId: before.document.id,
          sourceFingerprint: before.fingerprint,
          highRiskStepIds: steps.filter((step) => step.risk === "high").map((step) => step.id),
          confirmedHighRiskStepIds: steps.filter((step) => step.risk === "high").map((step) => step.id),
          steps
        });
        if (outcome.records.length !== steps.length) throw new Error("没有执行完全部步骤");
        allChecks.push(...outcome.records.map((record) => record.verification));
        await undo(outcome.undoPoint);
        const reverted = await stateEngine.snapshot();
        if ((reverted.contentFingerprint || reverted.fingerprint) !== (before.contentFingerprint || before.fingerprint)) throw new Error("撤销后文档摘要与执行前不一致");
        reportSelfTestProgress({ label, status: "passed", completed: allChecks.length });
      } catch (error) {
        throw new Error(`自检阶段“${label}”失败：${String(error.message || error)}`);
      }
    }

    async function prepareLocalAdjustmentFixture() {
      if (!adjustmentFixtureId) throw new Error("局部调整自检夹具不存在。");
      await core.executeAsModal(async () => {
        await selectLayers([adjustmentFixtureId]);
        try { await app.activeDocument.selection.deselect(); } catch (_) {}
        await app.activeDocument.selection.selectRectangle(
          { left: 90, top: 70, right: 300, bottom: 230 },
          constants.SelectionType.REPLACE,
          0,
          true
        );
      }, { commandName: "重建局部调整自检选区", timeOut: 5 });
      const fixtureState = await stateEngine.snapshot();
      if (!fixtureState.selectionBounds) throw new Error("局部调整自检选区没有建立成功。");
    }

    async function runTransparentTrimFixturePhase() {
      const returnDocumentId = Number(app.activeDocument.id);
      let trimDocument = null;
      try {
        await core.executeAsModal(async () => {
          trimDocument = await app.createDocument({
            width: 240,
            height: 180,
            resolution: 72,
            mode: "RGBColorMode",
            fill: "transparent",
            name: "V9.8 Transparent Trim Fixture"
          });
          await selectDocument(trimDocument.id);
          const finiteContent = await trimDocument.createTextLayer({ name: "TRIM", contents: "TRIM" });
          finiteContent.textItem.characterStyle.size = 48;
          await finiteContent.translate(70, 80);
        }, { commandName: "创建透明边缘裁切自检文档", timeOut: 5 });

        await runPhase("透明边缘裁切", [
          ["document.resize_canvas", { width: 420, height: 340, anchor: "middle_center" }],
          ["document.trim", { type: "transparent", top: true, left: true, bottom: true, right: true }]
        ], null, "document");
      } finally {
        if (trimDocument) {
          await core.executeAsModal(async () => {
            const stillOpen = Array.from(app.documents || [])
              .some((document) => Number(document.id) === Number(trimDocument.id));
            if (stillOpen) {
              await selectDocument(trimDocument.id);
              await trimDocument.closeWithoutSaving();
            }
          }, { commandName: "关闭透明边缘裁切自检文档", timeOut: 5 });
        }
        const returnDocumentStillOpen = Array.from(app.documents || [])
          .some((document) => Number(document.id) === returnDocumentId);
        if (returnDocumentStillOpen) {
          await core.executeAsModal(async () => selectDocument(returnDocumentId), {
            commandName: "恢复v9.8主自检文档",
            timeOut: 5
          });
        }
      }
    }

    async function runInstructionPhase(label, instruction, expectedActions) {
      reportSelfTestProgress({ label, status: "running", completed: allChecks.length });
      try {
        const before = await stateEngine.snapshot();
        const intent = parseFastInstruction(instruction);
        if (!intent) throw new Error("没有进入确定性复合指令编译器");
        const actualActions = intent.operations.map((item) => item.action);
        if (JSON.stringify(actualActions) !== JSON.stringify(expectedActions)) {
          throw new Error(`操作链不符合预期：${actualActions.join(" -> ")}`);
        }
        actualActions.forEach((capabilityId) => testedCapabilityIds.add(capabilityId));
        const plan = compilePlan({ route: "fast", intent }, before);
        const outcome = await execute(plan);
        if (outcome.records.length !== expectedActions.length) throw new Error("没有执行完复合操作链");
        allChecks.push(...outcome.records.map((record) => record.verification));
        await undo(outcome.undoPoint);
        const reverted = await stateEngine.snapshot();
        if ((reverted.contentFingerprint || reverted.fingerprint) !== (before.contentFingerprint || before.fingerprint)) throw new Error("复合操作撤销后文档摘要与执行前不一致");
        reportSelfTestProgress({ label, status: "passed", completed: allChecks.length });
      } catch (error) {
        throw new Error(`复合自检阶段“${label}”失败：${String(error.message || error)}`);
      }
    }

    try {
      await core.executeAsModal(async () => {
        testDocument = await app.createDocument({
          width: 480,
          height: 320,
          resolution: 300,
          mode: "RGBColorMode",
          fill: "transparent",
          name: "V9.8 Runtime Self Test"
        });
        await selectDocument(testDocument.id);
        const fixtureResults = await action.batchPlay([{
          _obj: "make",
          _target: [{ _ref: "contentLayer" }],
          using: {
            _obj: "contentLayer",
            name: "V9.8 Adjustment Fixture",
            type: {
              _obj: "solidColorLayer",
              color: { _obj: "RGBColor", red: 82, grain: 142, blue: 196 }
            }
          },
          _options: { dialogOptions: "dontDisplay" }
        }], { immediateRedraw: true });
        assertBatchPlayResults(fixtureResults, "创建v9.8调整层自检底图");
        adjustmentFixtureId = Number(
          (fixtureResults[0] && (fixtureResults[0].layerID || fixtureResults[0].ID))
          || (app.activeDocument.activeLayers[0] && app.activeDocument.activeLayers[0].id)
        );
        if (!Number.isFinite(adjustmentFixtureId)) throw new Error("无法读取v9.8调整层自检底图ID。");
        const targetLayer = await testDocument.createTextLayer({ name: "V9.8 中文目标", contents: "中文原文" });
        targetLayer.name = "V9.8 中文目标";
        targetLayerId = Number(targetLayer.id);
        const protectedLayer = await testDocument.createTextLayer({ name: "V9.8 保护层", contents: "不得变化" });
        protectedLayer.name = "V9.8 保护层";
        const filterLayer = await testDocument.createTextLayer({ name: "V9.8 滤镜目标", contents: "FILTER" });
        filterLayer.name = "V9.8 滤镜目标";
        await filterLayer.rasterize(constants.RasterizeType.ENTIRELAYER);
        filterLayerId = Number(filterLayer.id);
        const rasterizeLayer = await testDocument.createTextLayer({ name: "V9.8 栅格化目标", contents: "RASTER" });
        rasterizeLayer.name = "V9.8 栅格化目标";
        rasterizeLayerId = Number(rasterizeLayer.id);
        const group = await testDocument.createLayerGroup({ name: "V9.8 文字组" });
        groupId = Number(group.id);
        const groupTextA = await testDocument.createTextLayer({ name: "组内文字A", contents: "出品方" });
        const groupTextB = await testDocument.createTextLayer({ name: "组内文字B", contents: "播出平台" });
        groupTextA.name = "组内文字A";
        groupTextB.name = "组内文字B";
        await groupTextA.move(group, constants.ElementPlacement.PLACEINSIDE);
        await groupTextB.move(group, constants.ElementPlacement.PLACEINSIDE);
        const deleteLayer = await testDocument.createPixelLayer();
        deleteLayerId = Number(deleteLayer.id);
      }, { commandName: "创建v9.8自检文档", timeOut: 5 });

      await core.executeAsModal(async () => selectDocument(testDocument.id), { commandName: "激活v9.8自检文档", timeOut: 5 });
      const initial = await stateEngine.snapshot();
      const requiredLayerNames = [
        "V9.8 中文目标",
        "V9.8 保护层",
        "V9.8 滤镜目标",
        "V9.8 栅格化目标",
        "V9.8 文字组",
        "组内文字A",
        "组内文字B"
      ];
      for (const layerName of requiredLayerNames) {
        const matches = initial.flatLayers.filter((layer) => layer.name === layerName);
        if (matches.length !== 1) {
          const actualNames = initial.flatLayers.map((layer) => `${layer.id}:${layer.name}`).join(" | ");
          throw new Error(`自检夹具“${layerName}”应当唯一存在，实际匹配到 ${matches.length} 个。当前图层：${actualNames}`);
        }
      }
      const target = initial.flatLayers.find((layer) => Number(layer.id) === targetLayerId);
      if (!target || !target.text || target.text.contents !== "中文原文") {
        const layerSummary = initial.flatLayers.map((layer) => `${layer.id}:${layer.name}:${layer.kind}:${layer.text ? layer.text.contents : "非文字"}`).join(" | ");
        throw new Error(`中文文字层创建或复读失败。测试文档=${testDocument.id}，当前快照文档=${initial.document && initial.document.id}，目标图层=${targetLayerId}，图层=${layerSummary}`);
      }

      if (!initial.flatLayers.some((layer) => Number(layer.id) === deleteLayerId)) {
        throw new Error(`没有找到待删除像素层 ${deleteLayerId}。`);
      }

      await core.executeAsModal(async () => {
        await selectLayers([deleteLayerId]);
      }, { commandName: "准备新建组并移入图层自检", timeOut: 5 });
      await runInstructionPhase(
        "新建组并移入选中图层",
        "建立一个组叫做测试组，然后把选中的图层放到测试组中",
        ["layer.create_group", "layer.move_to_group"]
      );

      await runPhase(
        "图层移入指定组",
        [["layer.move_to_group", { groupName: "V9.8 文字组", groupId }]],
        deleteLayerId,
        "layer"
      );

      await core.executeAsModal(async () => {
        await selectLayers([filterLayerId]);
        try { await app.activeDocument.selection.deselect(); } catch (_) {}
      }, { commandName: "准备复制链自检", timeOut: 5 });
      await runInstructionPhase(
        "复制并连续修改结果",
        "复制当前图层，然后把副本重命名为‘运行时副本’，向右移动18像素，向下移动9像素，不透明度改为64%",
        ["layer.duplicate", "layer.rename", "layer.set_opacity", "layer.move_by"]
      );

      await core.executeAsModal(async () => {
        await selectLayers([filterLayerId]);
        await app.activeDocument.selection.selectRectangle(
          { left: 80, top: 50, right: 400, bottom: 270 },
          constants.SelectionType.REPLACE,
          0,
          true
        );
      }, { commandName: "准备选区适配链自检", timeOut: 5 });
      await runInstructionPhase(
        "选区适配并继续修改属性",
        "把当前图层等比缩放放入选区，四周留12像素，然后把不透明度改为82%，混合模式改为正片叠底",
        ["layer.fit_to_reference", "layer.set_opacity", "layer.set_blend_mode"]
      );

      await core.executeAsModal(async () => {
        try { await app.activeDocument.selection.deselect(); } catch (_) {}
      }, { commandName: "准备连续选区自检", timeOut: 5 });
      await runInstructionPhase(
        "连续建立和修改选区",
        "建立一个左60、上50、右360、下260像素的矩形选区，然后收缩8像素，再羽化2像素",
        ["selection.rectangle", "selection.contract", "selection.feather"]
      );

      await runPhase("图层删除", [["layer.delete", {}]], deleteLayerId, "layer");

      await runPhase("文字属性", [
        ["text.set_content", { content: "中文验收通过" }],
        ["text.set_color", { color: "#E53935" }],
        ["text.set_size", { size: 42 }],
        ["text.set_leading", { leading: 48 }],
        ["text.set_tracking", { tracking: 80 }],
        ["text.set_justification", { justification: "center" }],
        ["text.set_faux_bold", { enabled: true }],
        ["text.set_faux_italic", { enabled: true }],
        ["text.set_horizontal_scale", { scale: 92 }],
        ["text.set_vertical_scale", { scale: 108 }],
        ["text.set_baseline_shift", { baselineShift: 3 }],
        ["text.set_hyphenation", { enabled: false }],
        ["text.set_paragraph_spacing", { firstLineIndent: 6, leftIndent: 4, rightIndent: 4, spaceBefore: 2, spaceAfter: 3 }],
        ["text.set_orientation", { orientation: "vertical" }]
      ], "V9.8 中文目标", "layer");

      await runPhase("文字点值幂等回归", [
        ["text.set_leading", { leading: 48 }],
        ["text.set_leading", { leading: 48 }],
        ["text.set_baseline_shift", { baselineShift: 3 }],
        ["text.set_baseline_shift", { baselineShift: 3 }],
        ["text.set_paragraph_spacing", { firstLineIndent: 6, leftIndent: 4, rightIndent: 4, spaceBefore: 2, spaceAfter: 3 }],
        ["text.set_paragraph_spacing", { firstLineIndent: 6, leftIndent: 4, rightIndent: 4, spaceBefore: 2, spaceAfter: 3 }]
      ], "V9.8 中文目标", "layer");

      await runPhase("文字空间", [
        ["text.set_font", { font: target.text.font }],
        ["layer.align_to_reference", { reference: "canvas", padding: 8, horizontal: "center", vertical: "middle", allowUpscale: false }],
        ["layer.fit_to_reference", { reference: "canvas", padding: 8, horizontal: "center", vertical: "middle", allowUpscale: false }],
        ["text.fit_to_reference", { reference: "canvas", padding: 8, horizontal: "center", vertical: "middle", allowUpscale: false }]
      ], "V9.8 中文目标", "layer");

      await core.executeAsModal(async () => {
        await app.activeDocument.selection.selectRectangle(
          { left: 120, top: 70, right: 360, bottom: 250 },
          constants.SelectionType.REPLACE,
          0,
          true
        );
      }, { commandName: "建立选区适配自检夹具", timeOut: 5 });
      await runPhase("选区内等比适配", [
        ["layer.fit_to_reference", { reference: "selection", padding: 20, horizontal: "center", vertical: "middle", allowUpscale: true }]
      ], filterLayerId, "layer");
      await core.executeAsModal(async () => app.activeDocument.selection.deselect(), { commandName: "清理选区适配自检夹具", timeOut: 5 });

      await core.executeAsModal(async () => {
        await app.activeDocument.selection.selectRectangle(
          { left: 30, top: 30, right: 210, bottom: 150 },
          constants.SelectionType.REPLACE,
          0,
          true
        );
      }, { commandName: "建立带选区变换回归夹具", timeOut: 5 });
      await runPhase("图层属性（保留活动选区）", [
        ["layer.rename", { name: "V9.8 中文目标已验收" }],
        ["layer.set_visibility", { visible: false }],
        ["layer.set_visibility", { visible: true }],
        ["layer.set_opacity", { opacity: 73 }],
        ["layer.set_fill_opacity", { fillOpacity: 61 }],
        ["layer.set_blend_mode", { blendMode: "multiply" }],
        ["layer.move_by", { deltaX: 12, deltaY: 7 }],
        ["layer.scale", { scaleX: 90, scaleY: 90 }],
        ["layer.rotate", { angle: 5, anchor: "middle_center" }],
        ["layer.flip", { axis: "horizontal" }],
        ["layer.skew", { angleH: 3, angleV: 0 }],
        ["layer.reorder", { position: "front" }],
        ["layer.set_lock", { lock: "all", locked: true }],
        ["layer.set_lock", { lock: "all", locked: false }],
        ["layer.duplicate", {}]
      ], filterLayerId, "layer");
      await core.executeAsModal(async () => app.activeDocument.selection.deselect(), { commandName: "清理带选区变换回归夹具", timeOut: 5 });

      await runPhase("图层新建", [
        ["layer.create_pixel", { name: "自检像素层" }],
        ["layer.create_group", { name: "自检新建组" }],
        ["text.create", { name: "自检新文字", content: "新建验收", size: 24, color: "#1565C0" }]
      ], null, "document");

      await runPhase("图层栅格化", [["layer.rasterize", { target: "entire_layer" }]], "V9.8 栅格化目标", "layer");

      await runPhase("转换智能对象", [
        ["layer.convert_to_smart_object", {}]
      ], "V9.8 栅格化目标", "layer");

      await runPhase("剪贴蒙版状态", [
        ["layer.set_clipping_mask", { enabled: true }],
        ["layer.set_clipping_mask", { enabled: false }]
      ], "V9.8 滤镜目标", "layer");

      await runPhase("向下合并图层", [
        ["layer.merge_down", {}]
      ], "V9.8 滤镜目标", "layer");

      await runPhase("原生滤镜", [
        ["filter.gaussian_blur", { radius: 0.5 }],
        ["filter.motion_blur", { angle: 0, distance: 2 }],
        ["filter.add_noise", { amount: 1, distribution: "uniform", monochromatic: true }],
        ["filter.high_pass", { radius: 0.5 }],
        ["filter.unsharp_mask", { amount: 50, radius: 0.5, threshold: 0 }],
        ["filter.sharpen", {}]
      ], "V9.8 滤镜目标", "layer");

      await runPhase("选区基础", [
        ["selection.rectangle", { unit: "pixels", left: 40, top: 40, right: 180, bottom: 160, feather: 0, antiAlias: true }],
        ["selection.expand", { by: 2, applyAtCanvasBounds: false }],
        ["selection.contract", { by: 1, applyAtCanvasBounds: false }],
        ["selection.feather", { by: 1, applyAtCanvasBounds: false }],
        ["selection.invert", {}],
        ["selection.border", { width: 2 }],
        ["selection.smooth", { radius: 1, applyAtCanvasBounds: false }],
        ["selection.deselect", {}],
        ["selection.ellipse", { unit: "pixels", left: 80, top: 60, right: 220, bottom: 200, feather: 0, antiAlias: true }],
        ["selection.deselect", {}],
        ["selection.polygon", { unit: "pixels", points: [{ x: 50, y: 40 }, { x: 250, y: 55 }, { x: 210, y: 210 }, { x: 70, y: 180 }], feather: 0, antiAlias: true }],
        ["selection.deselect", {}],
        ["selection.select_all", {}],
        ["selection.deselect", {}]
      ], null, "document");

      await runPhase("按确定颜色建立选区", [
        ["selection.color_range", { color: "#528EC4", tolerance: 8, softness: 0 }],
        ["selection.deselect", {}]
      ], null, "document");

      await core.executeAsModal(async () => {
        await selectLayers([filterLayerId]);
        await app.activeDocument.selection.selectRectangle(
          { left: 100, top: 80, right: 320, bottom: 240 },
          constants.SelectionType.REPLACE,
          0,
          true
        );
      }, { commandName: "建立蒙版自检选区", timeOut: 5 });
      await runPhase("选区蒙版生命周期", [
        ["mask.create_from_selection", {}],
        ["mask.set_density", { density: 67 }],
        ["mask.set_feather", { feather: 2.5 }],
        ["mask.invert", {}],
        ["mask.delete", {}]
      ], filterLayerId, "layer");
      await runPhase("应用选区蒙版", [
        ["mask.create_from_selection", {}],
        ["mask.apply", {}]
      ], filterLayerId, "layer");
      await runPhase("全图蒙版模式", [
        ["mask.create_reveal_all", {}],
        ["mask.delete", {}],
        ["mask.create_hide_all", {}],
        ["mask.delete", {}]
      ], filterLayerId, "layer");
      await core.executeAsModal(async () => {
        try { await app.activeDocument.selection.deselect(); } catch (_) {}
      }, { commandName: "清理蒙版自检选区", timeOut: 5 });

      const localAdjustmentChecks = [
        ["局部色相调整", "adjustment.hue_saturation", { hue: 12, saturation: 18, lightness: -3, name: "自检局部色相" }],
        ["局部颜色化", "adjustment.colorize", { color: "#E53935", opacity: 70, blendMode: "normal", name: "自检局部改色" }],
        ["局部亮度对比度", "adjustment.brightness_contrast", { brightness: 12, contrast: 8, name: "自检亮度对比度" }],
        ["局部色阶", "adjustment.levels", { inputBlack: 8, gamma: 1.08, inputWhite: 244, outputBlack: 0, outputWhite: 255, name: "自检色阶" }],
        ["局部曲线", "adjustment.curves", { points: [{ input: 0, output: 0 }, { input: 96, output: 104 }, { input: 255, output: 255 }], name: "自检曲线" }],
        ["局部自然饱和度", "adjustment.vibrance", { vibrance: 15, saturation: 5, name: "自检自然饱和度" }],
        ["局部曝光度", "adjustment.exposure", { exposure: 0.2, offset: 0, gammaCorrection: 1, name: "自检曝光度" }],
        ["局部黑白", "adjustment.black_white", { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, name: "自检黑白" }]
      ];
      for (const [label, capabilityId, params] of localAdjustmentChecks) {
        await prepareLocalAdjustmentFixture();
        await runPhase(label, [[capabilityId, params]], null, "document");
      }
      await core.executeAsModal(async () => {
        try { await app.activeDocument.selection.deselect(); } catch (_) {}
      }, { commandName: "清理局部调整自检选区", timeOut: 5 });

      const filterFixture = initial.flatLayers.find((layer) => Number(layer.id) === filterLayerId);
      const filterBounds = filterFixture && filterFixture.bounds;
      if (!filterBounds) throw new Error("按颜色扩展自检缺少栅格图层边界。");
      await core.executeAsModal(async () => {
        await selectLayers([filterLayerId]);
        const width = Math.max(4, filterBounds.right - filterBounds.left);
        const height = Math.max(4, filterBounds.bottom - filterBounds.top);
        await app.activeDocument.selection.selectRectangle({
          left: filterBounds.left + width * 0.2,
          top: filterBounds.top + height * 0.2,
          right: filterBounds.left + width * 0.8,
          bottom: filterBounds.top + height * 0.8
        }, constants.SelectionType.REPLACE, 0, true);
      }, { commandName: "建立按颜色扩展自检夹具", timeOut: 5 });
      await runPhase("按颜色扩展", [["selection.grow", { tolerance: 32, antiAlias: true }]], null, "document");
      await core.executeAsModal(async () => app.activeDocument.selection.deselect(), { commandName: "清理按颜色扩展自检夹具", timeOut: 5 });

      await runPhase("载入图层选区", [["selection.load_layer", {}]], "V9.8 滤镜目标", "layer");

      await runPhase("文字组", [
        ["group.set_text_style", { size: 22, color: "#1565C0", tracking: 20 }],
        ["group.fit_text_to_reference", { reference: "canvas", padding: 24, horizontal: "center", vertical: "middle", allowUpscale: false, arrangement: "compact", orientation: "vertical" }]
      ], "V9.8 文字组", "layer");

      await runPhase("文档尺寸", [
        ["document.resize_image", { width: 360, height: 240, resolution: 72, constrainProportions: true }],
        ["document.resize_canvas", { width: 400, height: 280, anchor: "middle_center" }],
        ["document.rotate", { angle: 90 }]
      ], null, "document");

      await runPhase("竖版图像缩放", [
        ["document.rotate", { angle: 90 }],
        ["document.resize_image", { width: 160, height: 240, resolution: 72, constrainProportions: true }]
      ], null, "document");

      await runTransparentTrimFixturePhase();

      await runPhase("文档裁剪", [
        ["selection.rectangle", { unit: "pixels", left: 20, top: 20, right: 420, bottom: 280, feather: 0, antiAlias: true }],
        ["document.crop", { reference: "selection" }]
      ], null, "document");

      await core.executeAsModal(async () => {
        await selectLayers([targetLayerId]);
        const liveTarget = app.activeDocument.activeLayers[0];
        await liveTarget.translate(-520, 0);
      }, { commandName: "建立显示全部自检夹具", timeOut: 5 });
      await runPhase("显示画布外内容", [["document.reveal_all", {}]], null, "document");

      await runPhase("合并可见图层", [["document.merge_visible", {}]], null, "document");
      await runPhase("拼合图像", [["document.flatten", {}]], null, "document");

      const declaredCapabilityIds = new Set(capabilities.catalog().map((item) => item.id));
      const uncoveredCapabilityIds = Array.from(declaredCapabilityIds)
        .filter((id) => !testedCapabilityIds.has(id) && !excludedCapabilityIds.has(id));
      const staleExcludedCapabilityIds = Array.from(excludedCapabilityIds.keys())
        .filter((id) => !declaredCapabilityIds.has(id));
      if (uncoveredCapabilityIds.length || staleExcludedCapabilityIds.length) {
        const details = [
          uncoveredCapabilityIds.length ? `untested=${uncoveredCapabilityIds.join(",")}` : "",
          staleExcludedCapabilityIds.length ? `staleExclusions=${staleExcludedCapabilityIds.join(",")}` : ""
        ].filter(Boolean).join("; ");
        throw new Error(`v9.8 capability coverage is incomplete: ${details}`);
      }

      return {
        ok: true,
        checks: allChecks,
        capabilityCount: testedCapabilityIds.size,
        excluded: Array.from(excludedCapabilityIds.entries()).map(([id, reason]) => `${id} (${reason})`),
        rollback: "每个阶段均比较了结构、合成画面与可用的像素/蒙版摘要；无法取得摘要时会明确降级",
        originalDocumentId
      };
    } finally {
      if (testDocument) {
        try {
          await core.executeAsModal(async () => {
            await selectDocument(testDocument.id);
            await testDocument.closeWithoutSaving();
          }, { commandName: "关闭v9.8自检文档", timeOut: 5 });
        } catch (closeError) {
          reportSelfTestProgress({ label: "关闭自检临时文档", status: "failed", error: String(closeError.message || closeError) });
        }
        if (originalDocumentId != null && app.documents.length) {
          try {
            await core.executeAsModal(async () => selectDocument(originalDocumentId), { commandName: "恢复原测试文档", timeOut: 5 });
          } catch (_) {}
        }
      }
    }
  }

  return {
    parseFastInstruction,
    isModificationInstruction,
    requiresVisualGrounding,
    auditIntentCoverage,
    auditPlanningCompleteness,
    understand,
    compilePlan,
    stateEvidenceRequirements,
    rebasePlanAfterSelection,
    assertSafeSelectionRestoreBaseline,
    prepareResources,
    execute,
    undo,
    selfTest,
    resolveTarget,
    verifyProtectedLayers
  };
});
