(function (root, factory) {
  let cachedVisualContract = root.PhotoshopAssistantV97VisualContract || null;
  const resolveVisualContract = function () {
    if (cachedVisualContract) return cachedVisualContract;
    if (typeof require === "function") {
      try {
        cachedVisualContract = require("./visual-contract");
      } catch (_) {
        cachedVisualContract = null;
      }
    }
    if (!cachedVisualContract && root.PhotoshopAssistantV97VisualContract) {
      cachedVisualContract = root.PhotoshopAssistantV97VisualContract;
    }
    return cachedVisualContract;
  };
  let cachedConfidencePolicy = root.PhotoshopAssistantV97Confidence || null;
  const resolveConfidencePolicy = function () {
    if (cachedConfidencePolicy) return cachedConfidencePolicy;
    if (typeof require === "function") {
      try {
        cachedConfidencePolicy = require("./confidence-policy");
      } catch (_) {
        cachedConfidencePolicy = null;
      }
    }
    if (!cachedConfidencePolicy && root.PhotoshopAssistantV97Confidence) {
      cachedConfidencePolicy = root.PhotoshopAssistantV97Confidence;
    }
    return cachedConfidencePolicy;
  };
  const api = factory(resolveVisualContract, resolveConfidencePolicy);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV8Protocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (resolveVisualContract, resolveConfidencePolicy) {
  "use strict";

  function visualContractApi(required = true) {
    const api = typeof resolveVisualContract === "function" ? resolveVisualContract() : null;
    if (!api && required) throw new Error("v9.8视觉语义合同模块未加载。");
    return api;
  }

  function classifyConfidence(value) {
    const api = typeof resolveConfidencePolicy === "function" ? resolveConfidencePolicy() : null;
    if (api && typeof api.classify === "function") return api.classify(value, { hasCandidate: true });
    const confidence = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
    return { confidence, level: confidence >= 0.78 ? "high" : confidence >= 0.50 ? "medium" : "low" };
  }

  function buildUserVisualContract(instruction, plannedDescription) {
    return visualContractApi().buildUserContract(instruction, plannedDescription);
  }

  function buildPlannedVisualContract(params) {
    return visualContractApi().buildPlannedContract(params);
  }

  function auditVisualContract(expected, actual) {
    return visualContractApi().auditContract(expected, actual);
  }

  function applyAuthoritativeVisualContract(params, instruction, options) {
    return visualContractApi().applyAuthoritativeContract(params, instruction, options);
  }

  function visualAppearanceConstraints(instruction) {
    return visualContractApi().appearanceConstraints(instruction);
  }

  const NAMED_COLORS = Object.freeze({
    红: "#FF0000", 蓝: "#0000FF", 绿: "#00A651", 黄: "#FFFF00", 黑: "#000000",
    白: "#FFFFFF", 灰: "#808080", 紫: "#800080", 橙: "#FF8C00", 粉: "#FF69B4"
  });

  // Defaults live here so the deterministic parser, authorization ledger and
  // protocol normalizer cannot silently choose different values.  Effect
  // defaults are deliberately conservative; implementation defaults are
  // canonicalized and do not become extra user requirements.
  const ACTION_DEFAULTS = Object.freeze({
    "layer.create_pixel": Object.freeze({ name: "新建图层" }),
    "layer.create_group": Object.freeze({ name: "新建组" }),
    "text.create": Object.freeze({ name: "新建文字", content: "文字" }),
    "layer.fit_to_reference": Object.freeze({ padding: 0, horizontal: "center", vertical: "middle", allowUpscale: false }),
    "text.fit_to_reference": Object.freeze({ padding: 0, horizontal: "center", vertical: "middle", allowUpscale: false }),
    "group.fit_text_to_reference": Object.freeze({ padding: 0, horizontal: "center", vertical: "middle", allowUpscale: false, arrangement: "preserve" }),
    "filter.gaussian_blur": Object.freeze({ radius: 2, useSelection: false }),
    "filter.motion_blur": Object.freeze({ angle: 0, distance: 10, useSelection: false }),
    "filter.add_noise": Object.freeze({ amount: 1, distribution: "uniform", monochromatic: false, useSelection: false }),
    "filter.high_pass": Object.freeze({ radius: 2, useSelection: false }),
    "filter.unsharp_mask": Object.freeze({ amount: 100, radius: 1, threshold: 0, useSelection: false }),
    "filter.sharpen": Object.freeze({ useSelection: false }),
    "selection.color_range": Object.freeze({ tolerance: 32, softness: 8 }),
    "selection.visual_object": Object.freeze({ confidence: 0 }),
    "selection.subject_region": Object.freeze({ confidence: 0 }),
    "adjustment.brightness_contrast": Object.freeze({ brightness: 0, contrast: 0 }),
    "adjustment.vibrance": Object.freeze({ vibrance: 0, saturation: 0 }),
    "adjustment.exposure": Object.freeze({ exposure: 0, offset: 0, gamma: 1 }),
    "adjustment.hue_saturation": Object.freeze({ hue: 0, saturation: 0, lightness: 0 }),
    "adjustment.colorize": Object.freeze({ opacity: 100, blendMode: "normal" })
  });

  const INSTRUCTION_DEFAULTS = Object.freeze({
    global_color_replace: Object.freeze({ tolerance: 24, softness: 8, opacity: 100, blendMode: "normal" })
  });

  const PARAMETER_CATEGORIES = Object.freeze({
    "selection.color_range": Object.freeze({ color: "effect", tolerance: "effect", softness: "policy_default" }),
    "filter.gaussian_blur": Object.freeze({ radius: "effect", useSelection: "effect" }),
    "filter.motion_blur": Object.freeze({ angle: "effect", distance: "effect", useSelection: "effect" }),
    "filter.add_noise": Object.freeze({ amount: "effect", distribution: "effect", monochromatic: "effect", useSelection: "effect" }),
    "filter.high_pass": Object.freeze({ radius: "effect", useSelection: "effect" }),
    "filter.unsharp_mask": Object.freeze({ amount: "effect", radius: "effect", threshold: "effect", useSelection: "effect" }),
    "selection.visual_object": Object.freeze({ confidence: "evidence" }),
    "selection.subject_region": Object.freeze({ confidence: "evidence" })
  });

  function defaultsForAction(action) {
    return { ...(ACTION_DEFAULTS[String(action || "")] || {}) };
  }

  function defaultsForInstruction(kind) {
    return { ...(INSTRUCTION_DEFAULTS[String(kind || "")] || {}) };
  }

  function parameterCategory(action, name) {
    const categories = PARAMETER_CATEGORIES[String(action || "")] || {};
    return categories[String(name || "")] || "effect";
  }

  const ACTIONS = new Set([
    "layer.create_pixel",
    "layer.create_group",
    "layer.duplicate",
    "layer.delete",
    "layer.rename",
    "layer.set_visibility",
    "layer.set_opacity",
    "layer.set_fill_opacity",
    "layer.set_blend_mode",
    "layer.set_lock",
    "layer.move_by",
    "layer.scale",
    "layer.rotate",
    "layer.flip",
    "layer.skew",
    "layer.rasterize",
    "layer.convert_to_smart_object",
    "layer.set_clipping_mask",
    "layer.merge_down",
    "layer.reorder",
    "layer.move_to_group",
    "layer.align_to_reference",
    "layer.fit_to_reference",
    "text.create",
    "text.set_content",
    "text.set_color",
    "text.set_size",
    "text.set_font",
    "text.set_leading",
    "text.set_tracking",
    "text.set_justification",
    "text.set_faux_bold",
    "text.set_faux_italic",
    "text.set_horizontal_scale",
    "text.set_vertical_scale",
    "text.set_baseline_shift",
    "text.set_hyphenation",
    "text.set_paragraph_spacing",
    "text.set_orientation",
    "text.fit_to_reference",
    "group.set_text_style",
    "group.fit_text_to_reference",
    "filter.gaussian_blur",
    "filter.motion_blur",
    "filter.add_noise",
    "filter.high_pass",
    "filter.unsharp_mask",
    "filter.sharpen",
    "selection.select_all",
    "selection.deselect",
    "selection.rectangle",
    "selection.ellipse",
    "selection.polygon",
    "selection.subject",
    "selection.subject_region",
    "selection.color_range",
    "selection.visual_object",
    "selection.invert",
    "selection.expand",
    "selection.contract",
    "selection.feather",
    "selection.border",
    "selection.grow",
    "selection.smooth",
    "selection.load_layer",
    "mask.create_from_selection",
    "mask.create_reveal_all",
    "mask.create_hide_all",
    "mask.invert",
    "mask.delete",
    "mask.apply",
    "mask.set_density",
    "mask.set_feather",
    "adjustment.brightness_contrast",
    "adjustment.levels",
    "adjustment.curves",
    "adjustment.vibrance",
    "adjustment.exposure",
    "adjustment.black_white",
    "adjustment.hue_saturation",
    "adjustment.colorize",
    "document.resize_image",
    "document.resize_canvas",
    "document.crop",
    "document.rotate",
    "document.trim",
    "document.reveal_all",
    "document.merge_visible",
    "document.flatten",
    "document.export"
  ]);

  const TARGET_SCOPES = new Set([
    "active_layer", "active_layers", "layer_id", "layer_path", "layer_name",
    "text_content", "operation_result", "document"
  ]);
  const BLEND_MODES = new Set([
    "normal", "multiply", "screen", "overlay", "softLight", "hardLight",
    "darken", "lighten", "color", "hue", "saturation", "luminosity", "difference"
  ]);
  const JUSTIFICATIONS = new Set(["left", "center", "right", "justify_all"]);
  const REFERENCES = new Set(["selection", "canvas"]);
  const HORIZONTAL_ALIGNMENTS = new Set(["left", "center", "right", "preserve"]);
  const VERTICAL_ALIGNMENTS = new Set(["top", "middle", "bottom", "preserve"]);
  const ANCHORS = new Set(["top_left", "top_center", "top_right", "middle_left", "middle_center", "middle_right", "bottom_left", "bottom_center", "bottom_right"]);
  const VISUAL_SEMANTIC_SCOPES = new Set(["whole_object", "subpart", "unknown"]);
  const VISUAL_WHOLE_OBJECT_PATTERN = /人物|角色|人像|卡通形象|吉祥物|动物|宠物|商品|产品|奖杯|徽标|图标|车辆|汽车|玩具|物体|对象|玉米|胡萝卜|番茄|蔬菜|水果|植物|花朵|树木|建筑|主体/;
  const VISUAL_SUBPART_PATTERN = /头发|发丝|胡子|胡须|眉毛|眼睛|眼球|嘴巴|嘴|牙齿|舌头|脸部|面部|脸|皮肤|身体|躯干|胳膊|手臂|手掌|左手|右手|双手|腿部|小腿|大腿|腿|脚部|脚|衣服|衣袖|袖口|领口|帽檐|叶子|叶片|花瓣|花纹|图案|斑点|污点|徽章|局部|部分|区域|色块|小点|圆点/;
  const VISUAL_PROTECTION_PATTERN = /保持|保留|维持|不变|不要|别动|排除|除外|不包含|不能改|不要改|勿改/;
  const VISUAL_APPEARANCE_PRESERVATION_PATTERN = /高光|亮部|反光|光泽|阴影|暗部|明暗|亮暗|光影|纹理|质感|立体感?|层次感?|褶皱|细节|渐变|色阶|颜色|色彩|色调|亮度|饱和度|对比度|透明度|形状|轮廓|边缘/;

  function visualInstructionClauses(value) {
    return String(value || "")
      .split(/(?:但是|但要|但|同时保持|并保持|[，,。；;\n])/)
      .map((item) => item.trim())
      .filter((item) => item && !VISUAL_PROTECTION_PATTERN.test(item));
  }

  function visualSemanticBigrams(value) {
    const cleaned = String(value || "")
      .replace(/请|帮我|麻烦|我要|我想|把|将|给我|图中|画面中|当前|这个|那个|识别|选择|选中|选取|定位|找到|找出|抠出|提取|修改|调整|改成|改为|变成|换成|设为|替换/g, "")
      .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, "");
    const result = new Set();
    for (let index = 0; index < cleaned.length - 1; index += 1) result.add(cleaned.slice(index, index + 2));
    return result;
  }

  function closestVisualInstructionClause(instruction, plannedDescription) {
    const clauses = visualInstructionClauses(instruction);
    if (!clauses.length) return String(instruction || "").trim();
    if (clauses.length === 1 || !plannedDescription) return clauses[0];
    const planned = visualSemanticBigrams(plannedDescription);
    let best = clauses[0];
    let bestScore = -1;
    for (const clause of clauses) {
      const clauseTerms = visualSemanticBigrams(clause);
      let score = 0;
      for (const term of clauseTerms) if (planned.has(term)) score += 1;
      const partMatch = clause.match(VISUAL_SUBPART_PATTERN);
      const wholeMatch = clause.match(VISUAL_WHOLE_OBJECT_PATTERN);
      if (partMatch && String(plannedDescription).includes(partMatch[0])) score += 6;
      if (wholeMatch && String(plannedDescription).includes(wholeMatch[0])) score += 4;
      if (score > bestScore) {
        best = clause;
        bestScore = score;
      }
    }
    return best;
  }

  function visualTargetLabel(clause) {
    return String(clause || "")
      .replace(/^(?:请|帮我|麻烦|我要|我想|给我|只|仅|把|将)+/g, "")
      .replace(/^(?:识别|选择|选中|选取|定位|找到|找出|抠出|提取)+/g, "")
      .split(/改成|改为|变成|换成|调整为|设为|替换为|替换成|改色|换色|隐藏背景|去掉背景|移除背景/)[0]
      .replace(/(?:的颜色|颜色)$/g, "")
      .trim()
      .slice(0, 120);
  }

  function classifyVisualTargetInstruction(instruction, plannedDescription) {
    const contractApi = visualContractApi(false);
    if (contractApi) {
      const contract = contractApi.buildUserContract(instruction, plannedDescription);
      const clause = closestVisualInstructionClause(instruction, plannedDescription);
      return {
        scope: contract.target.scope,
        clause,
        label: contract.target.label,
        contract
      };
    }
    const clause = closestVisualInstructionClause(instruction, plannedDescription);
    const hasSubpart = VISUAL_SUBPART_PATTERN.test(clause);
    const hasWholeObject = VISUAL_WHOLE_OBJECT_PATTERN.test(clause);
    const scope = hasSubpart ? "subpart" : hasWholeObject ? "whole_object" : "unknown";
    return { scope, clause, label: visualTargetLabel(clause) };
  }

  function visualProtectedSubjectPhrase(clause) {
    const value = String(clause || "").trim();
    const prefix = value.match(/(?:保持|保留|维持|排除|不包含|不要(?:改|改变|破坏)|不能(?:改|改变|破坏)|勿改)\s*(.+)$/);
    if (prefix && prefix[1] && !/^(?:不变|原样)[。！!]*$/.test(prefix[1].trim())) return prefix[1];
    const suffix = value.match(/^(.+?)(?:保持不变|维持不变|保持原样|维持原样|不变|别动|不要动|不能改|不要改|勿改)(?:[。！!]?$|[，,；;])/);
    return suffix && suffix[1] ? suffix[1] : "";
  }

  // Appearance constraints describe how the later edit must preserve light
  // and texture. They are not pixel regions and must never authorize hard
  // negative points inside the selected object.
  function hasExplicitVisualSpatialProtection(instruction) {
    const contractApi = visualContractApi(false);
    if (contractApi) return contractApi.hasSpatialProtection(instruction);
    const clauses = String(instruction || "")
      .split(/(?:但是|但要|但|同时|并且|并(?=保持|保留|维持|排除|不包含|不要|不能|勿|别)|[，,。；;\n])/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (!VISUAL_PROTECTION_PATTERN.test(clause)) continue;
      const subject = visualProtectedSubjectPhrase(clause);
      if (!subject) continue;
      // In Chinese possessive phrases the protected semantic head follows the
      // last “的”: “奖杯的高光” protects appearance, while “奖杯前面的手”
      // protects a spatial object.
      const semanticHead = subject.includes("的") ? subject.slice(subject.lastIndexOf("的") + 1) : subject;
      const withoutAppearance = semanticHead
        .replace(new RegExp(VISUAL_APPEARANCE_PRESERVATION_PATTERN.source, "g"), "")
        .replace(/原有|原来的|原本|原始|现有|已有|自然|真实|全部|所有|整体|完整|可见|效果|部分/g, "")
        .replace(/和|与|及|以及|还有|的|等|仍然|继续|尽量|必须/g, "")
        .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, "");
      if (withoutAppearance) return true;
    }
    return false;
  }

  const ACTION_CONTRACTS = Object.freeze({
    "layer.create_pixel": "target=document params{name?}",
    "layer.create_group": "target=document params{name?}",
    "layer.duplicate": "target=layer params{} result=layer",
    "layer.delete": "target=layer params{}",
    "layer.rename": "target=layer params{name:string}",
    "layer.set_visibility": "target=layer params{visible:boolean}",
    "layer.set_opacity": "target=layer params{opacity:0..100}",
    "layer.set_fill_opacity": "target=layer params{fillOpacity:0..100}",
    "layer.set_blend_mode": "target=layer params{blendMode:normal|multiply|screen|overlay|softLight|hardLight|darken|lighten|color|hue|saturation|luminosity|difference}",
    "layer.set_lock": "target=layer params{lock:all|pixels|position|transparentPixels,locked:boolean}",
    "layer.move_by": "target=layer params{deltaX:px,deltaY:px}",
    "layer.scale": "target=layer params{scaleX:percent,scaleY:percent}",
    "layer.rotate": "target=layer params{angle:degrees,anchor?:anchor}",
    "layer.flip": "target=layer params{axis:horizontal|vertical}",
    "layer.skew": "target=layer params{angleH:degrees,angleV:degrees}",
    "layer.rasterize": "target=layer params{target?:entire_layer|text|shape|layer_style; smart_object is normalized to entire_layer}",
    "layer.convert_to_smart_object": "target=layer params{} result=layer",
    "layer.set_clipping_mask": "target=layer params{enabled:boolean}",
    "layer.merge_down": "target=layer params{} destructive=true",
    "layer.reorder": "target=layer params{position:front|back}",
    "layer.move_to_group": "target=layer params{groupName?:string,groupId?:number,groupResultOf?:operationId}",
    "layer.align_to_reference": "target=layer params{reference:selection|canvas,padding?,horizontal:left|center|right,vertical:top|middle|bottom}",
    "layer.fit_to_reference": "target=layer params{reference:selection|canvas,padding?,horizontal?,vertical?,allowUpscale?:boolean}",
    "text.create": "target=document params{name?,content,size?,color?,font?} result=layer",
    "text.set_content": "target=text_layer params{content:string}",
    "text.set_color": "target=text_layer params{color:#RRGGBB}",
    "text.set_size": "target=text_layer params{size:points}",
    "text.set_font": "target=text_layer params{font:installedPostScriptName}",
    "text.set_leading": "target=text_layer params{leading:number}",
    "text.set_tracking": "target=text_layer params{tracking:number}",
    "text.set_justification": "target=text_layer params{justification:left|center|right|justify_all}",
    "text.set_faux_bold": "target=text_layer params{enabled:boolean}",
    "text.set_faux_italic": "target=text_layer params{enabled:boolean}",
    "text.set_horizontal_scale": "target=text_layer params{scale:percent}",
    "text.set_vertical_scale": "target=text_layer params{scale:percent}",
    "text.set_baseline_shift": "target=text_layer params{baselineShift:number}",
    "text.set_hyphenation": "target=text_layer params{enabled:boolean}",
    "text.set_paragraph_spacing": "target=text_layer params{firstLineIndent?,leftIndent?,rightIndent?,spaceBefore?,spaceAfter?}",
    "text.set_orientation": "target=text_layer params{orientation:horizontal|vertical}",
    "text.fit_to_reference": "target=text_layer params{reference:selection|canvas,padding?,horizontal?,vertical?,allowUpscale?:boolean}",
    "group.set_text_style": "target=group params{size?,color?,font?,leading?,tracking?,justification?,fauxBold?,fauxItalic?,horizontalScale?,verticalScale?,baselineShift?,orientation?,hyphenation?,firstLineIndent?,leftIndent?,rightIndent?,spaceBefore?,spaceAfter?}",
    "group.fit_text_to_reference": "target=group params{reference:selection|canvas,padding?,horizontal?,vertical?,allowUpscale?:boolean,arrangement:preserve|compact,orientation?}",
    "filter.gaussian_blur": "target=layer params{radius:0.1..250,useSelection?:boolean=false}",
    "filter.motion_blur": "target=layer params{angle:degrees,distance:1..2000,useSelection?:boolean=false}",
    "filter.add_noise": "target=layer params{amount:0.1..400,distribution:uniform|gaussian,monochromatic:boolean,useSelection?:boolean=false}",
    "filter.high_pass": "target=layer params{radius:0.1..1000,useSelection?:boolean=false}",
    "filter.unsharp_mask": "target=layer params{amount:1..500,radius:0.1..1000,threshold:0..255,useSelection?:boolean=false}",
    "filter.sharpen": "target=layer params{useSelection?:boolean=false}",
    "selection.select_all": "target=document params{}",
    "selection.deselect": "target=document params{} requires=selection",
    "selection.rectangle": "target=document params{unit:pixels|percent|normalized,left,top,right,bottom,mode?:replace|add|subtract|intersect,feather?,antiAlias?}; percent固定0..100，normalized固定0..1",
    "selection.ellipse": "target=document params{unit:pixels|percent|normalized,left,top,right,bottom,mode?:replace|add|subtract|intersect,feather?,antiAlias?}; percent固定0..100，normalized固定0..1",
    "selection.polygon": "target=document params{unit:pixels|percent|normalized,points:[{x,y},...至少3点],mode?:replace|add|subtract|intersect,feather?,antiAlias?}",
    "selection.subject": "target=document params{sampleAllLayers?:boolean}",
    "selection.subject_region": "兼容旧计划：先全画布选择主体再裁剪，并非对象选择；target=document params{description,unit:pixels|percent|normalized,searchRegion:{left,top,right,bottom},feather?:0..30,confidence:0..1,sampleAllLayers?:boolean}",
    "selection.color_range": "target=document params{color:#RRGGBB,tolerance:0..255,softness?:0..255}",
    "selection.visual_object": "target=document params{description,semanticScope?:whole_object|subpart|unknown,visualContract?:{version:'1',target:{label,scope,entity,part,positions:[],sourceColorFamilies:[]},protectedRegions:[],preserveAppearance:[]},unit:pixels|percent|normalized,targetBox:{left,top,right,bottom},searchRegion:{left,top,right,bottom},seed:{x,y},positivePoints?:[{x,y}],excludePoints?:[{x,y}],sourceColorFamilies?:[red|orange|yellow|green|cyan|blue|purple|pink|black|white|gray|brown],sourceColors?:[#RRGGBB],color?,colors?:[#RRGGBB],colorRefine?:auto|source|none,allowColorFallback?:boolean,feather?:0..30,confidence:0..1,maxCoverage?:0.05..0.9}; percent固定0..100，normalized固定0..1",
    "selection.invert": "target=document params{} requires=selection",
    "selection.expand": "target=document params{by:1..500,applyAtCanvasBounds?:boolean} requires=selection",
    "selection.contract": "target=document params{by:1..500,applyAtCanvasBounds?:boolean} requires=selection",
    "selection.feather": "target=document params{by:0.1..1000,applyAtCanvasBounds?:boolean} requires=selection",
    "selection.border": "target=document params{width:1..200} requires=selection",
    "selection.grow": "target=document params{tolerance:0..255,antiAlias?:boolean} requires=selection",
    "selection.smooth": "target=document params{radius:1..500,applyAtCanvasBounds?:boolean} requires=selection",
    "selection.load_layer": "target=layer params{}",
    "mask.create_from_selection": "target=layer params{} requires=selection",
    "mask.create_reveal_all": "target=layer params{}",
    "mask.create_hide_all": "target=layer params{}",
    "mask.invert": "target=layer params{} requires=user_mask",
    "mask.delete": "target=layer params{} requires=user_mask",
    "mask.apply": "target=layer params{} requires=user_mask",
    "mask.set_density": "target=layer params{density:0..100} requires=user_mask",
    "mask.set_feather": "target=layer params{feather:0..1000} requires=user_mask",
    "adjustment.brightness_contrast": "target=document params{brightness:-150..150,contrast:-100..100,name?} requires=selection",
    "adjustment.levels": "target=document params{inputBlack:0..254,inputWhite:1..255,gamma:0.1..9.99,outputBlack:0..254,outputWhite:1..255,name?} requires=selection",
    "adjustment.curves": "target=document params{points:[{input:0..255,output:0..255},...至少2点],name?} requires=selection",
    "adjustment.vibrance": "target=document params{vibrance:-100..100,saturation:-100..100,name?} requires=selection",
    "adjustment.exposure": "target=document params{exposure:-20..20,offset:-0.5..0.5,gamma:0.01..9.99,name?} requires=selection",
    "adjustment.black_white": "target=document params{red?:-200..300,yellow?:-200..300,green?:-200..300,cyan?:-200..300,blue?:-200..300,magenta?:-200..300,name?} requires=selection",
    "adjustment.hue_saturation": "target=document params{hue:-180..180,saturation:-100..100,lightness:-100..100,name?} requires=selection",
    "adjustment.colorize": "target=document params{color:#RRGGBB,opacity?:0..100,blendMode?:color|normal,name?} requires=selection",
    "document.resize_image": "target=document params{width?,height?,resolution?,constrainProportions?:boolean}",
    "document.resize_canvas": "target=document params{width,height,anchor?:anchor}",
    "document.crop": "target=document params{reference:selection|bounds; bounds模式另需unit,left,top,right,bottom}",
    "document.rotate": "target=document params{angle:degrees}",
    "document.trim": "target=document params{type:transparent|top_left|bottom_right,top?,left?,bottom?,right?}",
    "document.reveal_all": "target=document params{}",
    "document.merge_visible": "target=document params{} destructive=true",
    "document.flatten": "target=document params{} destructive=true",
    "document.export": "target=document params{format:png|jpg|psd|psb|gif|bmp,quality?:1..12,asCopy?:boolean}"
  });

  function cleanJsonText(value) {
    const text = String(value == null ? "" : value).trim();
    const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const objectStart = withoutFence.indexOf("{");
    const arrayStart = withoutFence.indexOf("[");
    const first = objectStart < 0
      ? arrayStart
      : arrayStart < 0
        ? objectStart
        : Math.min(objectStart, arrayStart);
    if (first < 0) return withoutFence;
    const opener = withoutFence[first];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = first; index < withoutFence.length; index += 1) {
      const character = withoutFence[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === opener) {
        depth += 1;
      } else if (character === closer) {
        depth -= 1;
        if (depth === 0) return withoutFence.slice(first, index + 1);
      }
    }
    return withoutFence.slice(first);
  }

  function parseJsonValue(value) {
    if (value && typeof value === "object") return value;
    const cleaned = cleanJsonText(value);
    try {
      return JSON.parse(cleaned);
    } catch (firstError) {
      try {
        return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
      } catch (_) {
        const error = new Error(`模型返回不是有效JSON：${firstError.message}`);
        error.code = "MODEL_JSON_INVALID";
        error.rawModelOutput = String(value == null ? "" : value);
        throw error;
      }
    }
  }

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label}必须是有效数字。`);
    return number;
  }

  function rangedNumber(value, label, min, max) {
    const number = finiteNumber(value, label);
    if (number < min || number > max) throw new Error(`${label}必须在${min}到${max}之间。`);
    return number;
  }

  function requiredBoolean(value, label) {
    if (typeof value !== "boolean") throw new Error(`${label}必须是布尔值。`);
    return value;
  }

  function normalizeHexColor(value) {
    const raw = String(value || "").trim().toUpperCase();
    const expanded = /^#[0-9A-F]{3}$/.test(raw)
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    if (!/^#[0-9A-F]{6}$/.test(expanded)) throw new Error(`颜色参数无效：${value || "空"}`);
    return expanded;
  }

  function normalizeTarget(value) {
    const target = value && typeof value === "object" ? value : {};
    const scope = String(target.scope || "active_layer").trim();
    if (!TARGET_SCOPES.has(scope)) throw new Error(`不支持的目标范围：${scope}`);
    const result = { scope };
    if (scope === "layer_name") {
      result.query = String(target.query || target.layerName || "").trim();
      if (!result.query) throw new Error("按图层名称定位时必须提供名称。");
    }
    if (scope === "text_content") {
      result.query = String(target.query || target.text || "").trim();
      if (!result.query) throw new Error("按文字内容定位时必须提供文字。");
    }
    if (scope === "layer_id") {
      result.id = Math.round(finiteNumber(target.id, "图层ID"));
      if (result.id < 1) throw new Error("图层ID必须是正整数。");
    }
    if (scope === "layer_path") {
      result.query = String(target.query || target.path || "").trim();
      if (!result.query) throw new Error("按完整路径定位时必须提供路径。");
    }
    if (scope === "operation_result") {
      result.resultOf = String(target.resultOf || target.operationId || "").trim();
      if (!result.resultOf) throw new Error("引用上一步结果时必须提供resultOf。");
    }
    return result;
  }

  function normalizeAnchor(value) {
    const anchor = String(value || "middle_center").toLowerCase();
    if (!ANCHORS.has(anchor)) throw new Error(`锚点无效：${anchor}`);
    return anchor;
  }

  function normalizeBounds(params) {
    params.unit = String(params.unit || "pixels").toLowerCase();
    if (!new Set(["pixels", "percent", "normalized"]).has(params.unit)) throw new Error("区域单位必须是pixels、percent或normalized。");
    const normalized = params.unit === "normalized";
    const max = normalized ? 1 : params.unit === "percent" ? 100 : 300000;
    params.left = rangedNumber(params.left, "区域左边界", 0, max);
    params.top = rangedNumber(params.top, "区域上边界", 0, max);
    params.right = rangedNumber(params.right, "区域右边界", 0, max);
    params.bottom = rangedNumber(params.bottom, "区域下边界", 0, max);
    if (normalized) {
      params.left *= 100;
      params.top *= 100;
      params.right *= 100;
      params.bottom *= 100;
      params.unit = "percent";
    }
    if (params.right <= params.left || params.bottom <= params.top) throw new Error("区域右/下边界必须大于左/上边界。");
    params.feather = rangedNumber(params.feather == null ? 0 : params.feather, "选区羽化", 0, 1000);
    params.antiAlias = params.antiAlias !== false;
    params.mode = String(params.mode || "replace").toLowerCase();
    if (!new Set(["replace", "add", "subtract", "intersect"]).has(params.mode)) throw new Error("选区合并模式必须是replace、add、subtract或intersect。");
    return params;
  }

  function normalizeVisualObject(params) {
    const contractApi = visualContractApi(false);
    if (contractApi) {
      const plannedContract = contractApi.buildPlannedContract(params);
      params.visualContract = plannedContract;
      params.description = plannedContract.target.label || params.description;
      const legacyScope = String(params.semanticScope || "unknown").toLowerCase();
      if (!params.semanticScope || legacyScope === "unknown") params.semanticScope = plannedContract.target.scope;
      if (!Array.isArray(params.sourceColorFamilies)) {
        params.sourceColorFamilies = [...plannedContract.target.sourceColorFamilies];
      }
    }
    params.description = String(params.description || "").trim().slice(0, 240);
    if (!params.description) throw new Error("自动视觉定位必须说明目标对象。");
    const requested = String(params.semanticScope || "unknown").toLowerCase();
    params.semanticScope = requested === "part" ? "subpart" : requested;
    if (!VISUAL_SEMANTIC_SCOPES.has(params.semanticScope)) throw new Error("视觉目标语义范围无效。");
    params.unit = String(params.unit || "percent").toLowerCase();
    if (!new Set(["pixels", "percent", "normalized"]).has(params.unit)) throw new Error("视觉定位坐标单位必须是pixels、percent或normalized。");
    const normalized = params.unit === "normalized";
    const max = normalized ? 1 : params.unit === "percent" ? 100 : 300000;
    const region = params.searchRegion && typeof params.searchRegion === "object" ? { ...params.searchRegion } : {};
    const targetBox = params.targetBox && typeof params.targetBox === "object" ? { ...params.targetBox } : {};
    region.left = rangedNumber(region.left, "视觉搜索区左边界", 0, max);
    region.top = rangedNumber(region.top, "视觉搜索区上边界", 0, max);
    region.right = rangedNumber(region.right, "视觉搜索区右边界", 0, max);
    region.bottom = rangedNumber(region.bottom, "视觉搜索区下边界", 0, max);
    targetBox.left = rangedNumber(targetBox.left, "视觉目标框左边界", 0, max);
    targetBox.top = rangedNumber(targetBox.top, "视觉目标框上边界", 0, max);
    targetBox.right = rangedNumber(targetBox.right, "视觉目标框右边界", 0, max);
    targetBox.bottom = rangedNumber(targetBox.bottom, "视觉目标框下边界", 0, max);
    if (region.right <= region.left || region.bottom <= region.top) throw new Error("视觉搜索区右/下边界必须大于左/上边界。");
    if (targetBox.right <= targetBox.left || targetBox.bottom <= targetBox.top) throw new Error("视觉目标框右/下边界必须大于左/上边界。");
    const seed = params.seed && typeof params.seed === "object" ? { ...params.seed } : {};
    seed.x = rangedNumber(seed.x, "视觉种子点X", 0, max);
    seed.y = rangedNumber(seed.y, "视觉种子点Y", 0, max);
    if (normalized) {
      region.left *= 100;
      region.top *= 100;
      region.right *= 100;
      region.bottom *= 100;
      targetBox.left *= 100;
      targetBox.top *= 100;
      targetBox.right *= 100;
      targetBox.bottom *= 100;
      seed.x *= 100;
      seed.y *= 100;
      params.unit = "percent";
    }
    const normalizeVisualPoints = (values, label, limit) => Array.isArray(values) ? values.slice(0, limit).map((value, index) => {
      const point = value && typeof value === "object" ? { ...value } : {};
      point.x = rangedNumber(point.x, `视觉${label}点${index + 1}的X`, 0, max);
      point.y = rangedNumber(point.y, `视觉${label}点${index + 1}的Y`, 0, max);
      if (normalized) {
        point.x *= 100;
        point.y *= 100;
      }
      return point;
    }) : [];
    const positivePoints = normalizeVisualPoints(params.positivePoints, "补选", 15);
    const excludePoints = normalizeVisualPoints(params.excludePoints, "排除", 16);
    if (
      targetBox.left < region.left || targetBox.top < region.top
      || targetBox.right > region.right || targetBox.bottom > region.bottom
    ) {
      throw new Error("视觉目标紧框必须完整位于搜索区域内。");
    }
    if (seed.x < targetBox.left || seed.x > targetBox.right || seed.y < targetBox.top || seed.y > targetBox.bottom) {
      throw new Error("视觉种子点必须位于目标紧框内。");
    }
    params.searchRegion = region;
    params.targetBox = targetBox;
    params.seed = seed;
    for (const point of excludePoints) {
      if (point.x < region.left || point.x > region.right || point.y < region.top || point.y > region.bottom) {
        throw new Error("视觉排除点必须位于搜索区域内。");
      }
    }
    params.excludePoints = excludePoints;
    params.positivePoints = positivePoints;
    for (const point of positivePoints) {
      if (point.x < region.left || point.x > region.right || point.y < region.top || point.y > region.bottom) {
        throw new Error("视觉补选点必须位于搜索区域内。");
      }
    }
    if (params.color != null) params.color = normalizeHexColor(params.color);
    const colors = Array.isArray(params.colors) ? params.colors.slice(0, 6).map(normalizeHexColor) : [];
    if (params.color && !colors.includes(params.color)) colors.unshift(params.color);
    params.colors = [...new Set(colors)].slice(0, 6);
    const allowedSourceFamilies = new Set(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "black", "white", "gray", "brown"]);
    params.sourceColorFamilies = Array.isArray(params.sourceColorFamilies)
      ? [...new Set(params.sourceColorFamilies.slice(0, 4).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
      : [];
    if (params.sourceColorFamilies.some((value) => !allowedSourceFamilies.has(value))) {
      throw new Error("视觉目标原颜色类别无效。");
    }
    params.sourceColors = Array.isArray(params.sourceColors)
      ? [...new Set(params.sourceColors.slice(0, 6).map(normalizeHexColor))]
      : [];
    params.colorRefine = String(params.colorRefine || "auto").toLowerCase();
    if (!new Set(["auto", "source", "none"]).has(params.colorRefine)) {
      throw new Error("视觉源颜色细化模式无效。");
    }
    params.allowColorFallback = params.allowColorFallback === true;
    params.selectionMode = String(params.selectionMode || "semantic").toLowerCase();
    if (!new Set(["semantic", "seeded", "all_in_region"]).has(params.selectionMode)) throw new Error("视觉对象选区模式无效。");
    if (!params.allowColorFallback) params.selectionMode = "semantic";
    params.tolerance = Math.round(rangedNumber(params.tolerance == null ? 52 : params.tolerance, "视觉颜色容差", 8, 128));
    params.softness = Math.round(rangedNumber(params.softness == null ? 10 : params.softness, "视觉边缘柔和", 0, 64));
    params.feather = rangedNumber(params.feather == null ? 1 : params.feather, "视觉选区羽化", 0, 30);
    params.confidence = rangedNumber(params.confidence, "视觉定位置信度", 0, 1);
    params.confidenceBand = classifyConfidence(params.confidence).level;
    params.requiresHumanConfirmation = true;
    params.maxCoverage = rangedNumber(params.maxCoverage == null ? 0.72 : params.maxCoverage, "最大允许覆盖率", 0.05, 0.9);
    if (contractApi) {
      params.visualContract = contractApi.normalizeContract({
        ...params.visualContract,
        target: {
          ...params.visualContract.target,
          label: params.visualContract.target.label || params.description,
          scope: params.semanticScope,
          sourceColorFamilies: params.sourceColorFamilies
        }
      });
      params.protectedRegions = [...params.visualContract.protectedRegions];
      params.preserveAppearance = [...params.visualContract.preserveAppearance];
    }
    return params;
  }

  function normalizeSubjectRegion(params) {
    params.description = String(params.description || "").trim().slice(0, 240);
    if (!params.description) throw new Error("区域主体定位必须说明目标对象。");
    params.unit = String(params.unit || "percent").toLowerCase();
    if (!new Set(["pixels", "percent", "normalized"]).has(params.unit)) throw new Error("区域主体坐标单位必须是pixels、percent或normalized。");
    const normalized = params.unit === "normalized";
    const max = normalized ? 1 : params.unit === "percent" ? 100 : 300000;
    const region = params.searchRegion && typeof params.searchRegion === "object" ? { ...params.searchRegion } : {};
    region.left = rangedNumber(region.left, "主体搜索区左边界", 0, max);
    region.top = rangedNumber(region.top, "主体搜索区上边界", 0, max);
    region.right = rangedNumber(region.right, "主体搜索区右边界", 0, max);
    region.bottom = rangedNumber(region.bottom, "主体搜索区下边界", 0, max);
    if (normalized) {
      region.left *= 100;
      region.top *= 100;
      region.right *= 100;
      region.bottom *= 100;
      params.unit = "percent";
    }
    if (region.right <= region.left || region.bottom <= region.top) throw new Error("主体搜索区右/下边界必须大于左/上边界。");
    params.searchRegion = region;
    params.feather = rangedNumber(params.feather == null ? 1 : params.feather, "主体选区羽化", 0, 30);
    params.confidence = rangedNumber(params.confidence, "主体区域定位置信度", 0, 1);
    params.confidenceBand = classifyConfidence(params.confidence).level;
    params.requiresHumanConfirmation = true;
    params.sampleAllLayers = params.sampleAllLayers !== false;
    return params;
  }

  function normalizeReferenceParams(params, action) {
    params.reference = String(params.reference || "selection").toLowerCase();
    if (!REFERENCES.has(params.reference)) throw new Error("参考区域必须是selection或canvas。");
    params.padding = rangedNumber(params.padding == null ? 0 : params.padding, "内边距", 0, 100000);
    const singleAxisAlignment = action === "layer.align_to_reference";
    params.horizontal = String(params.horizontal || (singleAxisAlignment ? "preserve" : "center")).toLowerCase();
    params.vertical = String(params.vertical || (singleAxisAlignment ? "preserve" : "middle")).toLowerCase();
    if (!HORIZONTAL_ALIGNMENTS.has(params.horizontal)) throw new Error("水平对齐方式无效。");
    if (!VERTICAL_ALIGNMENTS.has(params.vertical)) throw new Error("垂直对齐方式无效。");
    if (params.allowUpscale != null) params.allowUpscale = requiredBoolean(params.allowUpscale, "允许放大");
    else params.allowUpscale = false;
    return params;
  }

  function normalizeTextStyle(params, requireAny) {
    const supported = [
      "size", "color", "font", "leading", "tracking", "justification", "fauxBold",
      "fauxItalic", "horizontalScale", "verticalScale", "baselineShift", "orientation",
      "hyphenation", "firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"
    ];
    if (params.size != null) params.size = rangedNumber(params.size, "字号", 0.1, 1296);
    if (params.color != null) params.color = normalizeHexColor(params.color);
    if (params.font != null) {
      params.font = String(params.font).trim();
      if (!params.font) throw new Error("字体名称不能为空。");
    }
    if (params.leading != null) params.leading = rangedNumber(params.leading, "行距", 0, 10000);
    if (params.tracking != null) params.tracking = rangedNumber(params.tracking, "字距", -1000, 10000);
    if (params.justification != null) {
      params.justification = String(params.justification).toLowerCase();
      if (!JUSTIFICATIONS.has(params.justification)) throw new Error("段落对齐方式无效。");
    }
    if (params.fauxBold != null) params.fauxBold = requiredBoolean(params.fauxBold, "仿粗体");
    if (params.fauxItalic != null) params.fauxItalic = requiredBoolean(params.fauxItalic, "仿斜体");
    if (params.horizontalScale != null) params.horizontalScale = rangedNumber(params.horizontalScale, "水平缩放", 1, 1000);
    if (params.verticalScale != null) params.verticalScale = rangedNumber(params.verticalScale, "垂直缩放", 1, 1000);
    if (params.baselineShift != null) params.baselineShift = rangedNumber(params.baselineShift, "基线偏移", -10000, 10000);
    if (params.orientation != null) {
      params.orientation = String(params.orientation).toLowerCase();
      if (!new Set(["horizontal", "vertical"]).has(params.orientation)) throw new Error("文字方向必须是horizontal或vertical。");
    }
    if (params.hyphenation != null) params.hyphenation = requiredBoolean(params.hyphenation, "连字符状态");
    for (const key of ["firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"]) {
      if (params[key] != null) params[key] = rangedNumber(params[key], key, -1296, 1296);
    }
    if (requireAny && !supported.some((key) => params[key] != null)) throw new Error("文字组样式没有包含可执行属性。");
    return params;
  }

  function normalizeParams(action, value) {
    const supplied = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const params = { ...defaultsForAction(action), ...supplied };
    if (action === "layer.create_pixel" || action === "layer.create_group") {
      params.name = String(params.name || (action.endsWith("group") ? "新建组" : "新建图层")).trim().slice(0, 160);
    } else if (action === "text.create") {
      params.name = String(params.name || "新建文字").trim().slice(0, 160);
      params.content = String(params.content == null ? "文字" : params.content);
      normalizeTextStyle(params, false);
    } else if (action === "layer.rename") {
      params.name = String(params.name || "").trim();
      if (!params.name) throw new Error("重命名缺少新名称。");
    } else if (action === "layer.set_visibility") {
      params.visible = requiredBoolean(params.visible, "显示/隐藏参数");
    } else if (action === "layer.set_opacity" || action === "layer.set_fill_opacity") {
      const key = action.endsWith("fill_opacity") ? "fillOpacity" : "opacity";
      params[key] = rangedNumber(params[key] == null ? params.opacity : params[key], key === "opacity" ? "不透明度" : "填充不透明度", 0, 100);
      if (key !== "opacity") delete params.opacity;
    } else if (action === "layer.set_blend_mode") {
      params.blendMode = String(params.blendMode || "").trim();
      const canonical = [...BLEND_MODES].find((mode) => mode.toLowerCase() === params.blendMode.toLowerCase());
      if (!canonical) throw new Error(`混合模式无效：${params.blendMode || "空"}`);
      params.blendMode = canonical;
    } else if (action === "layer.set_lock") {
      params.lock = String(params.lock || "all");
      if (!new Set(["all", "pixels", "position", "transparentPixels"]).has(params.lock)) throw new Error("锁定类型无效。");
      params.locked = requiredBoolean(params.locked, "锁定状态");
    } else if (action === "layer.move_by") {
      params.deltaX = rangedNumber(params.deltaX == null ? 0 : params.deltaX, "水平移动", -100000, 100000);
      params.deltaY = rangedNumber(params.deltaY == null ? 0 : params.deltaY, "垂直移动", -100000, 100000);
      if (!params.deltaX && !params.deltaY) throw new Error("移动距离不能同时为0。");
    } else if (action === "layer.scale") {
      params.scaleX = rangedNumber(params.scaleX == null ? params.scale : params.scaleX, "水平缩放", 0.1, 10000);
      params.scaleY = rangedNumber(params.scaleY == null ? params.scaleX : params.scaleY, "垂直缩放", 0.1, 10000);
    } else if (action === "layer.rotate") {
      params.angle = rangedNumber(params.angle, "旋转角度", -360, 360);
      if (Math.abs(params.angle) < 0.0001) throw new Error("旋转角度不能为0。");
      params.anchor = normalizeAnchor(params.anchor);
    } else if (action === "layer.flip") {
      params.axis = String(params.axis || "horizontal").toLowerCase();
      if (!new Set(["horizontal", "vertical"]).has(params.axis)) throw new Error("翻转方向必须是horizontal或vertical。");
    } else if (action === "layer.skew") {
      params.angleH = rangedNumber(params.angleH == null ? 0 : params.angleH, "水平斜切", -89, 89);
      params.angleV = rangedNumber(params.angleV == null ? 0 : params.angleV, "垂直斜切", -89, 89);
      if (!params.angleH && !params.angleV) throw new Error("斜切角度不能同时为0。");
    } else if (action === "layer.rasterize") {
      params.target = String(params.target || "entire_layer").toLowerCase();
      // Photoshop 2026 UXP does not expose RasterizeType.SMARTOBJECT.
      // Rasterizing an entire smart-object layer is the native equivalent.
      if (params.target === "smart_object") params.target = "entire_layer";
      if (!new Set(["entire_layer", "text", "shape", "layer_style"]).has(params.target)) throw new Error("栅格化目标无效。");
    } else if (action === "layer.set_clipping_mask") {
      params.enabled = requiredBoolean(params.enabled, "剪贴蒙版状态");
    } else if (action === "layer.reorder") {
      params.position = String(params.position || "").toLowerCase();
      if (!new Set(["front", "back"]).has(params.position)) throw new Error("图层顺序只能是front或back。");
    } else if (action === "layer.move_to_group") {
      params.groupName = String(params.groupName || "").trim();
      params.groupResultOf = String(params.groupResultOf || "").trim();
      if (!params.groupName && !params.groupResultOf && params.groupId == null) {
        throw new Error("移入图层组时必须提供目标图层组名称或创建步骤引用。");
      }
      if (params.groupId != null) {
        const parsedGroupId = Number(params.groupId);
        if (!Number.isInteger(parsedGroupId)) throw new Error("目标图层组ID必须是整数。");
        params.groupId = parsedGroupId;
      }
    } else if (["layer.align_to_reference", "layer.fit_to_reference", "text.fit_to_reference", "group.fit_text_to_reference"].includes(action)) {
      normalizeReferenceParams(params, action);
      if (action === "group.fit_text_to_reference") {
        params.arrangement = String(params.arrangement || "preserve").toLowerCase();
        if (!new Set(["preserve", "compact"]).has(params.arrangement)) throw new Error("文字组排列方式无效。");
        normalizeTextStyle(params, false);
      }
    } else if (action === "text.set_content") {
      if (params.content == null) throw new Error("修改文字缺少新内容。");
      params.content = String(params.content);
    } else if (action === "text.set_color") {
      params.color = normalizeHexColor(params.color);
    } else if (action === "text.set_size") {
      params.size = rangedNumber(params.size, "字号", 0.1, 1296);
    } else if (action === "text.set_font") {
      params.font = String(params.font || "").trim();
      if (!params.font) throw new Error("字体名称不能为空。");
    } else if (action === "text.set_leading") {
      params.leading = rangedNumber(params.leading, "行距", 0, 10000);
    } else if (action === "text.set_tracking") {
      params.tracking = rangedNumber(params.tracking, "字距", -1000, 10000);
    } else if (action === "text.set_justification") {
      params.justification = String(params.justification || "").toLowerCase();
      if (!JUSTIFICATIONS.has(params.justification)) throw new Error("段落对齐方式无效。");
    } else if (action === "text.set_faux_bold") {
      params.enabled = requiredBoolean(params.enabled, "仿粗体状态");
    } else if (action === "text.set_faux_italic") {
      params.enabled = requiredBoolean(params.enabled, "仿斜体状态");
    } else if (action === "text.set_horizontal_scale" || action === "text.set_vertical_scale") {
      params.scale = rangedNumber(params.scale, "文字缩放", 1, 1000);
    } else if (action === "text.set_baseline_shift") {
      params.baselineShift = rangedNumber(params.baselineShift, "基线偏移", -10000, 10000);
    } else if (action === "text.set_hyphenation") {
      params.enabled = requiredBoolean(params.enabled, "连字符状态");
    } else if (action === "text.set_paragraph_spacing") {
      const paragraphKeys = ["firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"];
      for (const key of paragraphKeys) if (params[key] != null) params[key] = rangedNumber(params[key], key, -1296, 1296);
      if (!paragraphKeys.some((key) => params[key] != null)) throw new Error("段落间距没有包含可执行属性。");
    } else if (action === "text.set_orientation") {
      params.orientation = String(params.orientation || "").toLowerCase();
      if (!new Set(["horizontal", "vertical"]).has(params.orientation)) throw new Error("文字方向必须是horizontal或vertical。");
    } else if (action === "group.set_text_style") {
      normalizeTextStyle(params, true);
    } else if (action === "filter.gaussian_blur" || action === "filter.high_pass") {
      params.radius = rangedNumber(params.radius, "滤镜半径", 0.1, action === "filter.gaussian_blur" ? 250 : 1000);
    } else if (action === "filter.motion_blur") {
      params.angle = rangedNumber(params.angle == null ? 0 : params.angle, "动感模糊角度", -360, 360);
      params.distance = rangedNumber(params.distance, "动感模糊距离", 1, 2000);
    } else if (action === "filter.add_noise") {
      params.amount = rangedNumber(params.amount, "杂色数量", 0.1, 400);
      params.distribution = String(params.distribution || "uniform").toLowerCase();
      if (!new Set(["uniform", "gaussian"]).has(params.distribution)) throw new Error("杂色分布必须是uniform或gaussian。");
      params.monochromatic = Boolean(params.monochromatic);
    } else if (action === "filter.unsharp_mask") {
      params.amount = rangedNumber(params.amount, "锐化数量", 1, 500);
      params.radius = rangedNumber(params.radius, "锐化半径", 0.1, 1000);
      params.threshold = Math.round(rangedNumber(params.threshold == null ? 0 : params.threshold, "锐化阈值", 0, 255));
    } else if (action === "selection.rectangle" || action === "selection.ellipse") {
      normalizeBounds(params);
    } else if (action === "selection.polygon") {
      params.unit = String(params.unit || "pixels").toLowerCase();
      if (!new Set(["pixels", "percent", "normalized"]).has(params.unit)) throw new Error("多边形坐标单位必须是pixels、percent或normalized。");
      if (!Array.isArray(params.points) || params.points.length < 3 || params.points.length > 200) throw new Error("多边形选区必须包含3到200个点。");
      const normalized = params.unit === "normalized";
      const max = normalized ? 1 : params.unit === "percent" ? 100 : 300000;
      params.points = params.points.map((point, index) => ({
        x: rangedNumber(point && point.x, `第${index + 1}个点X`, 0, max),
        y: rangedNumber(point && point.y, `第${index + 1}个点Y`, 0, max)
      }));
      if (normalized) {
        params.points = params.points.map((point) => ({ x: point.x * 100, y: point.y * 100 }));
        params.unit = "percent";
      }
      params.feather = rangedNumber(params.feather == null ? 0 : params.feather, "选区羽化", 0, 1000);
      params.antiAlias = params.antiAlias !== false;
      params.mode = String(params.mode || "replace").toLowerCase();
      if (!new Set(["replace", "add", "subtract", "intersect"]).has(params.mode)) throw new Error("多边形选区合并模式无效。");
    } else if (action === "selection.subject") {
      params.sampleAllLayers = params.sampleAllLayers !== false;
    } else if (action === "selection.subject_region") {
      normalizeSubjectRegion(params);
    } else if (action === "selection.color_range") {
      params.color = normalizeHexColor(params.color);
      params.tolerance = Math.round(rangedNumber(params.tolerance == null ? 32 : params.tolerance, "颜色容差", 0, 255));
      params.softness = Math.round(rangedNumber(params.softness == null ? 8 : params.softness, "颜色边缘柔和", 0, 255));
    } else if (action === "selection.visual_object") {
      normalizeVisualObject(params);
    } else if (["selection.expand", "selection.contract"].includes(action)) {
      params.by = Math.round(rangedNumber(params.by, "选区修改量", 1, 500));
      params.applyAtCanvasBounds = Boolean(params.applyAtCanvasBounds);
    } else if (action === "selection.feather") {
      params.by = rangedNumber(params.by, "羽化量", 0.1, 1000);
      params.applyAtCanvasBounds = Boolean(params.applyAtCanvasBounds);
    } else if (action === "selection.border") {
      params.width = Math.round(rangedNumber(params.width, "边界宽度", 1, 200));
    } else if (action === "selection.grow") {
      params.tolerance = Math.round(rangedNumber(params.tolerance == null ? 32 : params.tolerance, "容差", 0, 255));
      params.antiAlias = params.antiAlias !== false;
    } else if (action === "selection.smooth") {
      params.radius = Math.round(rangedNumber(params.radius, "平滑半径", 1, 500));
      params.applyAtCanvasBounds = Boolean(params.applyAtCanvasBounds);
    } else if (action === "mask.set_density") {
      params.density = rangedNumber(params.density, "蒙版密度", 0, 100);
    } else if (action === "mask.set_feather") {
      params.feather = rangedNumber(params.feather, "蒙版羽化", 0, 1000);
    } else if (action === "adjustment.brightness_contrast") {
      params.brightness = rangedNumber(params.brightness == null ? 0 : params.brightness, "亮度", -150, 150);
      params.contrast = rangedNumber(params.contrast == null ? 0 : params.contrast, "对比度", -100, 100);
      if (!params.brightness && !params.contrast) throw new Error("亮度和对比度不能同时为0。");
      params.name = String(params.name || "AI 局部亮度对比度").trim().slice(0, 160);
    } else if (action === "adjustment.levels") {
      params.inputBlack = Math.round(rangedNumber(params.inputBlack == null ? 0 : params.inputBlack, "输入黑场", 0, 254));
      params.inputWhite = Math.round(rangedNumber(params.inputWhite == null ? 255 : params.inputWhite, "输入白场", 1, 255));
      params.gamma = rangedNumber(params.gamma == null ? 1 : params.gamma, "中间调", 0.1, 9.99);
      params.outputBlack = Math.round(rangedNumber(params.outputBlack == null ? 0 : params.outputBlack, "输出黑场", 0, 254));
      params.outputWhite = Math.round(rangedNumber(params.outputWhite == null ? 255 : params.outputWhite, "输出白场", 1, 255));
      if (params.inputWhite <= params.inputBlack || params.outputWhite <= params.outputBlack) throw new Error("色阶白场必须大于黑场。");
      if (params.inputBlack === 0 && params.inputWhite === 255 && params.gamma === 1 && params.outputBlack === 0 && params.outputWhite === 255) throw new Error("色阶参数没有产生任何调整。");
      params.name = String(params.name || "AI 局部色阶").trim().slice(0, 160);
    } else if (action === "adjustment.curves") {
      if (!Array.isArray(params.points) || params.points.length < 2 || params.points.length > 16) throw new Error("曲线必须包含2到16个控制点。");
      params.points = params.points.map((point, index) => ({
        input: Math.round(rangedNumber(point && point.input, `曲线第${index + 1}点输入`, 0, 255)),
        output: Math.round(rangedNumber(point && point.output, `曲线第${index + 1}点输出`, 0, 255))
      })).sort((a, b) => a.input - b.input);
      if (new Set(params.points.map((point) => point.input)).size !== params.points.length) throw new Error("曲线控制点的输入值不能重复。");
      if (params.points.every((point) => point.input === point.output)) throw new Error("曲线参数没有产生任何调整。");
      params.name = String(params.name || "AI 局部曲线").trim().slice(0, 160);
    } else if (action === "adjustment.vibrance") {
      params.vibrance = rangedNumber(params.vibrance == null ? 0 : params.vibrance, "自然饱和度", -100, 100);
      params.saturation = rangedNumber(params.saturation == null ? 0 : params.saturation, "饱和度", -100, 100);
      if (!params.vibrance && !params.saturation) throw new Error("自然饱和度和饱和度不能同时为0。");
      params.name = String(params.name || "AI 局部自然饱和度").trim().slice(0, 160);
    } else if (action === "adjustment.exposure") {
      params.exposure = rangedNumber(params.exposure == null ? 0 : params.exposure, "曝光度", -20, 20);
      params.offset = rangedNumber(params.offset == null ? 0 : params.offset, "曝光偏移", -0.5, 0.5);
      params.gamma = rangedNumber(params.gamma == null ? 1 : params.gamma, "伽马", 0.01, 9.99);
      if (!params.exposure && !params.offset && params.gamma === 1) throw new Error("曝光参数没有产生任何调整。");
      params.name = String(params.name || "AI 局部曝光").trim().slice(0, 160);
    } else if (action === "adjustment.black_white") {
      for (const [key, fallback] of Object.entries({ red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 })) {
        params[key] = rangedNumber(params[key] == null ? fallback : params[key], `${key}黑白转换`, -200, 300);
      }
      params.name = String(params.name || "AI 局部黑白").trim().slice(0, 160);
    } else if (action === "adjustment.hue_saturation") {
      params.hue = rangedNumber(params.hue == null ? 0 : params.hue, "色相", -180, 180);
      params.saturation = rangedNumber(params.saturation == null ? 0 : params.saturation, "饱和度", -100, 100);
      params.lightness = rangedNumber(params.lightness == null ? 0 : params.lightness, "明度", -100, 100);
      if (!params.hue && !params.saturation && !params.lightness) throw new Error("色相、饱和度和明度不能同时为0。");
      params.name = String(params.name || "AI 局部色相饱和度").trim().slice(0, 160);
    } else if (action === "adjustment.colorize") {
      params.color = normalizeHexColor(params.color);
      params.opacity = rangedNumber(params.opacity == null ? 100 : params.opacity, "颜色化不透明度", 0, 100);
      if (params.opacity === 0) throw new Error("颜色化不透明度为0时不会产生可见调整。");
      params.blendMode = String(params.blendMode || "normal").trim();
      if (!new Set(["color", "normal"]).has(params.blendMode)) throw new Error("改色混合模式无效。");
      params.name = String(params.name || "AI 局部改色").trim().slice(0, 160);
    } else if (action === "document.resize_image") {
      if (params.width == null && params.height == null) throw new Error("调整图像大小至少需要宽度或高度。");
      if (params.width != null) params.width = rangedNumber(params.width, "图像宽度", 1, 300000);
      if (params.height != null) params.height = rangedNumber(params.height, "图像高度", 1, 300000);
      if (params.resolution != null) params.resolution = rangedNumber(params.resolution, "分辨率", 1, 12000);
      params.constrainProportions = params.constrainProportions !== false;
    } else if (action === "document.resize_canvas") {
      params.width = rangedNumber(params.width, "画布宽度", 1, 300000);
      params.height = rangedNumber(params.height, "画布高度", 1, 300000);
      params.anchor = normalizeAnchor(params.anchor);
    } else if (action === "document.crop") {
      params.reference = String(params.reference || "selection").toLowerCase();
      if (!new Set(["selection", "bounds"]).has(params.reference)) throw new Error("裁剪参考必须是selection或bounds。");
      if (params.reference === "bounds") normalizeBounds(params);
    } else if (action === "document.rotate") {
      params.angle = rangedNumber(params.angle, "画布旋转角度", -360, 360);
      if (Math.abs(params.angle) < 0.0001) throw new Error("画布旋转角度不能为0。");
    } else if (action === "document.trim") {
      params.type = String(params.type || "transparent").toLowerCase();
      if (!new Set(["transparent", "top_left", "bottom_right"]).has(params.type)) throw new Error("裁切类型无效。");
      for (const key of ["top", "left", "bottom", "right"]) params[key] = params[key] !== false;
    } else if (action === "document.export") {
      params.format = String(params.format || "png").toLowerCase().replace("jpeg", "jpg");
      if (!new Set(["png", "jpg", "psd", "psb", "gif", "bmp"]).has(params.format)) throw new Error("导出格式无效。");
      params.quality = Math.round(rangedNumber(params.quality == null ? 10 : params.quality, "JPEG质量", 1, 12));
      params.asCopy = params.asCopy !== false;
    }
    if (String(action || "").startsWith("filter.")) params.useSelection = Boolean(params.useSelection);
    return params;
  }

  function normalizeOperation(value, index, options = {}) {
    if (!value || typeof value !== "object") throw new Error(`第${index + 1}个操作不是对象。`);
    const action = String(value.action || "").trim();
    if (!ACTIONS.has(action)) throw new Error(`v9.8尚未接入能力：${action || "空"}`);
    const requirementIds = Array.isArray(value.requirementIds)
      ? [...new Set(value.requirementIds.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 16)
      : [];
    if (!requirementIds.length && options.allowUnlinkedRequirements !== true) {
      throw new Error(`第${index + 1}个操作必须至少引用一个用户需求 requirementId。`);
    }
    return {
      id: String(value.id || `operation_${index + 1}`),
      action,
      target: normalizeTarget(value.target),
      params: normalizeParams(action, value.params),
      reason: String(value.reason || "").trim().slice(0, 240),
      requirementIds
    };
  }

  function normalizeIntent(value, options = {}) {
    const raw = parseJsonValue(value);
    if (!raw || typeof raw !== "object") throw new Error("模型没有返回有效意图对象。");
    const source = Array.isArray(raw.operations) ? raw.operations : [];
    if (!source.length) throw new Error("没有解析出可执行操作。");
    if (source.length > 12) throw new Error("一次最多执行12个操作，请拆分指令。");
    return {
      version: "9.8",
      summary: String(raw.summary || "已理解指令。目标将在执行前由程序绑定。").trim().slice(0, 500),
      operations: source.map((operation, index) => normalizeOperation(operation, index, options)),
      constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String).slice(0, 12) : [],
      ambiguities: Array.isArray(raw.ambiguities) ? raw.ambiguities.map(String).filter(Boolean).slice(0, 8) : []
    };
  }

  return {
    ACTIONS,
    ACTION_CONTRACTS,
    TARGET_SCOPES,
    BLEND_MODES,
    JUSTIFICATIONS,
    ANCHORS,
    NAMED_COLORS,
    ACTION_DEFAULTS,
    INSTRUCTION_DEFAULTS,
    PARAMETER_CATEGORIES,
    defaultsForAction,
    defaultsForInstruction,
    parameterCategory,
    classifyConfidence,
    VISUAL_SEMANTIC_SCOPES,
    cleanJsonText,
    parseJsonValue,
    normalizeHexColor,
    classifyVisualTargetInstruction,
    hasExplicitVisualSpatialProtection,
    buildUserVisualContract,
    buildPlannedVisualContract,
    auditVisualContract,
    applyAuthoritativeVisualContract,
    visualAppearanceConstraints,
    normalizeVisualContract(value) {
      return visualContractApi().normalizeContract(value);
    },
    visualContract: visualContractApi(false),
    normalizeIntent
  };
});
