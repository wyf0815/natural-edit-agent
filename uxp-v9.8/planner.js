(function (root, factory) {
  const protocol = root.PhotoshopAssistantV8Protocol
    || (typeof module === "object" && module.exports ? require("./protocol.js") : null);
  const api = factory(protocol);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV9Planner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
  "use strict";

  const MODIFICATION_WORDS = /(改成|改为|修改|调整|重命名|命名为|移动|缩放|旋转|翻转|斜切|删除|移除|新增|新建|创建|复制|拷贝|合并|裁剪|裁切|模糊|锐化|填充|导出|添加|去掉|变成|变亮|变暗|增亮|压暗|提亮|换成|替换|换色|上色|抠出|抠图|提取|隐藏|显示|保留|反相|应用|建立|放入|放到|设置|锁定|解锁|羽化|扩展|收缩|平滑|栅格化|移入|转换|转为|改(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?)/;

  const RULES = [
    rule("create_group", "创建图层组", /(?:建立|创建|新建).{0,24}(?:图层组|组)/, ["layer.create_group"]),
    rule("create_layer", "创建图层", /(?:建立|创建|新建).{0,16}(?:像素图层|空白图层|文字图层|图层(?!组))/, ["layer.create_pixel", "text.create"]),
    rule("duplicate", "复制图层", /(?:复制|拷贝).{0,18}(?:图层|层|文字|对象)|(?:图层|层|文字|对象).{0,18}(?:复制|拷贝)/, ["layer.duplicate"]),
    rule("move_to_group", "移动到图层组", /(?:放到|放入|放进|移到|移入|移进|移动到|拖到).{0,32}(?:图层组|组)(?:中|内|里)?/, ["layer.move_to_group"]),
    rule("rename", "重命名", /(?:重命名(?:为|成)?|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)/, ["layer.rename"]),
    rule("fill_opacity", "设置填充不透明度", /填充(?:不透明度|透明度)/, ["layer.set_fill_opacity"]),
    rule("opacity", "设置不透明度", /(?<!填充)(?:不透明度|透明度)/, ["layer.set_opacity"]),
    rule("visibility", "设置可见性", /(?:隐藏|显示|不可见|设为可见)/, ["layer.set_visibility"]),
    rule("blend", "设置混合模式", /混合模式/, ["layer.set_blend_mode"]),
    rule("lock", "设置图层锁定", /(?:锁定|解锁)/, ["layer.set_lock"]),
    rule("move", "移动位置", /向(?:左|右|上|下).{0,8}(?:移动)?\s*\d|(?:左|右|上|下)移\s*\d|往(?:左|右|上|下)(?:移动|挪动|挪)?\s*\d|移动到.{0,20}(?:位置|画布|选区)/, ["layer.move_by", "layer.align_to_reference"]),
    rule("scale", "缩放图层", /(?:缩放|放大|缩小|缩到).{0,16}\d/, ["layer.scale", "layer.fit_to_reference"]),
    rule("rotate", "旋转", /旋转\s*-?\d|(?:顺时针|逆时针).{0,8}\d/, ["layer.rotate", "document.rotate"]),
    rule("flip", "翻转", /(?:水平|垂直|左右|上下)(?:翻转|镜像)/, ["layer.flip"]),
    rule("skew", "斜切", /斜切/, ["layer.skew"]),
    rule("rasterize", "栅格化", /栅格化/, ["layer.rasterize"]),
    rule("convert_smart_object", "转换为智能对象", /(?:转换(?:成|为)?|转为|变为|变成).{0,12}智能对象|智能对象.{0,12}(?:转换(?:成|为)?|转为|变为|变成)/, ["layer.convert_to_smart_object"]),
    rule("merge_down", "向下合并图层", /(?:向下合并|与下方图层合并|合并到下方图层|合并当前图层和下方图层|合并当前(?:图)?层到(?:下一|下一个|下方)(?:图)?层)/, ["layer.merge_down"]),
    rule("reorder", "调整图层顺序", /(?:置顶|置底|最前|最后|最上面|最下面|移到最上|移到最下)/, ["layer.reorder"]),
    rule("align", "对齐到参考", /(?:对齐|居中).{0,20}(?:画布|选区)|(?:画布|选区).{0,20}(?:对齐|居中)/, ["layer.align_to_reference", "text.fit_to_reference", "group.fit_text_to_reference"]),
    rule("fit", "适配到参考范围", /(?:放入|适配|铺满|填满).{0,20}(?:画布|选区)|(?:画布|选区).{0,20}(?:放入|适配|铺满|填满)/, ["layer.fit_to_reference", "text.fit_to_reference", "group.fit_text_to_reference"]),
    rule("text_content", "修改文字内容", /(?:文字内容|文本内容).{0,20}(?:改为|改成|修改|替换|换成|设成|设置为)|(?:把|将).{0,12}(?:文字|文本).{0,12}(?:改为|改成|替换为|换成|设成|设置为)|(?:当前|选中|指定|这个|该)?(?:文字|文本).{0,12}(?:换成|设成|设置为)/, ["text.set_content"]),
    rule("text_color", "修改文字颜色", /(?:文字|文本|字体).{0,20}(?:(?:颜色|改成|改为|变成).{0,16}(?:色|#[0-9a-f]{6})|改(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?)/i, ["text.set_color", "group.set_text_style"]),
    rule("text_size", "修改字号", /(?:字号|文字大小|字体大小)|(?:文字|文本).{0,16}(?:改为|改成|换成|换为|设为|设成|设置为|设置成)\s*-?\d+(?:\.\d+)?\s*(?:号字|pt|点|磅)/i, ["text.set_size", "group.set_text_style"]),
    rule("text_font", "修改字体", /(?:字体|字型).{0,12}(?:改为|改成|设置为|设置成|换成|换为|设为|设成)|(?:文字|文本).{0,16}(?:改为|改成|设置为|设置成|换成|换为|设为|设成).{1,80}(?:字体|字型)/, ["text.set_font", "group.set_text_style"]),
    rule("text_orientation", "修改文字方向", /(?:横排|横版|竖排|竖版|文字方向)/, ["text.set_orientation", "group.set_text_style", "group.fit_text_to_reference"]),
    rule("text_scale", "修改文字水平或垂直缩放", /(?:文字|文本|字符).{0,16}(?:水平缩放|垂直缩放|横向缩放|纵向缩放)|(?:水平缩放|垂直缩放|横向缩放|纵向缩放).{0,16}(?:文字|文本|字符)/, ["text.set_horizontal_scale", "text.set_vertical_scale", "group.set_text_style"]),
    rule("text_spacing", "修改文字间距", /(?:行距|字距|基线偏移|首行缩进|左缩进|右缩进|段前|段后)/, [
      "text.set_leading", "text.set_tracking", "text.set_baseline_shift",
      "text.set_paragraph_spacing", "group.set_text_style"
    ]),
    rule("text_style", "修改文字样式", /(?:加粗|粗体|斜体|取消加粗|取消粗体|取消斜体|对齐|连字符)/, [
      "text.set_faux_bold", "text.set_faux_italic", "text.set_justification",
      "text.set_hyphenation", "group.set_text_style"
    ]),
    rule("filter", "应用滤镜", /(?:高斯模糊|动感模糊|(?:添加|增加|加入)(?:\s*\d+(?:\.\d+)?\s*%?)?杂色|高反差保留|USM锐化|进一步锐化|锐化)/i, ["filter.*"]),
    rule("selection_load", "载入图层透明区域选区", /(?:透明区域|图层).{0,16}(?:载入|加载).{0,8}选区|(?:载入|加载).{0,8}(?:图层)?透明区域/, ["selection.load_layer"]),
    rule("selection", "建立或修改选区", /(?:(?:选择|选中|选取).{0,24}(?:主体|主要人物)|(?:选择|选中|选取)(?!的?(?:(?:多个|这些|全部|所有))?(?:图层|层|文字|文本|组))|选主体|(?:建立|创建).{0,80}?(?:矩形|椭圆|多边形)?选区|(?:收缩|扩展|扩大|羽化|平滑)(?:(?:当前)?选区.{0,10})?\d|(?:收缩|扩展|扩大|羽化|平滑)(?:当前)?选区|(?:当前|已有|现有)?选区.{0,16}(?:收缩|扩展|扩大|羽化|平滑|反选|反向选择|边界)|(?:颜色)?容差.{0,16}(?:扩展|扩大)(?:当前)?选区|(?:扩展|扩大)(?:当前)?选区.{0,16}(?:颜色)?容差|给(?:当前)?选区.{0,16}边界|反选|反向选择|取消选择|取消(?:当前)?选区|清除(?:当前)?选区|全选)/, ["selection.*"]),
    rule("clipping_mask", "设置剪贴蒙版", /(?:创建|建立|添加|设为|启用|取消|释放|解除|停用).{0,12}剪贴蒙版|剪贴蒙版.{0,12}(?:创建|建立|添加|设为|启用|取消|释放|解除|停用)/, ["layer.set_clipping_mask"]),
    rule("mask_create", "创建图层蒙版", /(?:创建|添加|建立|加(?:一个)?).{0,12}(?:图层)?蒙版|(?:图层)?蒙版.{0,12}(?:创建|添加|建立|加(?:一个)?)/, ["mask.create_from_selection", "mask.create_reveal_all", "mask.create_hide_all"]),
    rule("mask_invert", "反相图层蒙版", /反相.{0,12}(?:图层)?蒙版|(?:图层)?蒙版.{0,12}反相/, ["mask.invert"]),
    rule("mask_delete", "删除图层蒙版", /(?:删除|移除).{0,12}(?:图层)?蒙版|(?:图层)?蒙版.{0,12}(?:删除|移除)/, ["mask.delete"]),
    rule("mask_apply", "应用图层蒙版", /(?:应用|合并).{0,12}(?:图层)?蒙版|(?:图层)?蒙版.{0,12}(?:应用|合并)/, ["mask.apply"]),
    rule("mask_density", "设置图层蒙版密度", /(?:图层)?蒙版.{0,12}密度|密度.{0,12}(?:图层)?蒙版/, ["mask.set_density"]),
    rule("mask_feather", "设置图层蒙版羽化", /(?:图层)?蒙版.{0,12}羽化|羽化.{0,12}(?:图层)?蒙版/, ["mask.set_feather"]),
    rule("color_adjustment", "修改颜色或色调", /(?:改色|换色|上色|去色|黑白|灰色|色相|饱和度|自然饱和度|明度|亮度|对比度|曝光度|改(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?|(?:改成|改为|换成|变成|替换为|设为).{0,8}(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?|#[0-9a-f]{6}.{0,20}(?:改成|改为|换成|替换为)|(?:改成|改为|换成|替换为).{0,20}#[0-9a-f]{6})/i, ["adjustment.*", "text.set_color", "group.set_text_style"]),
    rule("cutout", "抠出主体或隐藏背景", /(?:抠出|抠图|提取主体|隐藏背景|去背景|背景隐藏)/, [
      "layer.duplicate", "selection.subject", "selection.visual_object",
      "mask.create_from_selection", "layer.set_visibility"
    ]),
    rule("document_size", "修改图像或画布尺寸", /(?:图像|图片|画布).{0,12}(?:大小|尺寸|调整为|改为).{0,16}\d/, ["document.resize_image", "document.resize_canvas"]),
    rule("document_crop", "裁剪文档", /(?:裁剪|裁切|裁掉|去掉四周透明|四周透明)/, ["document.crop", "document.trim"]),
    rule("document_reveal", "扩展画布显示全部内容", /(?:显示全部内容|显示画布外|扩展画布)/, ["document.reveal_all"]),
    rule("merge_visible", "合并可见图层", /合并.{0,8}可见.{0,8}图层|合并可见图层/, ["document.merge_visible"]),
    rule("flatten", "拼合图像", /(?:拼合|扁平化).{0,12}(?:图像|文档|PSD)|(?:图像|文档|PSD).{0,12}(?:拼合|扁平化)/, ["document.flatten"]),
    rule("export", "导出文件", /(?:导出|另存为|保存为).{0,12}(?:PNG|JPG|JPEG|PSD|PSB|GIF|BMP)/i, ["document.export"]),
    rule("delete", "删除图层", /(?:删除|移除).{0,20}(?:图层组|图层(?!蒙版)|(?<!蒙版)层(?!蒙版))/, ["layer.delete"])
  ];

  function rule(key, label, pattern, expectedActions) {
    return { key, label, pattern, expectedActions };
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\r/g, "\n")
      .replace(/\s+/g, " ")
      .trim();
  }

  const EXPECTED_COLORS = protocol && protocol.NAMED_COLORS || Object.freeze({
    红: "#FF0000", 蓝: "#0000FF", 绿: "#00A651", 黄: "#FFFF00", 黑: "#000000",
    白: "#FFFFFF", 灰: "#808080", 紫: "#800080", 橙: "#FF8C00", 粉: "#FF69B4"
  });

  function normalizeExpectedColor(value) {
    const raw = String(value || "").trim();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toUpperCase();
    }
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
    const name = raw.replace(/色$/, "");
    return EXPECTED_COLORS[name] || null;
  }

  function userVisualContract(value, plannedDescription) {
    if (!protocol || typeof protocol.buildUserVisualContract !== "function") return null;
    try {
      return protocol.buildUserVisualContract(String(value || ""), plannedDescription);
    } catch (_) {
      return null;
    }
  }

  function globalColorReplacement(value) {
    const text = String(value || "");
    const colors = [...text.matchAll(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g)]
      .map((match) => normalizeExpectedColor(match[0]))
      .filter(Boolean);
    const hasGlobalScope = /(?:全图|整张(?:图|图片|画面)|整个(?:画面|画布|文档)|全部|所有|每一处|图中(?:所有)?)/.test(text);
    const hasReplacementVerb = /(?:改成|改为|换成|换为|变成|替换为|替换成)/.test(text);
    if (!hasGlobalScope || !hasReplacementVerb || colors.length < 2 || /(?:文字|文本|字体)/.test(text)) return null;
    const defaults = protocol && typeof protocol.defaultsForInstruction === "function"
      ? protocol.defaultsForInstruction("global_color_replace")
      : { tolerance: 24, softness: 8, opacity: 100, blendMode: "normal" };
    const tolerance = text.match(/(?:颜色)?容差\s*(?:为|设为|设置为)?\s*(\d+(?:\.\d+)?)/);
    return {
      sourceColor: colors[0],
      targetColor: colors[colors.length - 1],
      tolerance: tolerance ? Number(tolerance[1]) : defaults.tolerance,
      softness: defaults.softness,
      opacity: defaults.opacity,
      blendMode: defaults.blendMode
    };
  }

  function semanticTargetInsideContainer(value) {
    return /(?:图层|文字层|图层组|组|画面|图片)(?:里|中|内|上(?:的)?).{1,80}(?:改|换|调|选|抠|隐藏|显示|删除|移除|模糊|锐化|擦除|修掉|去除)/.test(String(value || ""));
  }

  // Visual-object authorization is based on the normalized target role, not
  // a whitelist of known nouns. Exclude Photoshop structural/global targets;
  // everything else with a real entity, part, or visual position can be
  // audited through the visual contract (including previously unseen nouns).
  function hasConcreteVisualTarget(value, plannedDescription) {
    const source = String(value || "");
    if (globalColorReplacement(source)) return false;
    if (semanticTargetInsideContainer(source)) return true;
    if (/(?:当前|现用|这个|该|选中|所选|指定|名为).{0,16}(?:图层组|图层|文字层|文本层|层|文字|文本|组)|(?:当前|已有|现有)选区/.test(source)) return false;
    if (/(?:全图|整张(?:图|图片|画面)|整个画面|全部画面|整幅图|整个文档|整个画布)|(?:颜色范围|同色(?:区域|像素)?|相同颜色(?:区域|像素)?|所有.{0,16}像素)/.test(source)) return false;
    const contract = userVisualContract(source, plannedDescription);
    const target = contract && contract.target;
    if (!target) return false;
    if (target.part || (Array.isArray(target.positions) && target.positions.length)) return true;
    const entity = String(target.entity || "")
      .replace(/(?:颜色|色相|饱和度|自然饱和度|亮度|明度|对比度|曝光度|不透明度|透明度|模糊|锐化|杂色|蒙版|图层|文字|文本|画布|文档|图像|图片|照片|选区)/g, "")
      .replace(/[\d\s%._-]+/g, "");
    return Boolean(entity);
  }

  function explicitlyRequestsColorRange(value) {
    const text = String(value || "");
    // A colour adjective on a named object (for example "黄色奖杯") is an
    // identification hint, not permission to select every pixel of that
    // colour.  Only explicit pixel/range wording authorizes color_range.
    return Boolean(globalColorReplacement(text))
      || /(?:颜色范围|同色(?:区域|像素)?|相同颜色(?:区域|像素)?|颜色区域|色块|像素)/.test(text);
  }

  function destinationColor(text) {
    const valuePattern = "(#[0-9a-fA-F]{3,6}|红色?|蓝色?|绿色?|黄色?|黑色?|白色?|灰色?|紫色?|橙色?|粉色?)";
    let match = String(text || "").match(new RegExp(`(?:改成|改为|换成|换为|变成|替换为|替换成|设为|设成|设置为|设置成|上色为?)\\s*${valuePattern}`));
    if (!match) match = String(text || "").match(new RegExp(`(?:改|换)\\s*${valuePattern}(?:\\s|$|[，。；])`));
    return match ? normalizeExpectedColor(match[1]) : null;
  }

  function sourceSelectionColor(textValue) {
    const text = String(textValue || "");
    const beforeChange = text.split(/(?:改成|改为|换成|换为|变成|替换为|设置为|设置成|设为|设成)/)[0];
    const matches = [...beforeChange.matchAll(/#[0-9a-fA-F]{3,6}|(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?/g)];
    if (!matches.length) return null;
    return normalizeExpectedColor(matches[matches.length - 1][0]);
  }

  function targetSegment(textValue) {
    const text = String(textValue || "");
    const matches = [...text.matchAll(/(?:改为|改成|改到|换成|换为|变成|替换为|设置为|设置成|设为|设成|调整为|调整到)/g)];
    if (!matches.length) return text;
    const last = matches[matches.length - 1];
    return text.slice(last.index + last[0].length).split(/[，。；]|(?:并且|然后|同时)/)[0];
  }

  function expectedMetric(textValue, labelPattern) {
    const text = String(textValue || "");
    const number = "(-?\\d+(?:\\.\\d+)?)";
    const target = text.match(new RegExp(`${labelPattern}.{0,24}?(?:调整为|调整到|改为|改成|改到|改|设为|设置为|到)\\s*${number}`));
    if (target) return Number(target[1]);
    const directionAfter = text.match(new RegExp(`${labelPattern}.{0,10}?(降低|减少|压低|拉低|调低|往下调|压暗|调暗|提高|增加|提升|提亮|调亮|往上调).{0,10}?${number}`));
    const directionBefore = text.match(new RegExp(`(降低|减少|压低|拉低|调低|往下调|压暗|调暗|提高|增加|提升|提亮|调亮|往上调).{0,16}?${labelPattern}.{0,10}?${number}`));
    const directional = directionAfter || directionBefore;
    if (directional) {
      const direction = directional[1];
      const value = Math.abs(Number(directional[2]));
      return /降低|减少|压低|拉低|调低|往下调|压暗|调暗/.test(direction) ? -value : value;
    }
    const matches = [...text.matchAll(new RegExp(`${labelPattern}.{0,16}?${number}`, "g"))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  }

  function parseSmallCount(value) {
    const raw = String(value || "").trim();
    if (/^\d+$/.test(raw)) return Number(raw);
    const values = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return values[raw] || null;
  }

  function actionDefaults(action) {
    return protocol && typeof protocol.defaultsForAction === "function"
      ? protocol.defaultsForAction(action)
      : {};
  }

  function labeledNumber(textValue, labelPattern) {
    const text = String(textValue || "");
    const match = text.match(new RegExp(`(?:${labelPattern})\\s*(?:调整|修改|改|设|设为|设置为)?\\s*(?:为|成|到)?\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
    return match ? Number(match[1]) : null;
  }

  function parseCreatedLayer(textValue) {
    const text = String(textValue || "");
    if (!/(?:建立|创建|新建)/.test(text)) return null;
    const isText = /(?:文字|文本)(?:图层|层)/.test(text);
    const isPixel = /(?:空白像素|空白|像素)(?:图层|层)/.test(text);
    if (!isText && !isPixel) return null;
    const action = isText ? "text.create" : "layer.create_pixel";
    const defaults = actionDefaults(action);
    const quotedName = text.match(/(?:名为|叫(?:做)?|名称为)\s*[“"'‘「『]([^”"'’」』]{1,160})[”"'’」』]/);
    const directName = text.match(/(?:名为|叫(?:做)?|名称为)\s*([^，。；“”"'‘’]{1,160}?)(?=(?:的)?\s*(?:空白像素|空白|像素|文字|文本)(?:图层|层)(?:$|[，。；]))/);
    const name = String((quotedName || directName || [null, defaults.name])[1] || defaults.name || "").trim();
    if (!isText) return { action, name };
    const quotedContent = text.match(/(?:内容|文字内容|文本内容)\s*(?:为|是|设为|设置为|[：:])?\s*[“"'‘「『]([^”"'’」』]*)[”"'’」』]/)
      || text.match(/(?:文字|文本)\s*(?:为|是|设为|设置为|[：:])\s*[“"'‘「『]([^”"'’」』]*)[”"'’」』]/)
      || text.match(/(?:写上|写入|输入)\s*[“"'‘「『]([^”"'’」』]*)[”"'’」』]/);
    const directContent = quotedContent ? null
      : text.match(/(?:内容|文字内容|文本内容)\s*(?:为|是|设为|设置为|[：:])\s*([^，。；]{1,200})(?=$|[，。；])/)
        || text.match(/(?:文字|文本)\s*(?:为|是|设为|设置为|[：:])\s*([^，。；]{1,200})(?=$|[，。；])/)
        || text.match(/(?:写上|写入|输入)\s*([^，。；]{1,200})(?=$|[，。；])/);
    const explicitContent = quotedContent || directContent;
    return {
      action,
      name,
      content: explicitContent ? String(explicitContent[1]) : String(defaults.content == null ? "文字" : defaults.content),
      explicitName: Boolean(quotedName || directName),
      explicitContent: Boolean(explicitContent)
    };
  }

  function parseFilterSemantics(textValue) {
    const text = String(textValue || "");
    let action = null;
    if (/高斯模糊/i.test(text)) action = "filter.gaussian_blur";
    else if (/(?:动感模糊|运动模糊)/i.test(text)) action = "filter.motion_blur";
    else if (/(?:杂色|噪点)/i.test(text)) action = "filter.add_noise";
    else if (/高反差保留/i.test(text)) action = "filter.high_pass";
    else if (/(?:USM锐化|反遮罩锐化|\bUSM\b)/i.test(text)) action = "filter.unsharp_mask";
    else if (/锐化(?:滤镜)?/i.test(text)) action = "filter.sharpen";
    if (!action) return null;
    const params = actionDefaults(action);
    if (action === "filter.gaussian_blur" || action === "filter.high_pass") {
      const trailingMatch = text.match(new RegExp(`${action === "filter.gaussian_blur" ? "高斯模糊" : "高反差保留"}(?:滤镜)?\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
      const leadingMatch = action === "filter.gaussian_blur"
        ? text.match(/(-?\d+(?:\.\d+)?)\s*(?:像素|px)\s*(?:的)?高斯模糊/i)
        : null;
      const radius = [
        labeledNumber(text, "半径"),
        trailingMatch ? Number(trailingMatch[1]) : NaN,
        leadingMatch ? Number(leadingMatch[1]) : NaN
      ].find(Number.isFinite);
      if (Number.isFinite(radius)) params.radius = radius;
    } else if (action === "filter.motion_blur") {
      const angle = labeledNumber(text, "角度");
      const distance = labeledNumber(text, "距离");
      if (angle != null) params.angle = angle;
      if (distance != null) params.distance = distance;
    } else if (action === "filter.add_noise") {
      const amount = labeledNumber(text, "数量|强度");
      const inline = text.match(/(-?\d+(?:\.\d+)?)\s*%?.{0,12}(?:杂色|噪点)/i);
      if (amount != null) params.amount = amount;
      else if (inline) params.amount = Number(inline[1]);
      params.distribution = /(?:高斯(?:分布)?).{0,8}(?:杂色|噪点)|(?:杂色|噪点).{0,8}高斯(?:分布)?/.test(text) ? "gaussian" : "uniform";
      params.monochromatic = /(?:单色(?:杂色|噪点)?)/.test(text) && !/(?:彩色|非单色)(?:杂色|噪点)/.test(text);
    } else if (action === "filter.unsharp_mask") {
      const amount = labeledNumber(text, "数量|强度");
      const radius = labeledNumber(text, "半径");
      const threshold = labeledNumber(text, "阈值");
      if (amount != null) params.amount = amount;
      if (radius != null) params.radius = radius;
      if (threshold != null) params.threshold = threshold;
    }
    const semanticInsideContainer = semanticTargetInsideContainer(text);
    const explicitSelection = /(?:当前|已有|现有)选区|选中的区域|局部区域/.test(text);
    const namedLayerTarget = /(?:对象|物体|人物|角色|商品|产品|奖杯|衣服|服装|帽子|背景|主体|胡子|眼睛|嘴|叶子|污点|图标|色块)(?:图层|层)/.test(text);
    params.useSelection = explicitSelection || semanticInsideContainer || (hasConcreteVisualTarget(text) && !namedLayerTarget);
    return { action, params };
  }

  function analyzeInstructionClause(value) {
    const text = String(value || "").trim();
    const globalReplacement = globalColorReplacement(text);
    const createdLayer = parseCreatedLayer(text);
    const filter = parseFilterSemantics(text);
    const selectAll = /(?:选择|选中|选取)(?:整个)?(?:画布|文档|全部)|全选(?:画布|文档)?/.test(text);
    const revealAll = /(?:扩展画布)?显示全部(?:内容|图层)|显示画布外全部内容|画布扩展到包含所有内容/.test(text);
    const documentRotate = text.match(/(?:整个)?(?:文档|画布)(?:整体|本身)?(?:向)?\s*(顺时针|逆时针)?\s*(?:旋转|转动)\s*(-?\d+(?:\.\d+)?)\s*度?/)
      || text.match(/(?:把|将)(?:整个)?(?:文档|画布)\s*(顺时针|逆时针)?\s*(?:旋转|转动)\s*(-?\d+(?:\.\d+)?)\s*度?/);
    const fitReference = /(?:选区|画布)/.test(text) && /(?:放入|适配|装入|铺满|填满|缩放到|缩放放入)/.test(text);
    let fit = null;
    if (fitReference) {
      const action = /(?:组内|图层组)/.test(text) ? "group.fit_text_to_reference"
        : /(?:文字|文本)/.test(text) ? "text.fit_to_reference"
          : "layer.fit_to_reference";
      const params = actionDefaults(action);
      params.reference = /选区/.test(text) ? "selection" : "canvas";
      const padding = text.match(/(?:内边距|留白|四周留|四周|边缘|边距)(?:留|保留|设置为|为)?\s*(-?\d+(?:\.\d+)?)\s*(?:像素|px)?/i);
      if (padding) params.padding = Number(padding[1]);
      params.allowUpscale = /(?:允许|可以).{0,8}(?:放大|向上缩放)|允许放大/.test(text);
      if (action === "group.fit_text_to_reference") params.arrangement = /(?:紧凑|重新排列|重排)/.test(text) ? "compact" : "preserve";
      fit = { action, params };
    }
    const baselineShift = labeledNumber(text, "基线偏移");
    return {
      text,
      globalColorReplacement: globalReplacement,
      createdLayer,
      filter,
      selectionAction: selectAll ? "selection.select_all" : null,
      documentAction: revealAll ? "document.reveal_all" : documentRotate ? "document.rotate" : null,
      documentAngle: documentRotate
        ? (/\u9006\u65f6\u9488/.test(documentRotate[1] || "") ? -Math.abs(Number(documentRotate[2])) : Math.abs(Number(documentRotate[2])))
        : null,
      fit,
      baselineShift,
      structuralGlobalAction: Boolean(selectAll || revealAll || documentRotate)
    };
  }

  function expectedParamsFor(key, clause) {
    const text = String(clause || "");
    const semantics = analyzeInstructionClause(text);
    const expected = {};
    if (["color_adjustment", "text_color"].includes(key)) {
      const color = semantics.globalColorReplacement
        ? semantics.globalColorReplacement.targetColor
        : destinationColor(text);
      if (color) expected.color = color;
    }
    if (key === "selection" || key === "color_adjustment") {
      const selectionColor = semantics.globalColorReplacement
        ? semantics.globalColorReplacement.sourceColor
        : sourceSelectionColor(text);
      if (selectionColor && explicitlyRequestsColorRange(text)) {
        expected.selectionColor = selectionColor;
        const tolerance = text.match(/(?:颜色)?容差\s*(-?\d+(?:\.\d+)?)/);
        expected.selectionTolerance = semantics.globalColorReplacement
          ? semantics.globalColorReplacement.tolerance
          : tolerance ? Number(tolerance[1]) : key === "color_adjustment" ? 24 : actionDefaults("selection.color_range").tolerance;
      }
    }
    if (key === "create_group") {
      const count = text.match(/(?:建立|创建|新建)\s*(\d+|[一二两三四五六七八九十])\s*个/);
      if (count) expected.count = parseSmallCount(count[1]);
      const match = text.match(/(?:建立|创建|新建)(?:一个)?(?:名为|叫(?:做)?|名称为)\s*[“"'‘]?([^，。；”"'’]{1,60}?)[”"'’]?(?:的)?(?:图层组|组)/)
        || text.match(/(?:图层组|组)(?:名为|叫(?:做)?|名称为)\s*[“"'‘]?([^，。；”"'’]{1,60})/)
        || text.match(/(?:建立|创建|新建)(?:一个)?\s*[“"'‘]?([^，。；”"'’]{1,40}?)[”"'’]?\s*(?:图层组|组)(?:$|[，。；])/);
      if (match) expected.name = String(match[1]).trim();
    }
    if (key === "create_layer") {
      const count = text.match(/(?:建立|创建|新建)\s*(\d+|[一二两三四五六七八九十])\s*个/);
      if (count) expected.count = parseSmallCount(count[1]);
      if (semantics.createdLayer) {
        expected.name = semantics.createdLayer.name;
        if (semantics.createdLayer.action === "text.create") expected.content = semantics.createdLayer.content;
      }
    }
    if (key === "duplicate") {
      const count = text.match(/(?:复制|拷贝).{0,24}?(\d+|[一二两三四五六七八九十])\s*(?:份|个(?:副本)?)/)
        || text.match(/(\d+|[一二两三四五六七八九十])\s*(?:份|个副本).{0,12}(?:复制|拷贝)/);
      if (count) expected.count = parseSmallCount(count[1]);
    }
    if (key === "rename") {
      const quoted = text.match(/(?:重命名(?:为|成)?|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)\s*[：:]?\s*[“"'‘]([^”"'’]{1,160})[”"'’]/);
      const direct = text.match(/(?:重命名(?:为|成)?|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)\s*[：:]?\s*([^，。；“”"'‘’]{1,160}?)(?=$|[，。；]|并且|并|然后|同时)/);
      const match = quoted || direct;
      if (match) expected.name = String(match[1]).trim();
    }
    if (key === "text_content") {
      const matches = [...text.matchAll(/(?:改为|改成|替换为|换成|设成|设置为|设为)\s*[“"'‘]?([^，。；”"'’]{1,200})[”"'’]?/g)];
      const explicit = text.match(/(?:文字内容|文本内容)(?:改为|改成|替换为|换成|设成|设置为|设为)\s*[“"'‘]?([^，。；”"'’]{1,200})[”"'’]?/);
      const match = explicit || matches[matches.length - 1];
      if (match) expected.content = String(match[1]).trim();
    }
    if (key === "move_to_group") {
      const named = text.match(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到).{0,10}名为\s*[“"'‘]?([^，。；”"'’]{1,60}?)[”"'’]?(?:的)?(?:图层组|组)/);
      const quoted = text.match(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)\s*[“"'‘]([^”"'’]{1,60})[”"'’]\s*(?:图层组|组)(?:中|内|里)?/);
      const direct = text.match(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)\s*([^，。；“”"'‘’]{1,60}?(?:图层组|组))(?:中|内|里)?(?=$|[，。；]|并且|并|然后|同时)/);
      const groupQuoted = text.match(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)\s*(?:图层组|组)\s*[“"'‘]([^”"'’]{1,60})[”"'’](?:中|内|里)?/);
      const groupFirst = text.match(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)\s*(?:图层组|组)\s*([^，。；“”"'‘’中内里]{1,60})(?:中|内|里)(?=$|[，。；]|并且|并|然后|同时)/);
      const match = named || quoted || groupQuoted || groupFirst || direct;
      if (match) expected.destinationGroupName = String(match[1]).trim();
    }
    if (key === "blend") {
      const blendModes = {
        正常: "normal", 正片叠底: "multiply", 滤色: "screen", 叠加: "overlay", 柔光: "softLight",
        强光: "hardLight", 变暗: "darken", 变亮: "lighten", 颜色: "color", 色相: "hue",
        饱和度: "saturation", 明度: "luminosity", 亮度: "luminosity", 差值: "difference"
      };
      const targetText = targetSegment(text);
      for (const [label, value] of Object.entries(blendModes)) {
        if (targetText.includes(label)) { expected.blendMode = value; break; }
      }
    }
    if (key === "lock") {
      expected.lock = /透明像素/.test(text) ? "transparentPixels"
        : /位置/.test(text) ? "position"
          : /(?:像素|图像像素)/.test(text) ? "pixels"
            : "all";
      expected.locked = !/(?:解锁|取消锁定|解除锁定)/.test(text);
    }
    if (key === "visibility") expected.visible = /(?:取消隐藏|显示|设为可见|恢复可见)/.test(text);
    if (key === "opacity" || key === "fill_opacity") {
      const phrase = key === "fill_opacity" ? "填充(?:不透明度|透明度)" : "(?<!填充)(?:不透明度|透明度)";
      const targetMatch = text.match(new RegExp(`${phrase}.{0,20}?(?:改为|改成|设为|设置为|调整为|到)\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?`));
      const matches = [...text.matchAll(new RegExp(`${phrase}.{0,16}?(-?\\d+(?:\\.\\d+)?)\\s*%?`, "g"))];
      const match = targetMatch || matches[matches.length - 1];
      if (match) expected[key === "fill_opacity" ? "fillOpacity" : "opacity"] = Number(match[1]);
    }
    if (key === "text_size") {
      const targetMatch = text.match(/(?:字号|文字大小|字体大小).{0,20}?(?:改为|改成|设为|设置为|调整为|到)\s*(-?\d+(?:\.\d+)?)\s*(?:pt|点|磅)?/i);
      const matches = [...text.matchAll(/(?:字号|文字大小|字体大小).{0,12}?(-?\d+(?:\.\d+)?)\s*(?:pt|点|磅)?/gi)];
      const directStyle = text.match(/(?:文字|文本).{0,16}?(?:改为|改成|换成|换为|设为|设成|设置为|设置成)\s*(-?\d+(?:\.\d+)?)\s*(?:号字|pt|点|磅)/i);
      const match = targetMatch || directStyle || matches[matches.length - 1];
      if (match) expected.size = Number(match[1]);
    }
    if (key === "move") {
      expected.deltaX = 0;
      expected.deltaY = 0;
      let found = false;
      const pattern = /(?:向(左|右|上|下)(?:移动)?|(左|右|上|下)移|往(左|右|上|下)(?:移动|挪动|挪)?)\s*(-?\d+(?:\.\d+)?)\s*(?:px|像素)?/g;
      let match;
      while ((match = pattern.exec(text))) {
        found = true;
        const direction = match[1] || match[2] || match[3];
        const amount = Math.abs(Number(match[4]));
        if (direction === "左") expected.deltaX -= amount;
        if (direction === "右") expected.deltaX += amount;
        if (direction === "上") expected.deltaY -= amount;
        if (direction === "下") expected.deltaY += amount;
      }
      if (!found) {
        delete expected.deltaX;
        delete expected.deltaY;
      }
    }
    if (key === "rotate") {
      const match = semantics.documentAction === "document.rotate"
        ? null
        : text.match(/(顺时针|逆时针).{0,24}?(-?\d+(?:\.\d+)?)\s*度?/) || text.match(/(?:旋转|转动).{0,24}?(-?\d+(?:\.\d+)?)\s*度?/);
      if (semantics.documentAction === "document.rotate") {
        expected.angle = semantics.documentAngle;
      } else if (match) {
        const direction = match.length > 2 ? match[1] || "" : "";
        let angle = Number(match.length > 2 ? match[2] : match[1]);
        if (direction === "顺时针") angle = Math.abs(angle);
        if (direction === "逆时针") angle = -Math.abs(angle);
        expected.angle = angle;
      }
      expected.anchor = /左上/.test(text) ? "top_left"
        : /右上/.test(text) ? "top_right"
          : /左下/.test(text) ? "bottom_left"
            : /右下/.test(text) ? "bottom_right"
              : "middle_center";
    }
    if (key === "scale") {
      const match = text.match(/(?:缩放|缩到|放大|缩小).{0,24}?(?:到|为)?\s*(-?\d+(?:\.\d+)?)\s*%/);
      if (match) {
        const value = Number(match[1]);
        expected.scaleX = /(?:水平|横向)缩放/.test(text) ? value : /(?:垂直|纵向)缩放/.test(text) ? 100 : value;
        expected.scaleY = /(?:垂直|纵向)缩放/.test(text) ? value : /(?:水平|横向)缩放/.test(text) ? 100 : value;
      }
    }
    if (key === "skew") {
      const horizontal = text.match(/水平斜切\s*(-?\d+(?:\.\d+)?)\s*度?/);
      const vertical = text.match(/垂直斜切\s*(-?\d+(?:\.\d+)?)\s*度?/);
      if (horizontal || vertical) {
        expected.angleH = horizontal ? Number(horizontal[1]) : 0;
        expected.angleV = vertical ? Number(vertical[1]) : 0;
      }
    }
    if (key === "rasterize") {
      expected.rasterizeTarget = /(?:图层)?样式/.test(text) ? "layer_style"
        : /(?:文字|文本)(?:内容)?/.test(text) ? "text"
          : /(?:形状|矢量)/.test(text) ? "shape"
            : "entire_layer";
    }
    if (key === "flip") expected.axis = /(?:垂直|上下)/.test(text) ? "vertical" : "horizontal";
    if (key === "reorder") expected.position = /(?:置底|最后|最下面|移到最下)/.test(text) ? "back" : "front";
    if (key === "text_font") {
      const match = text.match(/(?:字体|字型).{0,10}?(?:改为|改成|设置为|设置成|换成|换为|设为|设成)\s*[“"'‘]?([^，。；”"'’]{1,80})/)
        || text.match(/(?:文字|文本).{0,16}?(?:改为|改成|设置为|设置成|换成|换为|设为|设成)\s*[“"'‘]?([^，。；”"'’]{1,80}?)(?:字体|字型)(?=$|[，。；])/);
      if (match) expected.font = String(match[1]).trim().replace(/(?:字体|字型)$/, "");
    }
    if (key === "text_orientation") expected.orientation = /(?:竖排|竖版|垂直文字)/.test(targetSegment(text)) ? "vertical" : "horizontal";
    if (key === "text_scale") {
      const horizontal = expectedMetric(text, "(?:水平|横向)缩放");
      const vertical = expectedMetric(text, "(?:垂直|纵向)缩放");
      if (horizontal != null) expected.horizontalScale = horizontal;
      if (vertical != null) expected.verticalScale = vertical;
    }
    if (key === "text_style") {
      if (/(?:取消|去掉|关闭).{0,8}(?:加粗|粗体)/.test(text)) expected.fauxBold = false;
      else if (/(?:加粗|粗体)/.test(text)) expected.fauxBold = true;
      if (/(?:取消|去掉|关闭).{0,8}斜体/.test(text)) expected.fauxItalic = false;
      else if (/斜体/.test(text)) expected.fauxItalic = true;
      if (/左对齐/.test(text)) expected.justification = "left";
      else if (/(?:居中|中对齐)/.test(text)) expected.justification = "center";
      else if (/右对齐/.test(text)) expected.justification = "right";
      if (/(?:关闭|取消|禁用).{0,8}连字符/.test(text)) expected.hyphenation = false;
      else if (/(?:开启|启用|使用).{0,8}连字符/.test(text)) expected.hyphenation = true;
    }
    if (key === "text_spacing") {
      const spacing = [
        ["leading", "行距"],
        ["tracking", "字距"],
        ["baselineShift", "基线偏移"],
        ["firstLineIndent", "首行缩进"],
        ["leftIndent", "左缩进"],
        ["rightIndent", "右缩进"],
        ["spaceBefore", "段前(?:间距)?"],
        ["spaceAfter", "段后(?:间距)?"]
      ];
      for (const [name, label] of spacing) {
        const value = expectedMetric(text, label);
        if (value != null) expected[name] = value;
      }
      if (semantics.baselineShift != null) expected.baselineShift = semantics.baselineShift;
    }
    if (key === "color_adjustment") {
      if (/(?:去色|黑白|(?:改成|改为|变成|换成)灰色)/.test(text)) expected.saturation = -100;
      if (destinationColor(text)) {
        const neutralReplacement = /(?:黑色|白色|近黑|近白|中性色|胡子|黑胡子).*(?:改成|改为|变成|换成)/.test(text);
        const texturedObject = /(?:人物|角色|身体|衣服|服装|手臂|胳膊|皮肤|商品|材质)/.test(text);
        const flatOverride = /(?:纯色覆盖|完全覆盖|扁平纯色)/.test(text);
        const preserveAppearance = /(?:保留|保持|维持).{0,16}(?:高光|阴影|明暗|纹理|质感|立体|褶皱)|(?:高光|阴影|明暗|纹理|质感|立体|褶皱).{0,16}(?:保留|保持|不变)/.test(text);
        if (flatOverride || (neutralReplacement && !preserveAppearance)) expected.colorizeBlendMode = "normal";
        else if (texturedObject || preserveAppearance) expected.colorizeBlendMode = "color";
      }
      const natural = expectedMetric(text, "自然饱和度");
      if (natural != null) expected.vibrance = natural;
      else {
        const saturation = expectedMetric(text, "饱和度");
        if (saturation != null) expected.saturation = saturation;
      }
      for (const [name, label] of [["hue", "色相"], ["lightness", "明度"], ["brightness", "亮度"], ["contrast", "对比度"], ["exposure", "曝光度"]]) {
        const value = expectedMetric(text, label);
        if (value != null) expected[name] = value;
      }
    }
    if (key === "filter") {
      const filter = semantics.filter;
      if (filter) {
        expected.filterUseSelection = filter.params.useSelection === true;
        if (["filter.gaussian_blur", "filter.high_pass"].includes(filter.action)) expected.radius = filter.params.radius;
        if (filter.action === "filter.motion_blur") {
          expected.distance = filter.params.distance;
          expected.motionAngle = filter.params.angle;
        }
        if (filter.action === "filter.add_noise") {
          expected.amount = filter.params.amount;
          expected.noiseDistribution = filter.params.distribution;
          expected.noiseMonochromatic = filter.params.monochromatic;
        }
        if (filter.action === "filter.unsharp_mask") {
          expected.unsharpAmount = filter.params.amount;
          expected.unsharpRadius = filter.params.radius;
          expected.unsharpThreshold = filter.params.threshold;
        }
      }
    }
    if (key === "selection") {
      const border = text.match(/(?:当前)?选区(?:建立|创建|变成|转成)?\s*(?:宽度为)?\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?(?:的)?边界|给(?:当前)?选区建立\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?(?:的)?边界/i);
      const grow = text.match(/(?:按)?(?:颜色)?容差\s*(\d+(?:\.\d+)?)\s*(?:扩展|扩大)(?:当前)?选区|(?:扩展|扩大)(?:当前)?选区.*?(?:颜色)?容差\s*(\d+(?:\.\d+)?)/i);
      if (border) expected.borderWidth = Number(border[1] == null ? border[2] : border[1]);
      if (grow) expected.growTolerance = Number(grow[1] == null ? grow[2] : grow[1]);
      const amount = text.match(/(?:羽化|扩展|扩大|收缩|平滑)(?:(?:当前)?选区)?|(?:当前|已有|现有)?选区(?:边缘)?(?:羽化|扩展|扩大|收缩|平滑)/)
        ? text.match(/(?:羽化|扩展|扩大|收缩|平滑).{0,10}?(-?\d+(?:\.\d+)?)|选区.{0,10}?(?:羽化|扩展|扩大|收缩|平滑).{0,10}?(-?\d+(?:\.\d+)?)/)
        : null;
      if (amount && !grow) expected.selectionAmount = Number(amount[1] == null ? amount[2] : amount[1]);
      if (/(?:羽化|扩展|扩大|收缩|平滑)/.test(text)) {
        expected.selectionApplyAtCanvasBounds = /(?:应用|允许|包含).{0,10}(?:画布|图像)边缘|(?:画布|图像)边缘.{0,10}(?:应用|允许|包含)/.test(text);
      }
      if (grow) expected.selectionGrowAntiAlias = !/(?:关闭|取消|不要|不使用).{0,8}抗锯齿|不抗锯齿/.test(text);
      if (/(?:矩形|椭圆|多边形).{0,8}选区|选区.{0,8}(?:矩形|椭圆|多边形)/.test(text)) {
        const labels = {
          selectionLeft: /左\s*(-?\d+(?:\.\d+)?)/,
          selectionTop: /上\s*(-?\d+(?:\.\d+)?)/,
          selectionRight: /右\s*(-?\d+(?:\.\d+)?)/,
          selectionBottom: /下\s*(-?\d+(?:\.\d+)?)/
        };
        const pointPair = text.match(/(-?\d+(?:\.\d+)?)\s*[x×*]\s*(-?\d+(?:\.\d+)?)\s*(?:到|至)\s*(-?\d+(?:\.\d+)?)\s*[x×*]\s*(-?\d+(?:\.\d+)?)/i);
        let multiplier = 1;
        expected.selectionUnit = /(?:归一化|normalized)/i.test(text) ? "percent" : /(?:百分比|%)/.test(text) ? "percent" : "pixels";
        if (/(?:归一化|normalized)/i.test(text)) multiplier = 100;
        if (pointPair) {
          expected.selectionLeft = Number(pointPair[1]) * multiplier;
          expected.selectionTop = Number(pointPair[2]) * multiplier;
          expected.selectionRight = Number(pointPair[3]) * multiplier;
          expected.selectionBottom = Number(pointPair[4]) * multiplier;
        } else {
          for (const [name, pattern] of Object.entries(labels)) {
            const match = text.match(pattern);
            if (match) expected[name] = Number(match[1]) * multiplier;
          }
        }
        const inlineFeather = text.match(/羽化.{0,8}?(\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?).{0,8}?羽化/);
        expected.selectionFeather = inlineFeather ? Number(inlineFeather[1] || inlineFeather[2]) : 0;
        expected.selectionAntiAlias = !/(?:关闭|取消|不要|不使用).{0,8}抗锯齿|不抗锯齿/.test(text);
      }
      if (/(?:选择|选中|选取).{0,24}(?:主体|主要人物)|(?:选主体|选择主体|选中主体|选取主体)/.test(text)) {
        expected.sampleAllLayers = !/(?:当前|指定|选中).{0,10}(?:图层|层)(?:的)?(?:主体|主要人物)/.test(text);
      }
    }
    if (key === "mask_density") {
      const value = expectedMetric(text, "密度");
      if (value != null) expected.density = value;
    }
    if (key === "mask_feather") {
      const match = text.match(/(?:羽化.{0,10}|蒙版.{0,10}羽化.{0,10})(-?\d+(?:\.\d+)?)\s*(?:px|像素)?/);
      if (match) expected.feather = Number(match[1]);
    }
    if (key === "document_size") {
      const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/gi)];
      const targetMatch = text.match(/(?:改为|改成|设为|设置为|调整为|到)\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
      const match = targetMatch || matches[matches.length - 1];
      if (match) {
        expected.width = Number(match[1]);
        expected.height = Number(match[2]);
      }
      const width = expectedMetric(text, "(?:图像|图片|画布|文档)?宽度");
      const height = expectedMetric(text, "(?:图像|图片|画布|文档)?高度");
      if (width != null) expected.width = width;
      if (height != null) expected.height = height;
      const resolution = text.match(/(?:分辨率\s*(?:改为|改成|设为|设置为|到)?\s*)?(\d+(?:\.\d+)?)\s*(?:ppi|dpi)\b/i);
      if (resolution) expected.resolution = Number(resolution[1]);
      if (!/画布/.test(text) && (expected.width != null || expected.height != null)) {
        const explicitlyFree = /(?:不保持|取消|解除|不要).{0,8}(?:比例|等比)|(?:拉伸|强制|精确).{0,8}(?:到|为)/.test(text);
        const explicitlyConstrained = /(?:保持|锁定|约束).{0,8}(?:比例|宽高比)|等比/.test(text);
        const singleAxis = (expected.width != null) !== (expected.height != null);
        expected.constrainProportions = explicitlyFree ? false : explicitlyConstrained ? true : singleAxis;
      }
    }
    if (key === "document_crop") {
      if (/选区/.test(text)) expected.cropReference = "selection";
      const cropLabels = {
        cropLeft: /左\s*(-?\d+(?:\.\d+)?)/,
        cropTop: /(?:上|顶)\s*(-?\d+(?:\.\d+)?)/,
        cropRight: /右\s*(-?\d+(?:\.\d+)?)/,
        cropBottom: /(?:下|底)\s*(-?\d+(?:\.\d+)?)/
      };
      const cropValues = Object.fromEntries(Object.entries(cropLabels).map(([name, pattern]) => [name, text.match(pattern)]));
      if (Object.values(cropValues).every(Boolean)) {
        expected.cropReference = "bounds";
        expected.cropUnit = /%|百分比/.test(text) ? "percent" : "pixels";
        for (const [name, matchValue] of Object.entries(cropValues)) expected[name] = Number(matchValue[1]);
      }
      if (/(?:透明|四周透明|透明像素)/.test(text)) {
        expected.trimType = "transparent";
        const hasExplicitSide = /(?:顶部|顶边|上边|左边|底部|底边|下边|右边)/.test(text);
        const allSides = /四周|全部|所有/.test(text) || !hasExplicitSide;
        expected.trimTop = allSides || /(?:顶部|顶边|上边)/.test(text);
        expected.trimLeft = allSides || /左边/.test(text);
        expected.trimBottom = allSides || /(?:底部|底边|下边)/.test(text);
        expected.trimRight = allSides || /右边/.test(text);
      }
    }
    if (key === "document_size" && /画布/.test(text)) {
      expected.anchor = /左上/.test(text) ? "top_left"
        : /右上/.test(text) ? "top_right"
          : /左下/.test(text) ? "bottom_left"
            : /右下/.test(text) ? "bottom_right"
              : /顶部|上边/.test(text) ? "top_center"
                : /底部|下边/.test(text) ? "bottom_center"
                  : /左边/.test(text) ? "middle_left"
                    : /右边/.test(text) ? "middle_right"
                      : "middle_center";
    }
    if (["align", "fit"].includes(key)) {
      expected.reference = semantics.fit ? semantics.fit.params.reference : /选区/.test(text) ? "selection" : "canvas";
      const padding = text.match(/(?:内边距|留白|四周留)\s*(-?\d+(?:\.\d+)?)\s*(?:px|像素)?/);
      expected.padding = semantics.fit ? semantics.fit.params.padding : padding ? Number(padding[1]) : 0;
      expected.allowUpscale = semantics.fit ? semantics.fit.params.allowUpscale : /(?:允许|可以).{0,8}(?:放大|向上缩放)|允许放大/.test(text);
      if (key === "fit" && /(?:组内|图层组)/.test(text)) expected.arrangement = semantics.fit ? semantics.fit.params.arrangement : /(?:紧凑|重新排列|重排)/.test(text) ? "compact" : "preserve";
      const horizontalCenter = /(?:水平|横向)居中/.test(text);
      const verticalCenter = /(?:垂直|纵向)居中/.test(text);
      const genericCenter = /居中/.test(text) && !horizontalCenter && !verticalCenter;
      if (/左(?:对齐|边)/.test(text)) expected.horizontal = "left";
      else if (/右(?:对齐|边)/.test(text)) expected.horizontal = "right";
      else if (horizontalCenter || genericCenter) expected.horizontal = "center";
      if (/(?:顶部|上边)/.test(text)) expected.vertical = "top";
      else if (/(?:底部|下边)/.test(text)) expected.vertical = "bottom";
      else if (verticalCenter || genericCenter) expected.vertical = "middle";
      if (key === "fit") {
        if (expected.horizontal == null) expected.horizontal = "center";
        if (expected.vertical == null) expected.vertical = "middle";
      }
    }
    if (key === "export") {
      const match = text.match(/(?:导出|另存为|保存为).{0,12}(PNG|JPG|JPEG|PSD|PSB|GIF|BMP)/i);
      if (match) expected.format = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
      const quality = text.match(/(?:质量|品质)\s*(?:为|设为|设置为)?\s*(\d+(?:\.\d+)?)/);
      expected.quality = quality ? Number(quality[1]) : 10;
      expected.asCopy = true;
    }
    return expected;
  }

  function expectedActionsFor(spec, clause) {
    const text = String(clause || "");
    const semantics = analyzeInstructionClause(text);
    if (spec.key === "create_layer") return semantics.createdLayer ? [semantics.createdLayer.action] : /(?:文字|文本)/.test(text) ? ["text.create"] : ["layer.create_pixel"];
    if (spec.key === "move") {
      if (/(?:画布|图像|图片|文档)/.test(text)) return [];
      return /(?:向(?:左|右|上|下)(?:移动)?|(?:左|右|上|下)移|往(?:左|右|上|下)(?:移动|挪动|挪)?)\s*-?\d/.test(text)
        ? ["layer.move_by"]
        : ["layer.align_to_reference"];
    }
    if (spec.key === "move_to_group") {
      return expectedParamsFor(spec.key, text).destinationGroupName ? ["layer.move_to_group"] : [];
    }
    if (spec.key === "scale") return semantics.fit || /(?:画布|图像|图片|文档)/.test(text) ? [] : ["layer.scale"];
    if (spec.key === "flip" && /(?:画布|图像|图片|文档)/.test(text)) return [];
    if (["opacity", "fill_opacity", "lock", "visibility"].includes(spec.key)
      && /(?:图层组|组)(?:里|中|内)(?:的)?(?:文字|文本)/.test(text)) return [];
    if (spec.key === "skew") return /(?:水平|垂直)斜切\s*-?\d/.test(text) ? ["layer.skew"] : [];
    if (spec.key === "rotate") {
      const documentRotation = semantics.documentAction === "document.rotate"
        || (!/(?:当前|选中|这个|该|指定).{0,10}(?:图层|层)/.test(text)
          && /(?:旋转|转动).{0,6}(?:画布|图像|图片|文档)|(?:画布|图像|图片|文档)(?:本身|整体)?\s*(?:旋转|转动)/.test(text));
      return documentRotation ? ["document.rotate"] : ["layer.rotate"];
    }
    if (spec.key === "selection") {
      if (/(?:矩形|椭圆)/.test(text)) {
        const geometry = expectedParamsFor(spec.key, text);
        const hasBounds = ["selectionLeft", "selectionTop", "selectionRight", "selectionBottom"]
          .every((name) => Number.isFinite(Number(geometry[name])));
        if (!hasBounds) return [];
        return /矩形/.test(text) ? ["selection.rectangle"] : ["selection.ellipse"];
      }
      if (/多边形/.test(text)) return ["selection.polygon"];
      if (/边界/.test(text)) return ["selection.border"];
      if (/(?:颜色)?容差/.test(text) && /(?:扩展|扩大)/.test(text)) return ["selection.grow"];
      if (/羽化/.test(text)) return ["selection.feather"];
      if (/(?:扩展|扩大)/.test(text)) return ["selection.expand"];
      if (/收缩/.test(text)) return ["selection.contract"];
      if (/平滑/.test(text)) return ["selection.smooth"];
      if (/(?:反选|反向选择)/.test(text)) return ["selection.invert"];
      if (/(?:取消选择|取消选取|取消(?:当前)?选区|清除(?:当前)?选区)/.test(text)) return ["selection.deselect"];
      if (/(?:选择|选中|选取).{0,24}(?:主体|主要人物)|(?:选主体|选择主体|选中主体|选取主体)/.test(text)) return ["selection.subject"];
      if (semantics.selectionAction === "selection.select_all") return ["selection.select_all"];
    }
    if (spec.key === "filter") {
      if (semantics.filter) return [semantics.filter.action];
      if (/高斯模糊/i.test(text)) return ["filter.gaussian_blur"];
      if (/动感模糊/i.test(text)) return ["filter.motion_blur"];
      if (/杂色/i.test(text)) return ["filter.add_noise"];
      if (/高反差保留/i.test(text)) return ["filter.high_pass"];
      if (/USM锐化/i.test(text)) return ["filter.unsharp_mask"];
      return ["filter.sharpen"];
    }
    if (spec.key === "color_adjustment") {
      if (/(?:自然饱和度)/.test(text)) return ["adjustment.vibrance"];
      if (/(?:去色|黑白)/.test(text)) return ["adjustment.hue_saturation", "adjustment.black_white"];
      const color = destinationColor(text);
      if (color) return color === "#808080"
        ? ["adjustment.hue_saturation", "adjustment.colorize"]
        : ["adjustment.colorize"];
      if (/(?:色相|饱和度|明度)/.test(text)) return ["adjustment.hue_saturation"];
      if (/(?:亮度|对比度)/.test(text)) return ["adjustment.brightness_contrast"];
      if (/曝光度/.test(text)) return ["adjustment.exposure"];
    }
    if (spec.key === "text_scale") {
      if (/(?:水平|横向)缩放/.test(text)) return ["text.set_horizontal_scale", "group.set_text_style"];
      if (/(?:垂直|纵向)缩放/.test(text)) return ["text.set_vertical_scale", "group.set_text_style"];
      return [];
    }
    if (spec.key === "text_style") {
      if (/连字符/.test(text)) return ["text.set_hyphenation", "group.set_text_style"];
      if (/(?:加粗|粗体)/.test(text)) return ["text.set_faux_bold", "group.set_text_style"];
      if (/斜体/.test(text)) return ["text.set_faux_italic", "group.set_text_style"];
      if (/(?:左对齐|右对齐|居中|中对齐|两端对齐)/.test(text)) return ["text.set_justification", "group.set_text_style"];
      return [];
    }
    if (spec.key === "text_spacing") {
      if (/行距/.test(text)) return ["text.set_leading", "group.set_text_style"];
      if (/字距/.test(text)) return ["text.set_tracking", "group.set_text_style"];
      if (/基线偏移/.test(text)) return ["text.set_baseline_shift", "group.set_text_style"];
      return ["text.set_paragraph_spacing", "group.set_text_style"];
    }
    if (spec.key === "align") return ["layer.align_to_reference"];
    if (spec.key === "fit") {
      if (semantics.fit) return [semantics.fit.action];
      if (/(?:组内|图层组)/.test(text)) return ["group.fit_text_to_reference"];
      if (/(?:文字|文本)/.test(text)) return ["text.fit_to_reference"];
      return ["layer.fit_to_reference"];
    }
    if (spec.key === "document_size") {
      const hasPair = /\d+(?:\.\d+)?\s*[×xX*]\s*\d+(?:\.\d+)?/.test(text);
      const hasWidth = /(?:宽度|宽)\s*(?:改为|改成|调整为|设为|设置为|到)?\s*\d/.test(text);
      const hasHeight = /(?:高度|高)\s*(?:改为|改成|调整为|设为|设置为|到)?\s*\d/.test(text);
      if (/画布/.test(text)) return hasPair || (hasWidth && hasHeight) ? ["document.resize_canvas"] : [];
      return hasPair || hasWidth || hasHeight ? ["document.resize_image"] : [];
    }
    if (spec.key === "document_crop") {
      if (/(?:透明|四周透明|透明像素)/.test(text)) return ["document.trim"];
      if (/(?:当前|已有|现有)?选区/.test(text)) return ["document.crop"];
      const hasAbsoluteBounds = /左\s*-?\d/.test(text) && /上\s*-?\d/.test(text)
        && /右\s*-?\d/.test(text) && /下\s*-?\d/.test(text);
      return hasAbsoluteBounds ? ["document.crop"] : [];
    }
    if (spec.key === "mask_create") {
      if (/(?:隐藏全部|全黑|黑色蒙版)/.test(text)) return ["mask.create_hide_all"];
      if (/(?:选区|抠出|抠图|提取主体|隐藏背景|去背景)/.test(text)) return ["mask.create_from_selection"];
      return ["mask.create_reveal_all"];
    }
    return [...spec.expectedActions];
  }

  function expectedTargetFor(spec, clause, expectedActions) {
    const text = String(clause || "");
    if ((expectedActions || []).every((action) => action.startsWith("document."))
      || ["create_group", "create_layer"].includes(spec.key)) {
      return { scopes: ["document"] };
    }
    if ((expectedActions || []).includes("selection.subject")) return { scopes: ["document"] };

    function layerTargetFrom(sourceValue) {
      const source = String(sourceValue || "");
      if (/^(?:把|将|给|对)?\s*(?:(?:当前|选中|已选|所选|这个|该)(?:图层)?组|(?:图层)?组)(?:里|中|内)(?:的)?(?:文字|文本)/.test(source)) {
        return { scopes: ["active_layer"] };
      }
      const groupTextTarget = source.match(/(?:把|将|给|对)?\s*[“"'‘]?([^，。；“”"'‘’]{1,30}?)[”"'’]?(?:图层)?组(?:里|中|内)(?:的)?(?:文字|文本)/);
      if (groupTextTarget) {
        const query = String(groupTextTarget[1] || "").trim();
        if (query && !/^(?:当前|选中|已选|所选|这个|该|所有|全部)$/.test(query)) return { scopes: ["layer_name"], query };
      }
      const explicitNamed = [
        /名为\s*[“"'‘]?(.{1,40}?)[”"'’]?(?:的)?(?:文字层|文本层|图层组|图层|层|组)/,
        /叫(?:做)?\s*[“"'‘]?(.{1,40}?)[”"'’]?(?:的)?(?:文字层|文本层|图层组|图层|层|组)/,
        /(?:文字层|文本层|图层组|图层|层|组)\s*[“"'‘]([^”"'’]{1,80})[”"'’]/,
        /[“"'‘]([^”"'’]{1,80})[”"'’]\s*(?:文字层|文本层|图层组|图层|层|组)/,
        /(?:图层|层)(?:名称|名字)(?:为|叫|是)\s*[“"'‘]?([^，。；”"'’]{1,80})/
      ];
      for (const pattern of explicitNamed) {
        const match = source.match(pattern);
        if (match && String(match[1] || "").trim()) return { scopes: ["layer_name"], query: String(match[1]).trim() };
      }
      if (/(?:当前)?(?:选中|已选|所选)(?:的)?(?:多个|这些|全部|所有)?(?:图层|层)/.test(source)) {
        return /(?:多个|这些|全部|所有)/.test(source)
          ? { scopes: ["active_layers"] }
          : { scopes: ["active_layer", "active_layers"] };
      }
      if (/(?:当前|现用|正在使用的|这个|该|原来的?|原始).{0,8}(?:图层|层)|(?:图层|层).{0,8}(?:当前|现用)/.test(source)) {
        return { scopes: ["active_layer"] };
      }
      if (/(?:当前|现用|这个|该).{0,8}(?:文字|文本|文字层|文本层|图层组|组)|(?:文字|文本|文字层|文本层|图层组|组).{0,8}(?:当前|现用)/.test(source)) {
        return { scopes: ["active_layer"] };
      }
      if (/(?:选中|所选).{0,8}(?:多个|这些|全部|所有).{0,8}(?:文字|文本|文字层|文本层|图层组|组)|(?:多个|这些|全部|所有).{0,8}(?:选中|所选).{0,8}(?:文字|文本|文字层|文本层|图层组|组)/.test(source)) {
        return { scopes: ["active_layers"] };
      }
      if (/(?:选中|所选).{0,8}(?:文字|文本|文字层|文本层|图层组|组)/.test(source)) {
        return { scopes: ["active_layer", "active_layers"] };
      }
      const actionNamed = source.match(/(?:隐藏|显示|删除|移除|锁定|解锁|移动|缩放|旋转|翻转|栅格化|转换)\s*(?:名为|叫(?:做)?)?\s*[“"'‘]?([^，。；”"'’]{1,30}?)[”"'’]?(?:图层组|图层|层)/);
      const bareName = actionNamed
        || source.match(/(?:把|将|给|对|为)\s*([^，。；“”"'‘’]{1,30}?)(?:图层组|图层|层)(?=.{0,24}(?:隐藏|显示|删除|移除|改|设|调|设置|锁定|解锁|移动|缩放|旋转|翻转|栅格化|转换|合并|放到|放入|移到|移入|拖到|添加|应用|进行|不透明度|透明度|混合模式|字号|字体|颜色|滤镜|模糊|锐化|杂色|亮度|对比度|曝光度))/)
        || source.match(/^([^，。；“”"'‘’]{1,30}?)(?:图层组|图层|层)(?=.{0,24}(?:隐藏|显示|删除|移除|改|设置|锁定|解锁|移动|缩放|旋转|翻转|栅格化|转换|合并|放到|放入|移到|移入|拖到))/);
      if (bareName) {
        const query = String(bareName[1]).trim();
        if (query && !/^(?:当前|选中|已选|所选|这个|该|原|所有|全部|图|文字|文本)$/.test(query)) return { scopes: ["layer_name"], query };
      }
      return null;
    }

    if (spec.key === "move_to_group") {
      const sourceClause = text.split(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)/)[0];
      const resolved = layerTargetFrom(sourceClause);
      if (resolved) return resolved;
      const bareSource = sourceClause.match(/(?:把|将)?\s*([^，。；“”"'‘’]{1,40}?)(?:图层组|图层|层)\s*$/);
      if (bareSource) {
        const query = String(bareSource[1]).trim();
        if (query && !/^(?:当前|选中|已选|所选|这个|该|原|所有|全部)$/.test(query)) return { scopes: ["layer_name"], query };
      }
      return { scopes: ["active_layer"] };
    }

    if (/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)/.test(text)) {
      const followParts = text.split(/(?:并且|然后|同时|并(?=(?:把|将|给|对|隐藏|显示|改|设|重命名)))/);
      const followUp = followParts.length > 1 ? followParts.slice(1).join("；") : "";
      const explicitFollowTarget = followUp ? layerTargetFrom(followUp) : null;
      if (explicitFollowTarget) return explicitFollowTarget;
      const sourceBeforeMove = text.split(/(?:放到|放入|放进|移到|移入|移进|移动到|拖到)/)[0];
      const sourceTarget = layerTargetFrom(sourceBeforeMove);
      if (sourceTarget) return sourceTarget;
    }

    if (!["duplicate", "create_group", "create_layer"].includes(spec.key)) {
      if (/^(?:把|将)?\s*(?:复制出的|拷贝出的|新复制的)?副本/.test(text)) return { scopes: ["operation_result"] };
      if (/(?:复制|拷贝)/.test(text)) {
        const parts = text.split(/(?:并且|并|然后|接着|随后)/);
        const followUp = parts.length > 1 ? parts.slice(1).join("；") : "";
        if (followUp) {
          const explicitOriginal = layerTargetFrom(followUp);
          if (explicitOriginal && /(?:原来的?|原始|当前).{0,8}(?:图层|层)/.test(followUp)) return explicitOriginal;
          if (/(?:副本|复制出的|拷贝出的|新复制的)/.test(followUp)
            || /^(?:把|将)?\s*(?:重命名|改名|不透明度|透明度|移动|缩放|旋转|翻转|模糊|锐化)/.test(followUp)) {
            return { scopes: ["operation_result"] };
          }
        }
      }
    }
    const resolved = layerTargetFrom(text);
    if (resolved) return resolved;
    if ((expectedActions || []).length && (expectedActions || []).every((action) => /^(?:layer|text|group|filter|mask)\./.test(action))) {
      return { scopes: ["active_layer"] };
    }
    return null;
  }

  function splitClauses(value) {
    const lines = String(value || "")
      .replace(/\r/g, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/^\s*\d+[.、)]\s*/, "").trim())
      .filter(Boolean);
    const source = lines.length ? lines : [normalizeText(value)];
    const clauses = [];
    const actionStart = "(?:把|将|给|对|向(?:左|右|上|下)|往(?:左|右|上|下)|顺时针|逆时针|水平|垂直|进一步|收缩|扩展|扩大|羽化|平滑|设置|修改|改|移动|旋转|翻转|重命名|创建|建立|新建|复制|隐藏|显示|删除|移除|导出|锐化|模糊|栅格化|转换|转为|合并|应用|锁定|解锁|反相|裁剪|裁切|设为|加粗|斜体|行距|字距|基线|不透明度|透明度|混合模式|字号|字体|蒙版|画布|图像)";
    for (const line of source) {
      const parts = line
        .split(new RegExp(`[；;。]+|[，,](?=\\s*(?:(?:但|但是|只|仅)\\s*)?${actionStart})|(?:然后|接着|随后|之后|以后|完成后|操作后|并且|同时|以及|但(?:是)?|只(?=${actionStart})|仅(?=${actionStart})|再(?=${actionStart})|后(?=${actionStart})|(?:并|且|和)(?=${actionStart}))`))
        .map((item) => item.replace(/^[，,\s]+|[，,\s]+$/g, "").trim())
        .filter(Boolean);
      for (const part of parts) {
        const previous = clauses[clauses.length - 1];
        if (previous && /(?:抠出|抠图|提取)(?:完整|整个|全身)?(?:人物|角色|商品|产品|主体)?/.test(previous)
          && /^(?:隐藏|去掉|移除|去)背景/.test(part)) {
          clauses[clauses.length - 1] = `${previous}并${part}`;
        } else if (previous && /(?:文字|文本|字号|字体|字型|行距|字距)/.test(previous)
          && /^(?:改成|改为|变成|换成|换为|设为|设成|设置为|设置成).{0,12}(?:#[0-9a-fA-F]{3,6}|红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?/.test(part)) {
          clauses[clauses.length - 1] = `${previous}并${part}`;
        } else if (previous && /(?:向|往)(?:左|右|上|下).{0,10}\d/.test(previous)
          && /^(?:向|往)(?:左|右|上|下).{0,10}\d/.test(part)) {
          clauses[clauses.length - 1] = `${previous}，${part}`;
        } else if (previous && /(?:保持|保留|不变|不要改|别动)/.test(previous)
          && /^(?:把|将)?其/.test(part)) {
          clauses[clauses.length - 1] = `${previous}并${part}`;
        } else {
          clauses.push(part);
        }
      }
    }
    return clauses;
  }

  function isNegatedNear(textValue, matchIndex) {
    if (!Number.isInteger(matchIndex) || matchIndex < 0) return false;
    const prefix = String(textValue || "").slice(Math.max(0, matchIndex - 32), matchIndex);
    const local = prefix.split(/(?:但|但是|只|仅|然后|接着|随后|并且|同时|以及)/).pop() || "";
    return /(?:不要|别|禁止|无需|不用|不需要|切勿|不可)\s*(?:把|将|给|对|为)?[^，。；]{0,24}$/.test(local);
  }

  function isInformationalRequest(value) {
    const text = String(value || "");
    const asksHow = /(?:如何|怎么|怎样|会怎么样|有什么影响|请告诉我|告诉我|我想了解|能否|是否可以|教程|方法)/.test(text);
    const questionOnly = /[？?]\s*$/.test(text) && !/(?:请|帮我|麻烦|直接|立即|马上|现在).{0,8}(?:执行|删除|移除|栅格化|拼合|合并|应用|转换)/.test(text);
    const explicitExecution = /(?:直接|立即|马上|现在).{0,8}(?:执行|删除|移除|栅格化|拼合|合并|应用|转换)|请(?:帮我)?\s*(?:删除|移除|栅格化|拼合|合并|应用|转换)/.test(text);
    return (asksHow || questionOnly) && !explicitExecution;
  }

  function isUnresolvedConditionalRequest(value) {
    const text = String(value || "");
    return /(?:如果|假如|倘若|若是|若|只有).{0,100}(?:才|就|再|然后)?|(?:为空|没问题|确认无误|确认没问题|检查通过).{0,30}(?:时才|才)/.test(text);
  }

  function maskLayerTargetPhrases(value) {
    const targetTail = "(?:的|中|内|里|上|隐藏|显示|设置|设为|改为|改成|调整|修改|重命名|移动|缩放|旋转|翻转|斜切|栅格化|转换|转为|合并|放到|放入|移到|锁定|解锁|删除|移除|添加|应用|进行|不透明度|透明度|填充|混合模式|字号|字体|颜色|滤镜|模糊|锐化|杂色|亮度|对比度|曝光度)";
    let masked = String(value || "");
    // Treat a noun phrase such as “拼合文档图层” or “删除图层” as data,
    // not as an executable verb hidden inside the layer name.
    masked = masked.replace(new RegExp(`((?:把|将|给|对|为)\\s*)(.{1,60}?(?:图层组|图层|层))(?=${targetTail})`, "g"), "$1__LAYER_TARGET__");
    masked = masked.replace(new RegExp(`^((?:隐藏|显示|设置|调整|修改|模糊|锐化|锁定|解锁)\\s*)(.{1,60}?(?:图层组|图层|层))(?=$|${targetTail})`, "g"), "$1__LAYER_TARGET__");
    masked = masked.replace(new RegExp(`^(?!(?:选择|选中|选取|载入|加载))(.{1,60}?(?:图层组|图层|层))(?=${targetTail})`), "__LAYER_TARGET__");
    return masked;
  }

  function maskInstructionLiteralValues(value) {
    const text = String(value || "");
    let masked = text.replace(/[“"'‘]([^”"'’]{0,240})[”"'’]/g, (whole, content) => {
      MODIFICATION_WORDS.lastIndex = 0;
      const dangerous = MODIFICATION_WORDS.test(String(content || "")) || RULES.some((item) => {
        item.pattern.lastIndex = 0;
        const matched = item.pattern.test(String(content || ""));
        item.pattern.lastIndex = 0;
        return matched;
      });
      MODIFICATION_WORDS.lastIndex = 0;
      return dangerous ? "__LITERAL_VALUE__" : whole;
    });
    const hasLiteralAssignment = /(?:重命名|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为|文字内容|文本内容|名为|叫(?:做)?|名称为|内容(?:为|是|[：:])|文字(?:为|是)|文本(?:为|是)|写上|写入|输入)|(?:把|将)?[^，。；]{0,12}(?:文字|文本)(?:内容)?\s*(?:改为|改成|替换为|换成|设成|设置为)/.test(text);
    if (!hasLiteralAssignment) return maskLayerTargetPhrases(masked);
    masked = masked.replace(/[“"'‘][^”"'’]{0,240}[”"'’]/g, "__LITERAL_VALUE__");
    const connector = "(?=$|[，。；]|并且|然后|同时|并(?=(?:把|将|给|对|隐藏|显示|改|设|重命名|删除|栅格化|导出|锁定|解锁)))";
    masked = masked.replace(new RegExp(`((?:重命名(?:为|成)?|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)\\s*)([^，。；]{1,200}?)${connector}`, "g"), "$1__LITERAL_VALUE__");
    masked = masked.replace(/((?:名为|叫做|名称为)\s*)([^，。；]{1,120}?)(?=(?:的)?(?:文字层|文本层|图层组|图层|层|组))/g, "$1__LITERAL_VALUE__");
    masked = masked.replace(/((?:内容为|内容是|文字为|文字是|文本为|文本是)\s*)([^，。；]{1,200}?)(?=(?:的)?(?:文字|文本)?(?:图层|层)|$|[，。；])/g, "$1__LITERAL_VALUE__");
    masked = masked.replace(new RegExp(`((?:文字内容|文本内容)\\s*(?:改为|改成|替换为|换成|设成|设置为)\\s*)([^，。；]{1,200}?)${connector}`, "g"), "$1__LITERAL_VALUE__");
    masked = masked.replace(new RegExp(`((?:把|将)?[^，。；]{0,12}(?:文字|文本)(?:内容)?\\s*(?:改为|改成|替换为|换成|设成|设置为)\\s*)([^，。；]{1,200}?)${connector}`, "g"), (whole, prefix, literal) => {
      if (/^(?:(?:#[0-9a-fA-F]{3,6}|红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?|横排|竖排|横版|竖版|加粗|粗体|斜体|左对齐|右对齐|居中|中对齐|两端对齐)$/.test(String(literal || "").trim())) return whole;
      return `${prefix}__LITERAL_VALUE__`;
    });
    return maskLayerTargetPhrases(masked);
  }

  function detectSpecs(clause) {
    const specs = [];
    if (isInformationalRequest(clause)) return specs;
    const semantics = analyzeInstructionClause(clause);
    const hasFillOpacity = /填充(?:不透明度|透明度)/.test(clause);
    const hasTextContext = /(?:文字|文本|字体|字号|字型)/.test(clause);
    const maskedClause = maskInstructionLiteralValues(clause);
    const conditionalHighRiskKeys = new Set([
      "delete", "flatten", "merge_visible", "mask_delete", "mask_apply",
      "rasterize", "convert_smart_object", "merge_down", "document_crop"
    ]);
    for (const item of RULES) {
      if (conditionalHighRiskKeys.has(item.key) && isUnresolvedConditionalRequest(clause)) continue;
      if (item.key === "opacity" && hasFillOpacity) continue;
      if (item.key === "scale" && semantics.fit) continue;
      if (item.key === "scale" && hasTextContext && /(?:水平|垂直|横向|纵向)缩放/.test(clause)) continue;
      if (item.key === "text_size" && semantics.baselineShift != null && !/(?:字号|文字大小|字体大小)/.test(clause)) continue;
      if (item.key === "visibility" && /显示全部内容|显示画布外|扩展画布/.test(clause)) continue;
      if (item.key === "visibility" && /蒙版/.test(clause)) continue;
      if (item.key === "text_style" && /(?:对齐|居中).{0,20}(?:画布|选区)|(?:画布|选区).{0,20}(?:对齐|居中)/.test(clause)) continue;
      if (item.key === "visibility" && /(?:隐藏|去掉|移除|去)背景/.test(clause)
        && (/(?:抠出|抠图|提取|去背景)/.test(clause) || !/背景(?:图层|层)/.test(clause))) continue;
      if (["document_size", "document_crop", "export"].includes(item.key) && /(?:图层组|图层|层|素材组)/.test(clause)) continue;
      if (item.key === "create_layer" && /图层组/.test(clause)) continue;
      if (item.key === "delete" && /蒙版/.test(clause)) continue;
      if (item.key === "delete" && /图层(?:里|中|内|上(?:的)?)/.test(clause)) continue;
      if (item.key.startsWith("mask_") && /剪贴蒙版/.test(clause)) continue;
      if (item.key === "text_content") {
        const textChange = clause.match(/(?:把|将).{0,12}(?:文字|文本)([^，。；]{0,12}?)(?:改为|改成|替换为|换成|设成|设置为)\s*([^，。；]{0,20})/);
        const propertyBeforeVerb = textChange && /(?:^|的)(?:字号|大小|颜色|字体|字型|行距|字距|方向|水平缩放|垂直缩放|横向缩放|纵向缩放|横排|竖排|横版|竖版|粗体|斜体|对齐|缩进|段前|段后|基线)/.test(textChange[1]);
        const styleValueAfterVerb = textChange && /^(?:(?:-?\d+(?:\.\d+)?\s*(?:号字|pt|点|磅))|[^，。；]{1,80}(?:字体|字型)|横排|竖排|横版|竖版|粗体|斜体|左对齐|右对齐|居中|两端对齐|#[0-9a-fA-F]{3,6}|红色?|蓝色?|绿色?|黄色?|黑色?|白色?|灰色?|紫色?|橙色?|粉色?)(?:$|[，。；\s])/.test(textChange[2]);
        if (!/(?:文字内容|文本内容)/.test(clause) && (propertyBeforeVerb || styleValueAfterVerb)) continue;
      }
      const ruleText = ["rename", "text_content", "text_font", "text_size", "create_layer", "create_group"].includes(item.key) ? clause : maskedClause;
      const candidate = item.key === "color_adjustment"
        ? ruleText.replace(/(?:填充)?(?:不透明度|透明度)/g, "")
        : ruleText;
      const matchIndex = candidate.search(item.pattern);
      item.pattern.lastIndex = 0;
      if (matchIndex >= 0 && isNegatedNear(candidate, matchIndex)) continue;
      if (item.key === "color_adjustment" && hasTextContext && item.pattern.test(candidate)) {
        item.pattern.lastIndex = 0;
        continue;
      }
      if (item.key === "color_adjustment" && /(?:图层)?颜色(?:标签|标记)|图层标记/.test(clause)) {
        item.pattern.lastIndex = 0;
        continue;
      }
      if (item.pattern.test(candidate)) specs.push(item);
      item.pattern.lastIndex = 0;
    }
    if (hasTextContext && /颜色\s*(?:为|是|改为|改成|设为|设成|设置为|设置成)?\s*(?:#[0-9a-fA-F]{3,6}|红|蓝|绿|黄|黑|白|灰|紫|橙|粉)(?:色)?/.test(clause)
      && !specs.some((item) => item.key === "text_color")) {
      const textColorRule = RULES.find((item) => item.key === "text_color");
      if (textColorRule) specs.push(textColorRule);
    }
    const semanticKeys = [];
    if (semantics.globalColorReplacement) semanticKeys.push("color_adjustment");
    if (semantics.createdLayer) semanticKeys.push("create_layer");
    if (semantics.filter) semanticKeys.push("filter");
    if (semantics.selectionAction === "selection.select_all") semanticKeys.push("selection");
    if (semantics.documentAction === "document.reveal_all") semanticKeys.push("document_reveal");
    if (semantics.documentAction === "document.rotate") semanticKeys.push("rotate");
    if (semantics.fit) semanticKeys.push("fit");
    if (semantics.baselineShift != null) semanticKeys.push("text_spacing");
    for (const key of semanticKeys) {
      if (specs.some((item) => item.key === key)) continue;
      const spec = RULES.find((item) => item.key === key);
      if (spec) specs.push(spec);
    }
    return specs;
  }

  function buildRequirements(instruction) {
    const clauses = splitClauses(instruction);
    const requirements = [];
    let inheritedLayerTarget = null;
    let inheritedOperationResult = false;
    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      const clause = clauses[clauseIndex];
      const specs = detectSpecs(clause);
      const seen = new Set();
      const explicitClauseTarget = /(?:当前|现用|这个|该|选中|所选|原来的?|原始|新建的|刚创建的).{0,12}(?:图层|层|文字|文本|组)?|^(?:把|将)?\s*(?:复制出的|拷贝出的|新复制的)?副本(?:图层|层)?|(?:名为|叫做?).{1,30}(?:图层|层|组)|(?:图层|文字层|文本层|图层组|组内|组中)/.test(clause);
      for (const spec of specs) {
        if (seen.has(spec.key)) continue;
        seen.add(spec.key);
        const expectedActions = expectedActionsFor(spec, clause);
        let expectedTarget = expectedTargetFor(spec, clause, expectedActions);
        const explicitTargetWording = /(?:当前|现用|这个|该|选中|所选|名为|叫做?|图层|文字层|文本层|图层组|组内|组中)/.test(clause);
        if (inheritedLayerTarget && !explicitTargetWording && expectedTarget
          && expectedTarget.scopes.length === 1 && expectedTarget.scopes[0] === "active_layer") {
          expectedTarget = { ...inheritedLayerTarget, scopes: [...inheritedLayerTarget.scopes] };
        }
        if (inheritedOperationResult && !explicitClauseTarget && expectedTarget
          && expectedTarget.scopes.length === 1 && expectedTarget.scopes[0] === "active_layer") {
          expectedTarget = { scopes: ["operation_result"] };
        }
        requirements.push({
          id: `req_${requirements.length + 1}`,
          key: spec.key,
          label: spec.label,
          text: clause,
          clauseIndex,
          expectedActions,
          expectedParams: expectedParamsFor(spec.key, clause),
          expectedTarget
        });
        if (expectedTarget && (expectedTarget.query != null || explicitTargetWording)
          && !expectedTarget.scopes.includes("document") && !expectedTarget.scopes.includes("operation_result")) {
          inheritedLayerTarget = { ...expectedTarget, scopes: [...expectedTarget.scopes] };
        }
      }
      const genericIndex = clause.search(MODIFICATION_WORDS);
      if (!specs.length && genericIndex >= 0 && !isNegatedNear(clause, genericIndex) && !isInformationalRequest(clause)) {
        requirements.push({
          id: `req_${requirements.length + 1}`,
          key: "generic_modification",
          label: "完成用户描述的修改",
          text: clause,
          clauseIndex,
          expectedActions: []
        });
      }
      if (specs.some((spec) => ["duplicate", "create_group", "create_layer"].includes(spec.key))) inheritedOperationResult = true;
      else if (explicitClauseTarget && !/(?:副本|复制出的|新建的|刚创建的)/.test(clause)) inheritedOperationResult = false;
    }
    return requirements;
  }

  function actionMatches(action, pattern) {
    if (pattern.endsWith(".*")) return action.startsWith(pattern.slice(0, -1));
    return action === pattern;
  }

  const SUPPORTING_ACTIONS = Object.freeze({
    color_adjustment: ["selection.*", "mask.create_from_selection"],
    filter: ["selection.*", "mask.create_from_selection"],
    cutout: ["selection.*", "mask.create_from_selection", "layer.duplicate", "layer.set_visibility"],
    mask_create: ["selection.*"]
  });

  const EXPLICIT_HIGH_RISK = Object.freeze({
    "document.flatten": /(?:拼合|扁平化).{0,12}(?:图像|文档|PSD)|(?:图像|文档|PSD).{0,12}(?:拼合|扁平化)/,
    "document.merge_visible": /合并.{0,8}可见.{0,8}图层|合并可见图层/,
    "layer.delete": /(?:删除|移除).{0,20}(?:图层组|图层(?!蒙版))|(?:图层组|图层(?!蒙版)).{0,20}(?:删除|移除)/,
    "mask.delete": /(?:删除|移除).{0,16}(?:图层)?蒙版|(?:图层)?蒙版.{0,16}(?:删除|移除)/,
    "mask.apply": /(?:应用|合并).{0,16}(?:图层)?蒙版|(?:图层)?蒙版.{0,16}(?:应用|合并)/,
    "layer.merge_down": /(?:向下合并|与下方图层合并|合并到下方图层|合并当前图层和下方图层)/,
    "layer.rasterize": /栅格化/,
    "layer.convert_to_smart_object": /(?:转换(?:成|为)?|转为|变为|变成).{0,12}智能对象|智能对象.{0,12}(?:转换(?:成|为)?|转为|变为|变成)/
  });

  function requirementAllowsAction(requirement, action) {
    const direct = requirement.expectedActions || [];
    const supporting = SUPPORTING_ACTIONS[requirement.key] || [];
    if (String(action || "").startsWith("selection.")) {
      if (direct.some((expected) => expected !== "selection.*" && actionMatches(action, expected))) return true;
      if (![...direct, ...supporting].includes("selection.*")) return false;
      const text = String(requirement.text || "");
      if (action === "selection.rectangle") return /矩形/.test(text);
      if (action === "selection.ellipse") return /椭圆/.test(text);
      if (action === "selection.polygon") return /多边形/.test(text);
      if (action === "selection.load_layer") return /(?:载入|加载|读取).{0,16}(?:图层|透明区域)|(?:图层|透明区域).{0,16}(?:载入|加载|读取)|(?:当前|选中|指定|名为|叫(?:做)?|把|将|给|对).{0,30}(?:图层|层).{0,24}(?:亮度|对比度|曝光度|色相|饱和度|明度|改色|换色|上色|去色|黑白|灰色|改成|改为|换成|变成)/.test(text);
      if (action === "selection.subject") return /(?:完整|整个|全身|整体|前景)?(?:主体|主要人物)|(?:背景|主体以外|人物以外|角色以外|前景以外)|(?:抠出|抠图|提取).{0,12}(?:人物|角色|商品|产品)/.test(text);
      if (action === "selection.subject_region") return /(?:主体|主要人物).{0,20}(?:区域|范围)|(?:区域|范围).{0,20}(?:主体|主要人物)/.test(text);
      if (action === "selection.visual_object") return hasConcreteVisualTarget(text);
      if (action === "selection.color_range") return /(?:颜色范围|同色|相同颜色|色块|像素|选择.{0,12}(?:红|蓝|绿|黄|黑|白|灰|紫|橙|粉)|#[0-9a-fA-F]{3,6})/.test(text);
      if (action === "selection.expand") return /(?:扩展|扩大)/.test(text) && !/(?:颜色)?容差/.test(text);
      if (action === "selection.contract") return /收缩/.test(text);
      if (action === "selection.feather") return /羽化/.test(text);
      if (action === "selection.smooth") return /平滑/.test(text);
      if (action === "selection.border") return /边界/.test(text);
      if (action === "selection.grow") return /(?:颜色)?容差/.test(text) && /(?:扩展|扩大)/.test(text);
      if (action === "selection.invert") return /(?:反选|反向选择|反相)|(?:背景|主体以外|人物以外|角色以外|前景以外)/.test(text);
      if (action === "selection.deselect") return /(?:取消选择|取消选取|取消|清除)(?:当前)?选区|清除(?:当前)?选区/.test(text);
      if (action === "selection.select_all") return /(?:全选|选择全部|整个画布|整个文档)/.test(text);
      return false;
    }
    return [...direct, ...supporting].some((expected) => actionMatches(action, expected));
  }

  function hasExplicitHighRiskAuthorization(requirements, operation) {
    const pattern = EXPLICIT_HIGH_RISK[operation.action];
    if (!pattern) return true;
    const sourceRule = RULES.find((item) => (item.expectedActions || []).some((expected) => actionMatches(operation.action, expected)));
    if (!sourceRule) return false;
    return requirements.some((requirement) => {
      const rawText = String(requirement.text || "");
      if (isInformationalRequest(rawText) || isUnresolvedConditionalRequest(rawText)) return false;
      if (!(requirement.expectedActions || []).some((expected) => actionMatches(operation.action, expected))) return false;
      const text = maskInstructionLiteralValues(rawText);
      if (operation.action === "layer.delete" && /蒙版|图层(?:里|中|内|上(?:的)?)/.test(text)) return false;
      sourceRule.pattern.lastIndex = 0;
      const matchIndex = text.search(sourceRule.pattern);
      sourceRule.pattern.lastIndex = 0;
      return matchIndex >= 0 && !isNegatedNear(text, matchIndex);
    });
  }

  const GROUP_TEXT_PARAM_REQUIREMENTS = Object.freeze({
    size: ["text_size"],
    color: ["text_color"],
    font: ["text_font"],
    leading: ["text_spacing"],
    tracking: ["text_spacing"],
    baselineShift: ["text_spacing"],
    firstLineIndent: ["text_spacing"],
    leftIndent: ["text_spacing"],
    rightIndent: ["text_spacing"],
    spaceBefore: ["text_spacing"],
    spaceAfter: ["text_spacing"],
    justification: ["text_style"],
    fauxBold: ["text_style"],
    fauxItalic: ["text_style"],
    hyphenation: ["text_style"],
    horizontalScale: ["text_scale"],
    verticalScale: ["text_scale"],
    orientation: ["text_orientation"]
  });

  function parameterAuthorizationErrors(requirements, operation) {
    const linked = Array.isArray(requirements) ? requirements : [];
    const keys = new Set(linked.map((item) => item.key));
    const text = linked.map((item) => String(item.text || "")).join("；");
    const params = operation && operation.params || {};
    const errors = [];
    const action = String(operation && operation.action || "");
    const expectedParamSets = linked.map((item) => item.expectedParams || {});
    const expectedTargets = linked.map((item) => item.expectedTarget).filter(Boolean);

    function expectedValues(name) {
      return expectedParamSets.filter((item) => Object.prototype.hasOwnProperty.call(item, name)).map((item) => item[name]);
    }

    function verifyExpectedNumber(name, actual, label) {
      const values = expectedValues(name);
      if (!values.length) return;
      if (!Number.isFinite(Number(actual)) || values.some((value) => Math.abs(Number(actual) - Number(value)) > 0.01)) {
        errors.push(`${label}=${actual}与用户指定的${values.join("/")}不一致`);
      }
    }

    function verifyExpectedOrNeutral(name, actual, neutral, label) {
      const values = expectedValues(name);
      if (values.length) {
        verifyExpectedNumber(name, actual, label);
        return;
      }
      const effective = actual == null ? neutral : Number(actual);
      if (!Number.isFinite(effective) || Math.abs(effective - neutral) > 0.01) {
        errors.push(`${label}=${actual}不是用户要求，未授权值必须保持${neutral}`);
      }
    }

    function verifyExpectedString(name, actual, label, normalize = (value) => String(value == null ? "" : value).trim()) {
      const values = expectedValues(name).map(normalize);
      if (!values.length) return;
      const normalized = normalize(actual);
      if (!normalized || values.some((value) => normalized !== value)) {
        errors.push(`${label}${actual == null ? "为空" : `“${actual}”`}与用户指定的${values.join("/")}不一致`);
      }
    }

    function verifyExpectedColor(actual) {
      const values = expectedValues("color").map(normalizeExpectedColor).filter(Boolean);
      if (!values.length) return;
      const normalized = normalizeExpectedColor(actual);
      if (!normalized || values.some((value) => normalized !== value)) {
        errors.push(`颜色${actual}与用户指定的${values.join("/")}不一致`);
      }
    }

    const targetSensitiveAction = /^(?:layer|text|group|filter|mask)\./.test(action) || action === "selection.load_layer"
      || (action.startsWith("document.") && expectedTargets.some((item) => item.scopes.includes("document")));
    if (expectedTargets.length && targetSensitiveAction) {
      const target = operation && operation.target || {};
      for (const expectedTarget of expectedTargets) {
        if (!expectedTarget.scopes.includes(target.scope)) {
          errors.push(`目标范围${target.scope || "空"}与用户指定的${expectedTarget.scopes.join("/")}不一致`);
          continue;
        }
        if (expectedTarget.query != null && String(target.query || "").trim() !== expectedTarget.query) {
          errors.push(`目标图层“${target.query || ""}”与用户指定的“${expectedTarget.query}”不一致`);
        }
      }
    }

    if (action === "layer.set_visibility") {
      if (params.visible === true && !/(?:显示|设为可见|恢复可见|取消隐藏)/.test(text)) errors.push("visible=true没有‘显示/可见’授权");
      if (params.visible === false && !/(?:隐藏|不可见|设为不可见)/.test(text) && !keys.has("cutout")) errors.push("visible=false没有‘隐藏/不可见/抠图’授权");
      verifyExpectedString("visible", params.visible, "可见状态", (value) => String(Boolean(value)));
    }
    if (action === "layer.set_lock") {
      if (params.locked === true && !/(?:^|[^解])锁定|加锁/.test(text)) errors.push("locked=true没有‘锁定’授权");
      if (params.locked === false && !/(?:解锁|取消锁定|解除锁定)/.test(text)) errors.push("locked=false没有‘解锁’授权");
      verifyExpectedString("locked", params.locked, "锁定状态", (value) => String(Boolean(value)));
    }
    if (action === "layer.create_group") verifyExpectedString("name", params.name, "图层组名称");
    if (action === "layer.create_pixel") verifyExpectedString("name", params.name, "新图层名称");
    if (action === "text.create") {
      verifyExpectedString("name", params.name, "新文字层名称");
      verifyExpectedString("content", params.content, "新文字内容");
      const defaults = actionDefaults("text.create");
      if (!expectedValues("name").length && String(params.name || defaults.name) !== defaults.name) errors.push("用户未指定新文字层名称，不能擅自命名");
      if (!expectedValues("content").length && String(params.content == null ? defaults.content : params.content) !== defaults.content) errors.push("用户未指定文字内容，不能擅自生成文案");
      const numericStyle = new Set(["size", "leading", "tracking", "horizontalScale", "verticalScale", "baselineShift", "firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"]);
      const booleanStyle = new Set(["fauxBold", "fauxItalic", "hyphenation"]);
      for (const param of Object.keys(GROUP_TEXT_PARAM_REQUIREMENTS)) {
        const values = expectedValues(param);
        if (params[param] != null && !values.length) errors.push(`新文字参数${param}没有对应的用户需求`);
        if (values.length && params[param] == null) errors.push(`新文字缺少用户要求的参数${param}`);
        if (params[param] == null || !values.length) continue;
        if (param === "color") verifyExpectedColor(params[param]);
        else if (numericStyle.has(param)) verifyExpectedNumber(param, params[param], `新文字${param}`);
        else if (booleanStyle.has(param)) verifyExpectedString(param, params[param], `新文字${param}`, (value) => String(Boolean(value)));
        else verifyExpectedString(param, params[param], `新文字${param}`);
      }
    }
    if (action === "layer.set_blend_mode") verifyExpectedString("blendMode", params.blendMode, "混合模式");
    if (action === "layer.set_lock") verifyExpectedString("lock", params.lock, "锁定类型");
    if (action === "layer.flip") verifyExpectedString("axis", params.axis, "翻转方向");
    if (action === "layer.reorder") verifyExpectedString("position", params.position, "图层顺序");
    if (action === "layer.set_clipping_mask") {
      if (params.enabled === true && !/(?:创建|建立|添加|设为|启用).{0,10}剪贴蒙版|剪贴蒙版.{0,10}(?:创建|建立|添加|设为|启用)/.test(text)) errors.push("enabled=true没有创建剪贴蒙版授权");
      if (params.enabled === false && !/(?:取消|释放|解除|停用).{0,10}剪贴蒙版|剪贴蒙版.{0,10}(?:取消|释放|解除|停用)/.test(text)) errors.push("enabled=false没有取消剪贴蒙版授权");
    }
    if (action === "group.set_text_style") {
      for (const [param, allowedRequirementKeys] of Object.entries(GROUP_TEXT_PARAM_REQUIREMENTS)) {
        if (params[param] == null) continue;
        if (!allowedRequirementKeys.some((key) => keys.has(key)) || !expectedValues(param).length) {
          errors.push(`文字组参数${param}没有对应的用户需求`);
        }
      }
      if (params.fauxBold != null) verifyExpectedString("fauxBold", params.fauxBold, "组内粗体开关", (value) => String(Boolean(value)));
      if (params.fauxItalic != null) verifyExpectedString("fauxItalic", params.fauxItalic, "组内斜体开关", (value) => String(Boolean(value)));
      for (const param of Object.keys(GROUP_TEXT_PARAM_REQUIREMENTS)) {
        if (expectedValues(param).length && params[param] == null) errors.push(`文字组缺少用户要求的参数${param}`);
      }
    }
    if (["adjustment.colorize", "text.set_color", "group.set_text_style"].includes(action) && (params.color != null || expectedValues("color").length)) {
      verifyExpectedColor(params.color);
    }
    if (action === "adjustment.colorize") {
      verifyExpectedOrNeutral("opacity", params.opacity, 100, "颜色化不透明度");
      verifyExpectedString("colorizeBlendMode", params.blendMode || "normal", "颜色化混合模式", (value) => String(value || "normal").toLowerCase());
    }
    if (action === "layer.set_opacity") verifyExpectedNumber("opacity", params.opacity, "不透明度");
    if (action === "layer.set_fill_opacity") verifyExpectedNumber("fillOpacity", params.fillOpacity, "填充不透明度");
    if (action === "layer.move_by") {
      verifyExpectedNumber("deltaX", params.deltaX, "水平移动量");
      verifyExpectedNumber("deltaY", params.deltaY, "垂直移动量");
    }
    if (action === "layer.scale") {
      verifyExpectedNumber("scaleX", params.scaleX, "水平缩放");
      verifyExpectedNumber("scaleY", params.scaleY, "垂直缩放");
    }
    if (["layer.rotate", "document.rotate"].includes(action)) verifyExpectedNumber("angle", params.angle, "旋转角度");
    if (action === "layer.rotate") verifyExpectedString("anchor", params.anchor || "middle_center", "旋转锚点");
    if (action === "layer.skew") {
      verifyExpectedNumber("angleH", params.angleH, "水平斜切角度");
      verifyExpectedNumber("angleV", params.angleV, "垂直斜切角度");
    }
    if (action === "layer.rasterize") {
      verifyExpectedString("rasterizeTarget", params.target || "entire_layer", "栅格化范围", (value) => {
        const normalized = String(value || "entire_layer");
        return normalized === "smart_object" ? "entire_layer" : normalized;
      });
    }
    if (["text.set_size", "group.set_text_style"].includes(action) && params.size != null) verifyExpectedNumber("size", params.size, "字号");
    if (["text.set_font", "group.set_text_style"].includes(action) && params.font != null) verifyExpectedString("font", params.font, "字体");
    if (["text.set_orientation", "group.set_text_style", "group.fit_text_to_reference"].includes(action) && params.orientation != null) verifyExpectedString("orientation", params.orientation, "文字方向");
    if (action === "text.set_horizontal_scale") verifyExpectedNumber("horizontalScale", params.scale, "文字水平缩放");
    if (action === "text.set_vertical_scale") verifyExpectedNumber("verticalScale", params.scale, "文字垂直缩放");
    if (action === "text.set_justification") verifyExpectedString("justification", params.justification, "文字对齐");
    if (action === "text.set_hyphenation") verifyExpectedString("hyphenation", params.enabled, "连字符开关", (value) => String(Boolean(value)));
    if (action === "text.set_faux_bold") verifyExpectedString("fauxBold", params.enabled, "文字加粗状态", (value) => String(Boolean(value)));
    if (action === "text.set_faux_italic") verifyExpectedString("fauxItalic", params.enabled, "文字斜体状态", (value) => String(Boolean(value)));
    if (action === "group.set_text_style") {
      if (params.horizontalScale != null) verifyExpectedNumber("horizontalScale", params.horizontalScale, "组内文字水平缩放");
      if (params.verticalScale != null) verifyExpectedNumber("verticalScale", params.verticalScale, "组内文字垂直缩放");
      if (params.justification != null) verifyExpectedString("justification", params.justification, "组内文字对齐");
      if (params.hyphenation != null) verifyExpectedString("hyphenation", params.hyphenation, "组内连字符开关", (value) => String(Boolean(value)));
    }
    if (["text.set_leading", "group.set_text_style"].includes(action) && params.leading != null) verifyExpectedNumber("leading", params.leading, "行距");
    if (["text.set_tracking", "group.set_text_style"].includes(action) && params.tracking != null) verifyExpectedNumber("tracking", params.tracking, "字距");
    if (["text.set_baseline_shift", "group.set_text_style"].includes(action) && params.baselineShift != null) verifyExpectedNumber("baselineShift", params.baselineShift, "基线偏移");
    if (["text.set_paragraph_spacing", "group.set_text_style"].includes(action)) {
      for (const [name, label] of [["firstLineIndent", "首行缩进"], ["leftIndent", "左缩进"], ["rightIndent", "右缩进"], ["spaceBefore", "段前间距"], ["spaceAfter", "段后间距"]]) {
        if (action === "text.set_paragraph_spacing") {
          if (expectedValues(name).length && params[name] == null) errors.push(`${label}缺少用户指定的值`);
          else if (!expectedValues(name).length && params[name] != null) errors.push(`${label}没有获得用户授权`);
          else if (params[name] != null) verifyExpectedNumber(name, params[name], label);
        } else if (params[name] != null) verifyExpectedNumber(name, params[name], label);
      }
    }
    if (action === "adjustment.hue_saturation") {
      verifyExpectedOrNeutral("hue", params.hue, 0, "色相");
      verifyExpectedOrNeutral("saturation", params.saturation, 0, "饱和度");
      verifyExpectedOrNeutral("lightness", params.lightness, 0, "明度");
    }
    if (action === "adjustment.brightness_contrast") {
      verifyExpectedOrNeutral("brightness", params.brightness, 0, "亮度");
      verifyExpectedOrNeutral("contrast", params.contrast, 0, "对比度");
    }
    if (action === "adjustment.exposure") {
      verifyExpectedOrNeutral("exposure", params.exposure, 0, "曝光度");
      verifyExpectedOrNeutral("offset", params.offset, 0, "曝光偏移");
      verifyExpectedOrNeutral("gamma", params.gamma, 1, "曝光伽马");
    }
    if (action === "adjustment.vibrance") {
      verifyExpectedOrNeutral("vibrance", params.vibrance, 0, "自然饱和度");
      verifyExpectedOrNeutral("saturation", params.saturation, 0, "饱和度");
    }
    if (action === "adjustment.black_white") {
      for (const [name, fallback] of Object.entries({ red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 })) {
        verifyExpectedOrNeutral(name, params[name], fallback, `黑白转换${name}`);
      }
    }
    if (["filter.gaussian_blur", "filter.high_pass", "filter.unsharp_mask"].includes(action) && params.radius != null) verifyExpectedNumber("radius", params.radius, "滤镜半径");
    if (action === "filter.motion_blur") {
      verifyExpectedNumber("distance", params.distance, "动感模糊距离");
      verifyExpectedNumber("motionAngle", params.angle, "动感模糊角度");
    }
    if (action === "filter.add_noise" && params.amount != null) verifyExpectedNumber("amount", params.amount, "杂色数量");
    if (action.startsWith("filter.")) verifyExpectedString("filterUseSelection", params.useSelection === true, "滤镜选区范围", (value) => String(Boolean(value)));
    if (action === "filter.add_noise") {
      verifyExpectedString("noiseDistribution", params.distribution || "uniform", "杂色分布");
      if (expectedValues("noiseMonochromatic").length) verifyExpectedString("noiseMonochromatic", params.monochromatic, "单色杂色", (value) => String(Boolean(value)));
    }
    if (action === "filter.unsharp_mask") {
      verifyExpectedNumber("unsharpAmount", params.amount, "USM锐化数量");
      verifyExpectedNumber("unsharpRadius", params.radius, "USM锐化半径");
      verifyExpectedNumber("unsharpThreshold", params.threshold, "USM锐化阈值");
    }
    if (["selection.feather", "selection.expand", "selection.contract"].includes(action)) verifyExpectedNumber("selectionAmount", params.by, "选区修改量");
    if (["selection.feather", "selection.expand", "selection.contract", "selection.smooth"].includes(action)) {
      verifyExpectedString("selectionApplyAtCanvasBounds", params.applyAtCanvasBounds === true, "选区画布边缘开关", (value) => String(Boolean(value)));
    }
    if (action === "selection.smooth") verifyExpectedNumber("selectionAmount", params.radius, "选区平滑半径");
    if (action === "selection.border") verifyExpectedNumber("borderWidth", params.width, "选区边界宽度");
    if (action === "selection.grow") {
      verifyExpectedNumber("growTolerance", params.tolerance, "选区颜色容差");
      verifyExpectedString("selectionGrowAntiAlias", params.antiAlias !== false, "选区颜色扩展抗锯齿", (value) => String(Boolean(value)));
    }
    if (action === "selection.color_range") {
      if (expectedValues("selectionColor").length) {
        const expectedColors = expectedValues("selectionColor").map(normalizeExpectedColor).filter(Boolean);
        const actualColor = normalizeExpectedColor(params.color);
        if (!actualColor || expectedColors.some((value) => value !== actualColor)) errors.push(`颜色范围${params.color}与用户指定的${expectedColors.join("/")}不一致`);
      }
      verifyExpectedNumber("selectionTolerance", params.tolerance, "颜色范围容差");
      verifyExpectedOrNeutral("selectionSoftness", params.softness, actionDefaults("selection.color_range").softness, "颜色范围边缘柔和度");
    }
    if (action === "selection.visual_object") {
      let expectedContract = null;
      let actualContract = null;
      if (!protocol
        || typeof protocol.buildUserVisualContract !== "function"
        || typeof protocol.buildPlannedVisualContract !== "function"
        || typeof protocol.auditVisualContract !== "function") {
        errors.push("视觉语义合同审核不可用");
      } else {
        try {
          // buildPlannedVisualContract also adapts legacy plans which only have
          // description/semanticScope. Protection and appearance roles are
          // audited separately by the contract and never become target nouns.
          expectedContract = protocol.buildUserVisualContract(text, params.description);
          actualContract = protocol.buildPlannedVisualContract(params);
          const contractAudit = protocol.auditVisualContract(expectedContract, actualContract);
          if (!contractAudit.complete) {
            errors.push(...contractAudit.errors.map((message) => String(message || "").replace(/[\u3002！!]+$/g, "")));
          }
        } catch (error) {
          errors.push(`视觉语义合同无法审核：${error && error.message ? error.message : String(error)}`);
        }
      }

      const visualUnit = String(params.unit || "percent");
      if (["percent", "normalized"].includes(visualUnit) && params.targetBox && params.seed) {
        const toPercent = visualUnit === "normalized" ? 100 : 1;
        const centerX = ((Number(params.targetBox.left) + Number(params.targetBox.right)) / 2) * toPercent;
        const centerY = ((Number(params.targetBox.top) + Number(params.targetBox.bottom)) / 2) * toPercent;
        const seedX = Number(params.seed.x) * toPercent;
        const seedY = Number(params.seed.y) * toPercent;
        const expectedPositions = new Set(expectedContract && expectedContract.target
          ? expectedContract.target.positions || []
          : []);
        const wantsLeft = expectedPositions.has("left") || expectedPositions.has("top_left") || expectedPositions.has("bottom_left");
        const wantsRight = expectedPositions.has("right") || expectedPositions.has("top_right") || expectedPositions.has("bottom_right");
        const wantsTop = expectedPositions.has("top") || expectedPositions.has("top_left") || expectedPositions.has("top_right");
        const wantsBottom = expectedPositions.has("bottom") || expectedPositions.has("bottom_left") || expectedPositions.has("bottom_right");
        if (wantsLeft && (!(centerX < 50) || !(seedX < 50))) errors.push("视觉目标框/种子点不在用户指定的左侧");
        if (wantsRight && (!(centerX > 50) || !(seedX > 50))) errors.push("视觉目标框/种子点不在用户指定的右侧");
        if (wantsTop && (!(centerY < 50) || !(seedY < 50))) errors.push("视觉目标框/种子点不在用户指定的上方");
        if (wantsBottom && (!(centerY > 50) || !(seedY > 50))) errors.push("视觉目标框/种子点不在用户指定的下方");
      }
    }
    if (action === "selection.subject") {
      verifyExpectedString("sampleAllLayers", params.sampleAllLayers !== false, "选择主体采样范围", (value) => String(Boolean(value)));
    }
    if (["selection.rectangle", "selection.ellipse"].includes(action)) {
      verifyExpectedString("selectionUnit", params.unit || "pixels", "选区坐标单位");
      verifyExpectedNumber("selectionLeft", params.left, "选区左边界");
      verifyExpectedNumber("selectionTop", params.top, "选区上边界");
      verifyExpectedNumber("selectionRight", params.right, "选区右边界");
      verifyExpectedNumber("selectionBottom", params.bottom, "选区下边界");
      verifyExpectedNumber("selectionFeather", params.feather == null ? 0 : params.feather, "几何选区羽化");
      verifyExpectedString("selectionAntiAlias", params.antiAlias !== false, "几何选区抗锯齿", (value) => String(Boolean(value)));
    }
    if (action === "selection.polygon") {
      verifyExpectedNumber("selectionFeather", params.feather == null ? 0 : params.feather, "多边形选区羽化");
      verifyExpectedString("selectionAntiAlias", params.antiAlias !== false, "多边形选区抗锯齿", (value) => String(Boolean(value)));
    }
    if (action === "mask.set_density") verifyExpectedNumber("density", params.density, "蒙版密度");
    if (action === "mask.set_feather") verifyExpectedNumber("feather", params.feather, "蒙版羽化");
    if (["document.resize_image", "document.resize_canvas"].includes(action)) {
      if (expectedValues("width").length) verifyExpectedNumber("width", params.width, "文档宽度");
      else if (params.width != null) errors.push("文档宽度没有获得用户授权");
      if (expectedValues("height").length) verifyExpectedNumber("height", params.height, "文档高度");
      else if (params.height != null) errors.push("文档高度没有获得用户授权");
    }
    if (action === "document.resize_image") {
      verifyExpectedString("constrainProportions", params.constrainProportions === true, "图像等比约束", (value) => String(Boolean(value)));
      if (expectedValues("resolution").length) verifyExpectedNumber("resolution", params.resolution, "图像分辨率");
      else if (params.resolution != null) errors.push("图像分辨率没有获得用户授权");
    }
    if (action === "document.resize_canvas" && params.anchor != null) verifyExpectedString("anchor", params.anchor, "画布锚点");
    if (action === "document.crop") {
      verifyExpectedString("cropReference", params.reference || "selection", "裁剪参考");
      verifyExpectedString("cropUnit", params.unit || "pixels", "裁剪坐标单位");
      verifyExpectedNumber("cropLeft", params.left, "裁剪左边界");
      verifyExpectedNumber("cropTop", params.top, "裁剪上边界");
      verifyExpectedNumber("cropRight", params.right, "裁剪右边界");
      verifyExpectedNumber("cropBottom", params.bottom, "裁剪下边界");
    }
    if (action === "document.trim") {
      verifyExpectedString("trimType", params.type || "transparent", "裁切类型");
      for (const [name, paramName, label] of [["trimTop", "top", "上边"], ["trimLeft", "left", "左边"], ["trimBottom", "bottom", "下边"], ["trimRight", "right", "右边"]]) {
        if (expectedValues(name).length) verifyExpectedString(name, params[paramName], `裁切${label}`, (value) => String(Boolean(value)));
      }
    }
    if (["layer.align_to_reference", "layer.fit_to_reference", "text.fit_to_reference", "group.fit_text_to_reference"].includes(action)) {
      verifyExpectedString("reference", params.reference, "参考范围");
      verifyExpectedNumber("padding", params.padding == null ? 0 : params.padding, "参考范围内边距");
      verifyExpectedString("allowUpscale", params.allowUpscale === true, "允许放大", (value) => String(Boolean(value)));
      if (params.horizontal != null) {
        if (expectedValues("horizontal").length) verifyExpectedString("horizontal", params.horizontal, "水平对齐");
        else if (params.horizontal !== "preserve") errors.push("水平对齐没有获得用户授权");
      }
      if (params.vertical != null) {
        if (expectedValues("vertical").length) verifyExpectedString("vertical", params.vertical, "垂直对齐");
        else if (params.vertical !== "preserve") errors.push("垂直对齐没有获得用户授权");
      }
    }
    if (action === "group.fit_text_to_reference") {
      verifyExpectedString("arrangement", params.arrangement || "preserve", "文字组排列方式");
      const allowedStyle = new Set(["orientation"]);
      for (const param of Object.keys(GROUP_TEXT_PARAM_REQUIREMENTS)) {
        if (params[param] == null) continue;
        if (!allowedStyle.has(param) || !expectedValues(param).length) errors.push(`文字组适配参数${param}没有对应的用户需求`);
      }
    }
    if (action === "document.export") {
      verifyExpectedString("format", params.format, "导出格式", (value) => String(value || "").toLowerCase() === "jpg" ? "jpeg" : String(value || "").toLowerCase());
      verifyExpectedNumber("quality", params.quality == null ? 10 : params.quality, "导出质量");
      verifyExpectedString("asCopy", params.asCopy !== false, "副本导出", (value) => String(Boolean(value)));
    }
    if (action === "text.set_faux_bold") {
      if (params.enabled === true && !/(?:加粗|粗体)/.test(text)) errors.push("启用粗体没有授权");
      if (params.enabled === false && !/(?:取消|去掉|关闭).{0,8}(?:加粗|粗体)/.test(text)) errors.push("取消粗体没有授权");
    }
    if (action === "text.set_faux_italic") {
      if (params.enabled === true && !/斜体/.test(text)) errors.push("启用斜体没有授权");
      if (params.enabled === false && !/(?:取消|去掉|关闭).{0,8}斜体/.test(text)) errors.push("取消斜体没有授权");
    }
    if (["selection.rectangle", "selection.ellipse", "selection.polygon"].includes(action) && params.mode && params.mode !== "replace") {
      const modePatterns = {
        add: /(?:加选|补选|添加到选区|并入选区)/,
        subtract: /(?:减选|排除|从选区减去|移出选区)/,
        intersect: /(?:交集|相交选区|只保留重叠)/
      };
      if (!modePatterns[params.mode] || !modePatterns[params.mode].test(text)) errors.push(`选区${params.mode}模式没有明确授权`);
    }
    if (action === "mask.create_hide_all" && !/(?:隐藏全部|全黑|黑色蒙版)/.test(text)) errors.push("隐藏全部蒙版没有明确授权");
    if (action === "mask.create_reveal_all" && /(?:隐藏全部|全黑|黑色蒙版|从选区|按选区)/.test(text)) errors.push("显示全部蒙版与用户要求的蒙版类型相反");
    if (action === "mask.create_from_selection" && !/(?:选区|抠出|抠图|提取主体|隐藏背景|去背景)/.test(text)) errors.push("按选区创建蒙版没有选区/抠图授权");
    if (action === "layer.rename") {
      const name = String(params.name == null ? "" : params.name).trim();
      verifyExpectedString("name", name, "新图层名称");
      const match = text.match(/(?:重命名(?:为|成)?|命名为|(?:图层)?(?:名称|名字|名)(?:改为|改成|设为|设置为)|改名为)\s*[：:]?\s*[“"'‘]?([^；。，“”"'’]+)[”"'’]?\s*$/);
      const expectedName = match ? String(match[1] || "").trim() : "";
      if (!name) errors.push("新图层名称为空");
      else if (expectedName && name !== expectedName) errors.push(`新图层名称“${name}”与用户指定的“${expectedName}”不一致`);
      else if (!expectedName && !text.includes(name)) errors.push("新图层名称不在用户原文中");
    }
    if (action === "text.set_content") {
      const content = String(params.content == null ? "" : params.content);
      verifyExpectedString("content", content, "新文字内容");
      if (!content && !/(?:清空|置空|设为空|改为空|删除).{0,8}(?:文字|文本|内容)/.test(text)) {
        errors.push("清空文字内容没有明确授权");
      } else if (content && !text.includes(content)) {
        errors.push("新文字内容不在用户原文中");
      }
    }

    return errors;
  }

  function auditRequirementCoverage(requirements, intent) {
    const source = Array.isArray(requirements) ? requirements : [];
    const operations = intent && Array.isArray(intent.operations) ? intent.operations : [];
    const knownIds = new Set(source.map((item) => item.id));
    const requirementsById = new Map(source.map((item) => [item.id, item]));
    const unknownReferences = [];
    const unauthorizedOperations = [];
    for (const item of operations) {
      const requirementIds = Array.isArray(item.requirementIds) ? item.requirementIds : [];
      if (!requirementIds.length) {
        unauthorizedOperations.push(`${item.id || "(无ID)"}:${item.action}（没有关联用户需求）`);
        continue;
      }
      for (const requirementId of requirementIds) {
        if (!knownIds.has(requirementId)) unknownReferences.push(`${item.id}:${requirementId}`);
      }
      const linkedRequirements = requirementIds
        .map((requirementId) => requirementsById.get(requirementId))
        .filter(Boolean);
      if (linkedRequirements.length && !linkedRequirements.some((requirement) => requirementAllowsAction(requirement, item.action))) {
        unauthorizedOperations.push(`${item.id}:${item.action}（操作类型不符合所关联的用户需求）`);
      } else if (linkedRequirements.length && !hasExplicitHighRiskAuthorization(linkedRequirements, item)) {
        unauthorizedOperations.push(`${item.id}:${item.action}（高风险操作没有用户的明确措辞授权）`);
      } else if (linkedRequirements.length) {
        const parameterErrors = parameterAuthorizationErrors(linkedRequirements, item);
        if (item.action === "layer.move_to_group") {
          const expectedNames = linkedRequirements
            .map((requirement) => requirement.expectedParams && requirement.expectedParams.destinationGroupName)
            .filter(Boolean);
          for (const expectedName of expectedNames) {
            if (item.params && item.params.groupName) {
              if (String(item.params.groupName).trim() !== expectedName) parameterErrors.push(`目标图层组“${item.params.groupName}”与用户指定的“${expectedName}”不一致`);
            } else if (item.params && item.params.groupResultOf) {
              const producer = operations.find((candidate) => candidate.id === item.params.groupResultOf);
              if (!producer || producer.action !== "layer.create_group" || String(producer.params && producer.params.name || "").trim() !== expectedName) {
                parameterErrors.push(`图层组结果引用没有指向用户指定的“${expectedName}”`);
              }
            } else {
              parameterErrors.push(`没有可验证的目标图层组名称“${expectedName}”`);
            }
          }
        }
        if (parameterErrors.length) unauthorizedOperations.push(`${item.id}:${item.action}（${parameterErrors.join("；")}）`);
      }
    }
    for (const item of operations) {
      const linked = (item.requirementIds || []).map((id) => requirementsById.get(id)).filter(Boolean);
      const fingerprints = new Map();
      for (const requirement of linked) {
        const fingerprint = JSON.stringify({
          key: requirement.key,
          actions: requirement.expectedActions || [],
          params: requirement.expectedParams || {},
          target: requirement.expectedTarget || null
        });
        const entries = fingerprints.get(fingerprint) || [];
        entries.push(requirement);
        fingerprints.set(fingerprint, entries);
      }
      for (const duplicates of fingerprints.values()) {
        if (duplicates.length > 1 && new Set(duplicates.map((requirement) => requirement.clauseIndex)).size > 1) {
          unauthorizedOperations.push(`${item.id}:${item.action}（一个操作不能同时抵消多个重复需求：${duplicates.map((requirement) => requirement.id).join("、")}）`);
        }
      }
      const resultRequirements = linked.filter((requirement) => requirement.expectedTarget && requirement.expectedTarget.scopes.includes("operation_result"));
      if (resultRequirements.length) {
        const resultOf = item.target && item.target.scope === "operation_result" ? String(item.target.resultOf || "") : "";
        const producer = operations.find((candidate) => candidate.id === resultOf);
        const producerRequirements = producer
          ? (producer.requirementIds || []).map((id) => requirementsById.get(id)).filter(Boolean)
          : [];
        const validProducer = producer && /^(?:layer\.duplicate|layer\.create_group|layer\.create_pixel|text\.create)$/.test(producer.action)
          && resultRequirements.every((requirement) => producerRequirements.some((candidate) => candidate.clauseIndex < requirement.clauseIndex));
        if (!validProducer) unauthorizedOperations.push(`${item.id}:${item.action}（结果目标没有引用该指令此前创建或复制出的图层）`);
      }
    }
    for (const requirement of source) {
      const linked = operations.filter((item) => (item.requirementIds || []).includes(requirement.id));
      const directEffects = linked.filter((item) => (requirement.expectedActions || []).some((expected) => actionMatches(item.action, expected)));
      if (requirement.key === "cutout") {
        const cutoutGroups = [
          ["目标定位", (item) => ["selection.subject", "selection.visual_object"].includes(item.action)],
          ["图层副本", (item) => item.action === "layer.duplicate"],
          ["抠图蒙版", (item) => item.action === "mask.create_from_selection"],
          ["隐藏原图", (item) => item.action === "layer.set_visibility"]
        ];
        for (const [label, predicate] of cutoutGroups) {
          const count = linked.filter(predicate).length;
          if (count > 1) unauthorizedOperations.push(`${requirement.id}（${label}被重复执行${count}次）`);
        }
      } else {
        const expectedCount = Number(requirement.expectedParams && requirement.expectedParams.count || 1);
        if (directEffects.length > expectedCount) {
          unauthorizedOperations.push(`${requirement.id}（用户要求执行${expectedCount}次，但实际重复执行${directEffects.length}次：${directEffects.map((item) => item.action).join("、")}）`);
        } else if (directEffects.length > 0 && directEffects.length < expectedCount) {
          unauthorizedOperations.push(`${requirement.id}（用户要求执行${expectedCount}次，计划只有${directEffects.length}次）`);
        }
      }
      const selectionCounts = new Map();
      for (const item of linked.filter((candidate) => String(candidate.action || "").startsWith("selection."))) {
        selectionCounts.set(item.action, (selectionCounts.get(item.action) || 0) + 1);
      }
      for (const [action, count] of selectionCounts) {
        if (count > 1) unauthorizedOperations.push(`${requirement.id}（选区动作${action}重复${count}次，终态不再等于用户要求）`);
      }
    }
    for (const requirement of source) {
      const linked = operations.filter((item) => (item.requirementIds || []).includes(requirement.id));
      const effect = linked.find((item) => String(item.action || "").startsWith("adjustment."))
        || linked.find((item) => String(item.action || "").startsWith("filter.") && requirement.expectedParams && requirement.expectedParams.filterUseSelection === true);
      if (!effect) continue;
      const effectIndex = operations.indexOf(effect);
      const text = String(requirement.text || "");
      const expectedTarget = requirement.expectedTarget;
      const explicitCurrentSelection = /(?:当前|已有|现有)选区|选中的区域|局部区域/.test(text);
      const semanticInsideContainer = semanticTargetInsideContainer(text);
      const semanticTarget = hasConcreteVisualTarget(text);
      const wholeSubject = /(?:完整|整个|全身|整体|前景)?(?:主体|主要人物|主要商品)|(?:隐藏|去掉|移除)背景/.test(text);
      const backgroundTarget = /(?:背景|主体以外|人物以外|角色以外|前景以外)/.test(text);
      const globalColorRange = Boolean(requirement.expectedParams && requirement.expectedParams.selectionColor);
      const structuredLayerTarget = expectedTarget && !expectedTarget.scopes.includes("document");
      let selectorKind = null;
      if (structuredLayerTarget) selectorKind = semanticInsideContainer ? "visual" : "layer";
      else if (semanticTarget) selectorKind = backgroundTarget ? "background" : wholeSubject ? "subject_or_visual" : "visual";
      else if (globalColorRange) selectorKind = "color_range";
      else if (explicitCurrentSelection) selectorKind = "existing";
      if (!selectorKind || selectorKind === "existing") continue;

      const selectionsBefore = operations
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => index < effectIndex && String(item.action || "").startsWith("selection."));
      const lastSelection = selectionsBefore[selectionsBefore.length - 1];
      const linkedSelections = selectionsBefore.filter(({ item }) => (item.requirementIds || []).includes(requirement.id));
      const finalSelectionBelongsToRequirement = lastSelection
        && (lastSelection.item.requirementIds || []).includes(requirement.id);
      const replacementActions = new Set([
        "selection.load_layer", "selection.subject", "selection.subject_region", "selection.visual_object",
        "selection.color_range", "selection.rectangle", "selection.ellipse", "selection.polygon",
        "selection.select_all", "selection.deselect"
      ]);
      const replacementSelections = selectionsBefore.filter(({ item }) => replacementActions.has(item.action));
      const finalReplacement = replacementSelections[replacementSelections.length - 1];
      const replacementBelongsToRequirement = finalReplacement
        && (finalReplacement.item.requirementIds || []).includes(requirement.id);
      const selectionChainIsOwned = finalReplacement && selectionsBefore
        .filter(({ index }) => index >= finalReplacement.index)
        .every(({ item }) => (item.requirementIds || []).includes(requirement.id));
      const finalIsLayer = finalReplacement && (() => {
        const item = finalReplacement.item;
        if (item.action !== "selection.load_layer" || !structuredLayerTarget) return false;
        const target = item.target || {};
        if (!expectedTarget.scopes.includes(target.scope)) return false;
        return expectedTarget.query == null || String(target.query || "").trim() === expectedTarget.query;
      })();
      const finalIsVisual = finalReplacement && finalReplacement.item.action === "selection.visual_object";
      const finalIsSubject = finalReplacement && finalReplacement.item.action === "selection.subject";
      const finalIsColorRange = finalReplacement && finalReplacement.item.action === "selection.color_range";
      const hasInvertAfterSubject = linkedSelections.some(({ item, index }) => item.action === "selection.invert"
        && linkedSelections.some(({ item: candidate, index: subjectIndex }) => candidate.action === "selection.subject" && subjectIndex < index));
      const selectorMatches = selectorKind === "layer" ? finalIsLayer
        : selectorKind === "color_range" ? finalIsColorRange
          : selectorKind === "visual" ? finalIsVisual
            : selectorKind === "subject_or_visual" ? (finalIsSubject || finalIsVisual)
              : selectorKind === "background" ? (finalIsVisual || (finalIsSubject && hasInvertAfterSubject))
                : false;
      if (!selectorMatches || !finalSelectionBelongsToRequirement || !replacementBelongsToRequirement || !selectionChainIsOwned) {
        unauthorizedOperations.push(`${effect.id || requirement.id}:${effect.action}（该子句在修改前没有建立并保持自己的目标选区，不能借用其他子句或已有选区）`);
      }
    }
    for (const item of operations.filter((candidate) => candidate.action === "selection.visual_object" || candidate.action === "selection.color_range" || candidate.action === "selection.subject")) {
      const clauseIndexes = new Set((item.requirementIds || [])
        .map((id) => requirementsById.get(id))
        .filter(Boolean)
        .map((requirement) => requirement.clauseIndex));
      if (clauseIndexes.size > 1) unauthorizedOperations.push(`${item.id}:${item.action}（同一个定位步骤不能跨多个子句复用）`);
    }
    for (const consumer of operations.filter((item) => item.action === "mask.create_from_selection")) {
      const consumerIndex = operations.indexOf(consumer);
      const allSelectionOperations = operations
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => String(item.action || "").startsWith("selection."));
      const priorSelections = allSelectionOperations.filter(({ index }) => index < consumerIndex);
      const lastPrior = priorSelections[priorSelections.length - 1];
      const linkedRequirements = (consumer.requirementIds || []).map((id) => requirementsById.get(id)).filter(Boolean);
      const isCutout = linkedRequirements.some((requirement) => requirement.key === "cutout");
      const hasPlannedSelector = allSelectionOperations.some(({ item }) => item.action !== "selection.deselect");
      const hasCutoutSelector = priorSelections.some(({ item }) => (consumer.requirementIds || []).some((id) => (item.requirementIds || []).includes(id))
        && ["selection.subject", "selection.visual_object"].includes(item.action));
      if ((hasPlannedSelector && (!lastPrior || lastPrior.item.action === "selection.deselect")) || (isCutout && !hasCutoutSelector)) {
        unauthorizedOperations.push(`${consumer.id}:mask.create_from_selection（创建蒙版前没有先建立可用选区，操作顺序无效）`);
      }
    }
    const missing = [];
    const details = source.map((requirement) => {
      const linked = operations.filter((item) => (item.requirementIds || []).includes(requirement.id));
      const familyMatched = !requirement.expectedActions.length || linked.some((item) =>
        requirement.expectedActions.some((expected) => actionMatches(item.action, expected))
      );
      if (!linked.length) missing.push(`${requirement.id} ${requirement.label}（没有对应操作）`);
      else if (!familyMatched) missing.push(`${requirement.id} ${requirement.label}（操作类型不匹配）`);
      return {
        requirementId: requirement.id,
        linkedOperationIds: linked.map((item) => item.id),
        familyMatched
      };
    });
    if (unknownReferences.length) missing.push(`存在未知需求引用：${unknownReferences.join("、")}`);
    if (unauthorizedOperations.length) missing.push(`存在未获用户授权的操作：${unauthorizedOperations.join("；")}`);
    return {
      complete: missing.length === 0,
      missing,
      details,
      requirementCount: source.length,
      unknownReferences,
      unauthorizedOperations
    };
  }

  function cloneIntent(intent) {
    return {
      ...intent,
      operations: (intent.operations || []).map((item) => ({
        ...item,
        target: { ...(item.target || {}) },
        params: { ...(item.params || {}) },
        requirementIds: Array.isArray(item.requirementIds) ? [...item.requirementIds] : []
      }))
    };
  }

  function normalizeDependencies(intent) {
    const normalized = cloneIntent(intent);
    const usedIds = new Set();
    const groupProducers = new Map();
    for (let index = 0; index < normalized.operations.length; index += 1) {
      const item = normalized.operations[index];
      let operationId = String(item.id || `operation_${index + 1}`).trim() || `operation_${index + 1}`;
      if (usedIds.has(operationId)) {
        const error = new Error(`操作ID重复：${operationId}。为避免结果引用错位，计划已拒绝执行。`);
        error.code = "DUPLICATE_OPERATION_ID";
        throw error;
      }
      item.id = operationId;
      usedIds.add(operationId);
      if (item.action === "layer.create_group" && item.params && item.params.name) {
        groupProducers.set(normalizeText(item.params.name).toLowerCase(), operationId);
      }
      if (item.action === "layer.move_to_group" && item.params && !item.params.groupResultOf && item.params.groupName) {
        const producer = groupProducers.get(normalizeText(item.params.groupName).toLowerCase());
        if (producer) item.params.groupResultOf = producer;
      }
    }
    return normalized;
  }

  function validateDependencyGraph(intent) {
    const operations = intent && Array.isArray(intent.operations) ? intent.operations : [];
    const seen = new Map();
    const errors = [];
    for (let index = 0; index < operations.length; index += 1) {
      const item = operations[index];
      if (seen.has(item.id)) errors.push(`操作ID重复：${item.id}`);
      const resultOf = item.target && item.target.scope === "operation_result"
        ? String(item.target.resultOf || "")
        : "";
      if (resultOf && !seen.has(resultOf)) errors.push(`步骤${item.id}引用了尚未产生的结果${resultOf}`);
      const groupResultOf = item.params && item.params.groupResultOf
        ? String(item.params.groupResultOf)
        : "";
      if (groupResultOf) {
        const producer = seen.get(groupResultOf);
        if (!producer) errors.push(`步骤${item.id}引用了尚未创建的图层组${groupResultOf}`);
        else if (producer.action !== "layer.create_group") errors.push(`步骤${groupResultOf}不是图层组创建操作`);
      }
      seen.set(item.id, { action: item.action, index });
    }
    return { valid: errors.length === 0, errors };
  }

  function requirementsForClause(requirements, clauseIndex) {
    return (requirements || []).filter((item) => item.clauseIndex === clauseIndex).map((item) => item.id);
  }

  function promptChecklist(requirements) {
    return (requirements || []).map((item) => ({
      id: item.id,
      requirement: item.text,
      type: item.key,
      expectedCapabilityFamilies: item.expectedActions
    }));
  }

  return {
    MODIFICATION_WORDS,
    splitClauses,
    analyzeInstructionClause,
    buildRequirements,
    requirementsForClause,
    auditRequirementCoverage,
    hasExplicitHighRiskAuthorization,
    normalizeDependencies,
    validateDependencyGraph,
    promptChecklist
  };
});
