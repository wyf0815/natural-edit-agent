(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV97VisualContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONTRACT_VERSION = "1";
  const SCOPES = new Set(["whole_object", "subpart", "unknown"]);
  const COLOR_FAMILIES = new Set([
    "red", "orange", "yellow", "green", "cyan", "blue",
    "purple", "pink", "black", "white", "gray", "brown"
  ]);

  const COLOR_RULES = Object.freeze([
    ["red", /(?:红|赤)(?:色)?|\bred\b/gi],
    ["orange", /橙(?:色)?|橘(?:色)?|\borange\b/gi],
    ["yellow", /黄(?:色)?|金黄(?:色)?|\byellow\b/gi],
    ["green", /绿(?:色)?|翠绿(?:色)?|\bgreen\b/gi],
    ["cyan", /青(?:色)?|青蓝(?:色)?|\bcyan\b/gi],
    ["blue", /蓝(?:色)?|蔚蓝(?:色)?|\bblue\b/gi],
    ["purple", /紫(?:色)?|\bpurple\b/gi],
    ["pink", /粉(?:色)?|粉红(?:色)?|\bpink\b/gi],
    ["black", /黑(?:色)?|\bblack\b/gi],
    ["white", /白(?:色)?|\bwhite\b/gi],
    ["gray", /灰(?:色)?|灰白(?:色)?|\bgr[ae]y\b/gi],
    ["brown", /棕(?:色)?|褐(?:色)?|\bbrown\b/gi]
  ]);

  const POSITION_RULES = Object.freeze([
    ["top_left", /左上(?:角|方)?/g],
    ["top_right", /右上(?:角|方)?/g],
    ["bottom_left", /左下(?:角|方)?/g],
    ["bottom_right", /右下(?:角|方)?/g],
    ["left", /左(?:边|侧|方)/g],
    ["right", /右(?:边|侧|方)/g],
    ["top", /(?:顶部|上方|上边)/g],
    ["bottom", /(?:底部|下方|下边)/g],
    ["center", /(?:中间|中央|中心)/g],
    ["foreground", /前景/g],
    ["background", /背景/g]
  ]);

  const POSITION_ALIASES = Object.freeze({
    upper_left: "top_left",
    upper_right: "top_right",
    lower_left: "bottom_left",
    lower_right: "bottom_right",
    middle: "center",
    centre: "center"
  });

  const PART_RULES = Object.freeze([
    ["头发", /头发|发丝|发型/],
    ["胡须", /胡子|胡须/],
    ["眉毛", /眉毛/],
    ["眼睛", /眼睛|眼球/],
    ["嘴", /嘴巴|嘴部|嘴/],
    ["牙齿", /牙齿/],
    ["舌头", /舌头/],
    ["脸", /脸部|面部|脸/],
    ["皮肤", /皮肤/],
    ["身体", /身体|躯干/],
    ["手臂", /胳膊|手臂/],
    ["手", /手掌|左手|右手|双手|手/],
    ["腿", /腿部|小腿|大腿|腿/],
    ["脚", /脚部|双脚|脚/],
    ["衣服", /衣服|服装/],
    ["衣袖", /衣袖|袖口/],
    ["领口", /领口/],
    ["帽檐", /帽檐/],
    ["毛发", /毛发|毛皮|绒毛/],
    ["树冠", /树冠/],
    ["叶片", /叶子|叶片/],
    ["花瓣", /花瓣/],
    ["图案", /花纹|图案|斑点/],
    ["徽章", /徽章|徽标|标志/],
    ["标签", /标签/],
    ["把手", /把手/],
    ["底座", /底座/],
    ["轮子", /轮子|车轮/],
    ["屏幕", /屏幕/],
    ["按钮", /按钮/],
    ["局部", /局部|部分|区域|色块|小点|圆点|污点/]
  ]);

  const APPEARANCE_RULES = Object.freeze([
    ["highlights", /高光|亮部|反光/],
    ["shadows", /阴影|暗部/],
    ["lighting", /明暗|亮暗|光影|光泽|色阶/],
    ["texture", /纹理|质感|褶皱/],
    ["surface_detail", /细节|材质|样式/],
    ["depth", /立体感?|层次感?|体积感/],
    ["outline", /轮廓|描边/],
    ["edges", /边缘/],
    ["shape", /形状|外形/],
    ["pattern", /花纹|图案|斑纹/],
    ["gradient", /渐变/],
    ["color", /颜色|色彩/],
    ["tone", /色调|色相/],
    ["brightness", /亮度|明度/],
    ["saturation", /饱和度/],
    ["contrast", /对比度/],
    ["transparency", /透明度|半透明/]
  ]);

  const APPEARANCE_ALIASES = Object.freeze({
    highlight: "highlights",
    shadow: "shadows",
    light: "lighting",
    details: "surface_detail",
    detail: "surface_detail",
    dimensionality: "depth",
    contour: "outline",
    edge: "edges"
  });

  const CHANGE_VERB_SOURCE = "改成|改为|变成|换成|换为|调成|调为|调整为|设为|设成|设置为|设置成|替换为|替换成|上色为|改色为|换色为";
  const CHANGE_VERB_PATTERN = new RegExp(`(?:${CHANGE_VERB_SOURCE})`);
  const DESTINATION_COLOR_PATTERN = new RegExp(`(?:${CHANGE_VERB_SOURCE})\\s*([^，,。；;\\n]{0,32})`, "g");
  const COLOR_VALUE_SOURCE = "(?:#[0-9a-fA-F]{3,8}|(?:红|赤|橙|橘|黄|金黄|绿|翠绿|青|青蓝|蓝|蔚蓝|紫|粉|粉红|黑|白|灰|灰白|棕|褐)(?:色)?)";
  const GENERIC_COLOR_ASSIGNMENT_PATTERN = new RegExp(`(?:为|成)\\s*(${COLOR_VALUE_SOURCE})`, "g");
  const ADJUSTMENT_PROPERTY_PATTERN = /自然饱和度|填充不透明度|不透明度|饱和度|对比度|曝光度|亮度|明度|色相|色调|透明度/;
  const PROTECTION_PATTERN = /保持|保留|维持|不变|原样|别动|排除|除外|不包含|不要(?:修改|改变|破坏|改|动)|不能(?:修改|改变|破坏|改)|勿改|其他(?:内容|区域|部分)?/;

  function text(value, limit = 240) {
    return String(value == null ? "" : value).trim().slice(0, limit);
  }

  function unique(values, limit = 32) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
      const normalized = text(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= limit) break;
    }
    return result;
  }

  function reset(pattern) {
    pattern.lastIndex = 0;
    return pattern;
  }

  function matches(pattern, value) {
    const found = reset(pattern).test(String(value || ""));
    reset(pattern);
    return found;
  }

  function colorFamilies(value) {
    const result = [];
    const source = String(value || "");
    for (const [family, pattern] of COLOR_RULES) {
      if (matches(pattern, source)) result.push(family);
    }
    return unique(result, 12);
  }

  function normalizeColorFamilies(values) {
    const result = [];
    for (const raw of Array.isArray(values) ? values : []) {
      const value = text(raw, 32).toLowerCase();
      const normalized = COLOR_FAMILIES.has(value)
        ? value
        : colorFamilies(value)[0];
      if (normalized) result.push(normalized);
    }
    return unique(result, 12);
  }

  function destinationColorFamilies(instruction) {
    const values = [];
    const source = String(instruction || "");
    let match;
    reset(DESTINATION_COLOR_PATTERN);
    while ((match = DESTINATION_COLOR_PATTERN.exec(source))) values.push(...colorFamilies(match[1]));
    reset(DESTINATION_COLOR_PATTERN);
    if (/改|换|变|调|调整|设|设置|替换|上色/.test(source)) {
      reset(GENERIC_COLOR_ASSIGNMENT_PATTERN);
      while ((match = GENERIC_COLOR_ASSIGNMENT_PATTERN.exec(source))) values.push(...colorFamilies(match[1]));
      reset(GENERIC_COLOR_ASSIGNMENT_PATTERN);
    }
    return unique(values, 12);
  }

  function positions(value) {
    const result = [];
    const source = String(value || "");
    for (const [position, pattern] of POSITION_RULES) {
      if (matches(pattern, source)) result.push(position);
    }
    const compound = new Set(result.filter((item) => item.includes("_")));
    return unique(result.filter((item) => {
      if (item === "left" && [...compound].some((entry) => entry.endsWith("_left"))) return false;
      if (item === "right" && [...compound].some((entry) => entry.endsWith("_right"))) return false;
      if (item === "top" && [...compound].some((entry) => entry.startsWith("top_"))) return false;
      if (item === "bottom" && [...compound].some((entry) => entry.startsWith("bottom_"))) return false;
      return true;
    }), 8);
  }

  function normalizePositions(values) {
    const allowed = new Set(POSITION_RULES.map((item) => item[0]));
    return unique((Array.isArray(values) ? values : []).map((raw) => {
      const value = text(raw, 32).toLowerCase();
      return POSITION_ALIASES[value] || value;
    }).filter((value) => allowed.has(value)), 8);
  }

  function appearanceTerms(value) {
    const source = String(value || "");
    const result = [];
    for (const [name, pattern] of APPEARANCE_RULES) if (matches(pattern, source)) result.push(name);
    return unique(result, APPEARANCE_RULES.length);
  }

  function normalizeAppearance(values) {
    const allowed = new Set(APPEARANCE_RULES.map((item) => item[0]));
    const result = [];
    for (const raw of Array.isArray(values) ? values : []) {
      const value = text(raw, 48).toLowerCase();
      const normalized = APPEARANCE_ALIASES[value] || value;
      if (allowed.has(normalized)) result.push(normalized);
      else result.push(...appearanceTerms(value));
    }
    return unique(result, APPEARANCE_RULES.length);
  }

  function roleClauses(value) {
    return String(value || "")
      .replace(/(?:但是|但要|但|同时|并且|并(?=保持|保留|维持|排除|除外|不包含|不要|不能|勿改|别动))/g, "，")
      .split(/[，,。；;\n]/)
      .map((clause) => clause.trim())
      .filter(Boolean);
  }

  function semanticBigrams(value) {
    const source = String(value || "")
      .replace(/请|帮我|麻烦|我要|我想|把|将|给我|图中|画面中|当前|这个|那个|识别|选择|选中|选取|定位|找到|找出|抠出|提取|修改|调整/g, "")
      .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, "");
    const result = new Set();
    for (let index = 0; index < source.length - 1; index += 1) result.add(source.slice(index, index + 2));
    return result;
  }

  function similarity(left, right) {
    const a = semanticBigrams(left);
    const b = semanticBigrams(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const item of a) if (b.has(item)) overlap += 1;
    return overlap / Math.max(1, Math.min(a.size, b.size));
  }

  function isTargetClause(clause) {
    if (PROTECTION_PATTERN.test(clause) && !CHANGE_VERB_PATTERN.test(clause)) return false;
    return CHANGE_VERB_PATTERN.test(clause)
      || /选择|选中|选取|定位|找到|找出|抠出|提取|修改|调整|降低|减少|调低|压低|提高|增加|提升|调高|提亮|调暗|增强|减弱|去色|隐藏背景|去背景/.test(clause);
  }

  function selectTargetClause(instruction, plannedDescription) {
    const clauses = roleClauses(instruction).filter(isTargetClause);
    if (!clauses.length) return text(instruction, 500);
    if (!plannedDescription || clauses.length === 1) return clauses[0];
    let best = clauses[0];
    let bestScore = -1;
    for (const clause of clauses) {
      const score = similarity(clause, plannedDescription);
      if (score > bestScore) {
        best = clause;
        bestScore = score;
      }
    }
    return best;
  }

  function targetRoleContext(instruction, selectedClause) {
    const clauses = roleClauses(instruction);
    const selectedIndex = clauses.indexOf(selectedClause);
    if (selectedIndex < 0) return String(instruction || "");
    const context = [clauses[selectedIndex]];
    const hasEarlierTarget = clauses.slice(0, selectedIndex).some(isTargetClause);
    if (!hasEarlierTarget) {
      for (let index = selectedIndex - 1; index >= 0; index -= 1) {
        if (isTargetClause(clauses[index])) break;
        if (PROTECTION_PATTERN.test(clauses[index])) context.unshift(clauses[index]);
      }
    }
    for (let index = selectedIndex + 1; index < clauses.length; index += 1) {
      if (isTargetClause(clauses[index])) break;
      if (PROTECTION_PATTERN.test(clauses[index])) context.push(clauses[index]);
    }
    return context.join("，");
  }

  function targetLabel(value) {
    let result = String(value || "").split(CHANGE_VERB_PATTERN)[0];
    result = result.split(PROTECTION_PATTERN)[0]
      .replace(/^(?:请|帮我|麻烦|我要|我想|给我|只|仅|单独|把|将)+/g, "")
      .replace(/^(?:识别|选择|选中|选取|定位|找到|找出|抠出|提取|修改|调整|降低|减少|调低|压低|提高|增加|提升|调高|提亮|调暗|增强|减弱)+/g, "")
      .replace(/^(?:图中|画面中|当前画面中|图片中|照片中|文档中)(?:的)?/g, "")
      .replace(/(?:的颜色|颜色)$/g, "")
      .replace(/(?:整体|全部|完整)\s*$/g, "")
      .replace(/[，,。；;：:\s（(\[【]+$/g, "")
      .trim();
    if (/改|换|变|调|调整|设|设置|替换|上色/.test(String(value || ""))) {
      const assignment = reset(GENERIC_COLOR_ASSIGNMENT_PATTERN).exec(result);
      reset(GENERIC_COLOR_ASSIGNMENT_PATTERN);
      if (assignment && Number.isInteger(assignment.index)) result = result.slice(0, assignment.index).trim();
    }
    const propertyIndex = result.search(ADJUSTMENT_PROPERTY_PATTERN);
    if (propertyIndex >= 0) result = result.slice(0, propertyIndex).replace(/的\s*$/g, "").trim();
    return text(result, 120);
  }

  function detectPart(label) {
    for (const [canonical, pattern] of PART_RULES) if (pattern.test(String(label || ""))) return canonical;
    return "";
  }

  function stripPattern(source, pattern) {
    return String(source || "").replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "");
  }

  function entityFromLabel(label, part) {
    let result = String(label || "");
    for (const [, pattern] of POSITION_RULES) result = stripPattern(result, pattern);
    for (const [, pattern] of COLOR_RULES) result = stripPattern(result, pattern);
    if (part) {
      const partRule = PART_RULES.find((item) => item[0] === part);
      if (partRule) result = stripPattern(result, partRule[1]);
    }
    result = result
      .replace(/(?:左侧|右侧|上侧|下侧|前面的?|后面的?|旁边的?|附近的?)/g, "")
      .replace(/(?:完整|整个|全部|所有|可见|主要|主体|目标|对象|物体|区域|局部|部分)/g, "")
      .replace(/(?:这个|那个|该|其|的)/g, "")
      .replace(/[^\u3400-\u9fffA-Za-z0-9_-]+/g, "")
      .trim();
    return text(result, 80);
  }

  function protectedSubject(clause) {
    const value = String(clause || "").trim();
    const prefix = value.match(/^(?:保持|保留|维持|排除|除外|不包含|不要(?:修改|改变|破坏|改|动)|不能(?:修改|改变|破坏|改)|勿改|别动)\s*(.+)$/);
    if (prefix && prefix[1] && !/^(?:不变|原样)$/.test(prefix[1].trim())) return prefix[1];
    const suffix = value.match(/^(.+?)(?:保持不变|维持不变|保持原样|维持原样|不变|原样|别动|不要动|不能修改|不要修改|不能改变|不要改变|不能改|不要改|勿改)(?:[。！!]*$)/);
    if (suffix && suffix[1]) return suffix[1];
    if (/^其他(?:内容|区域|部分)?/.test(value)) return value.replace(/(?:保持不变|维持不变|不变|别动|不要改|不能改|勿改).*$/, "");
    return "";
  }

  function removeAppearanceWords(value) {
    let result = String(value || "");
    for (const [, pattern] of APPEARANCE_RULES) result = stripPattern(result, pattern);
    return result;
  }

  function normalizeRegionPhrase(value) {
    return text(String(value || "")
      .replace(/^(?:并且|同时|以及|还有|和|与|及)+/g, "")
      .replace(/(?:仍然|继续|尽量|必须|需要|要求|原有|原来的|原本|原始|现有|已有|自然|真实)$/g, "")
      .replace(/(?:保持|保留|维持|排除|除外|不包含|不要(?:修改|改变|破坏|改|动)|不能(?:修改|改变|破坏|改)|勿改|不变|原样|别动)/g, "")
      .replace(/^[\s的]+|[\s的]+$/g, "")
      .replace(/^[（(\[【]+|[）)\]】]+$/g, "")
      .replace(/[。！!]+$/g, ""), 100);
  }

  function spatialProtectedRegions(instruction) {
    const result = [];
    for (const clause of roleClauses(instruction)) {
      if (!PROTECTION_PATTERN.test(clause)) continue;
      const subject = protectedSubject(clause);
      if (!subject) continue;
      const semanticSubject = subject.includes("的") ? subject.slice(subject.lastIndexOf("的") + 1) : subject;
      for (const phrase of semanticSubject.split(/(?:以及|还有|和|与|及|、|\/)/)) {
        const phraseAppearance = appearanceTerms(phrase);
        if (phraseAppearance.some((item) => item !== "pattern")) continue;
        const normalized = normalizeRegionPhrase(removeAppearanceWords(phrase));
        if (normalized) result.push(normalized);
      }
    }
    return unique(result, 16);
  }

  function appearanceConstraints(instruction) {
    const result = [];
    for (const clause of roleClauses(instruction)) {
      if (!PROTECTION_PATTERN.test(clause)) continue;
      result.push(...appearanceTerms(clause));
    }
    return unique(result, APPEARANCE_RULES.length);
  }

  function emptyContract() {
    return {
      version: CONTRACT_VERSION,
      target: {
        label: "",
        scope: "unknown",
        entity: "",
        part: "",
        positions: [],
        sourceColorFamilies: []
      },
      protectedRegions: [],
      preserveAppearance: []
    };
  }

  function normalizeTarget(value) {
    const source = value && typeof value === "object" ? value : {};
    const cleanLabel = targetLabel(source.label || "");
    const inferredPart = detectPart(cleanLabel);
    const requestedScope = text(source.scope || "unknown", 32).toLowerCase();
    const scope = requestedScope === "whole_object" || requestedScope === "subpart"
      ? requestedScope
      : inferredPart ? "subpart" : cleanLabel ? "whole_object" : "unknown";
    return {
      label: cleanLabel,
      scope,
      entity: text(source.entity || entityFromLabel(cleanLabel, source.part || inferredPart), 80),
      part: text(source.part || inferredPart, 80),
      positions: normalizePositions(source.positions || positions(cleanLabel)),
      sourceColorFamilies: normalizeColorFamilies(source.sourceColorFamilies || colorFamilies(cleanLabel))
    };
  }

  function normalizeContract(value) {
    const source = value && typeof value === "object" ? value : {};
    const normalized = emptyContract();
    normalized.target = normalizeTarget(source.target);
    normalized.protectedRegions = unique((Array.isArray(source.protectedRegions) ? source.protectedRegions : [])
      .map(normalizeRegionPhrase)
      .filter(Boolean), 16);
    normalized.preserveAppearance = normalizeAppearance(source.preserveAppearance);
    return normalized;
  }

  function buildUserContract(instruction, plannedDescription) {
    const source = String(instruction || "");
    const clause = selectTargetClause(source, plannedDescription);
    const roleContext = targetRoleContext(source, clause);
    const label = targetLabel(clause);
    const part = detectPart(label);
    const destination = new Set(destinationColorFamilies(source));
    const originalFamilies = colorFamilies(label).filter((family) => !destination.has(family));
    return normalizeContract({
      version: CONTRACT_VERSION,
      target: {
        label,
        scope: part ? "subpart" : label ? "whole_object" : "unknown",
        entity: entityFromLabel(label, part),
        part,
        positions: positions(label),
        sourceColorFamilies: originalFamilies
      },
      protectedRegions: spatialProtectedRegions(roleContext),
      preserveAppearance: appearanceConstraints(roleContext)
    });
  }

  function buildPlannedContract(params) {
    const source = params && typeof params === "object" ? params : {};
    const hasEmbeddedContract = Boolean(source.visualContract && typeof source.visualContract === "object");
    const embedded = hasEmbeddedContract
      ? normalizeContract(source.visualContract)
      : buildUserContract(source.description || "");
    const requestedScope = text(source.semanticScope, 32).toLowerCase();
    const scope = requestedScope === "part" ? "subpart" : requestedScope;
    const target = {
      ...embedded.target,
      label: embedded.target.label || targetLabel(source.description || ""),
      scope: hasEmbeddedContract && embedded.target.scope !== "unknown"
        ? embedded.target.scope
        : SCOPES.has(scope) ? scope : embedded.target.scope,
      positions: embedded.target.positions.length ? embedded.target.positions : positions(source.description || ""),
      sourceColorFamilies: Array.isArray(source.sourceColorFamilies)
        ? normalizeColorFamilies(source.sourceColorFamilies)
        : embedded.target.sourceColorFamilies
    };
    const part = target.part || detectPart(target.label);
    target.part = part;
    if (!target.entity) target.entity = entityFromLabel(target.label, part);
    return normalizeContract({
      version: CONTRACT_VERSION,
      target,
      protectedRegions: Array.isArray(source.protectedRegions) ? source.protectedRegions : embedded.protectedRegions,
      preserveAppearance: Array.isArray(source.preserveAppearance) ? source.preserveAppearance : embedded.preserveAppearance
    });
  }

  function comparable(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/的|这个|那个|该|目标|对象|物体|区域|局部|部分/g, "")
      .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, "");
  }

  function compatiblePhrase(expected, actual) {
    const left = comparable(expected);
    const right = comparable(actual);
    if (!left || !right) return !left;
    return left === right || left.includes(right) || right.includes(left) || similarity(left, right) >= 0.62;
  }

  function compatibleEntity(expected, actual) {
    const expectedText = String(expected || "");
    const actualText = String(actual || "");
    const expectedIsCompound = /以及|还有|和|与|及|、|\//.test(expectedText);
    const actualIsCompound = /以及|还有|和|与|及|、|\//.test(actualText);
    if (actualIsCompound && !expectedIsCompound) return false;
    return compatiblePhrase(expectedText, actualText);
  }

  function missingCompatible(expected, actual) {
    return expected.filter((item) => !actual.some((candidate) => compatiblePhrase(item, candidate)));
  }

  function extraCompatible(expected, actual) {
    return actual.filter((item) => !expected.some((candidate) => compatiblePhrase(candidate, item)));
  }

  function auditContract(expectedValue, actualValue) {
    const expected = normalizeContract(expectedValue);
    const actual = normalizeContract(actualValue);
    const errors = [];
    const warnings = [];
    if (expected.target.label && !actual.target.label) errors.push("计划缺少视觉目标。");
    if (expected.target.entity && !actual.target.entity) errors.push(`计划缺少用户指定的目标实体“${expected.target.entity}”。`);
    else if (expected.target.entity && actual.target.entity && !compatibleEntity(expected.target.entity, actual.target.entity)) {
      errors.push(`计划目标实体“${actual.target.entity}”与用户目标“${expected.target.entity}”不一致。`);
    }
    if (expected.target.part && !actual.target.part) errors.push(`计划缺少用户指定的目标部件“${expected.target.part}”。`);
    else if (expected.target.part && actual.target.part && !compatiblePhrase(expected.target.part, actual.target.part)) {
      errors.push(`计划目标部件“${actual.target.part}”与用户目标“${expected.target.part}”不一致。`);
    }
    if (!expected.target.part && actual.target.part) errors.push(`计划擅自把完整目标缩小为部件“${actual.target.part}”。`);
    if (expected.target.scope !== "unknown" && actual.target.scope !== expected.target.scope) {
      errors.push(`计划视觉范围${actual.target.scope}与用户要求的${expected.target.scope}不一致。`);
    }

    const missingPositions = expected.target.positions.filter((item) => !actual.target.positions.includes(item));
    const extraPositions = actual.target.positions.filter((item) => !expected.target.positions.includes(item));
    if (missingPositions.length) errors.push(`计划缺少用户指定的方位：${missingPositions.join("、")}。`);
    if (extraPositions.length) errors.push(`计划夹带用户未指定的方位：${extraPositions.join("、")}。`);

    const extraSourceColors = actual.target.sourceColorFamilies.filter((item) => !expected.target.sourceColorFamilies.includes(item));
    if (expected.target.sourceColorFamilies.length && extraSourceColors.length) {
      errors.push(`计划的目标原颜色与用户指定不一致：${extraSourceColors.join("、")}。`);
    }

    const missingProtected = missingCompatible(expected.protectedRegions, actual.protectedRegions);
    const extraProtected = extraCompatible(expected.protectedRegions, actual.protectedRegions);
    if (missingProtected.length) warnings.push(`计划遗漏需要保持不变的区域：${missingProtected.join("、")}。`);
    if (extraProtected.length) warnings.push(`计划附带额外保护区域，将以用户合同覆盖：${extraProtected.join("、")}。`);

    const missingAppearance = expected.preserveAppearance.filter((item) => !actual.preserveAppearance.includes(item));
    const extraAppearance = actual.preserveAppearance.filter((item) => !expected.preserveAppearance.includes(item));
    if (missingAppearance.length) warnings.push(`计划遗漏外观保留要求：${missingAppearance.join("、")}。`);
    if (extraAppearance.length) warnings.push(`计划附带额外外观要求，将以用户合同覆盖：${extraAppearance.join("、")}。`);
    return {
      complete: errors.length === 0,
      errors,
      warnings,
      sanitizedRoles: {
        protectedRegions: [...expected.protectedRegions],
        preserveAppearance: [...expected.preserveAppearance]
      },
      expected,
      actual
    };
  }

  function applyAuthoritativeContract(params, instruction, options) {
    const source = params && typeof params === "object" ? params : {};
    const settings = options && typeof options === "object" ? options : {};
    const planned = buildPlannedContract(source);
    const user = buildUserContract(instruction, source.description);
    const destination = new Set(destinationColorFamilies(instruction));
    const userHasTarget = Boolean(user.target.label);
    const sourceFamilies = (user.target.sourceColorFamilies.length
      ? user.target.sourceColorFamilies
      : planned.target.sourceColorFamilies).filter((family) => !destination.has(family));
    const authoritative = normalizeContract({
      version: CONTRACT_VERSION,
      target: {
        label: userHasTarget ? user.target.label : planned.target.label,
        scope: user.target.scope !== "unknown" ? user.target.scope : planned.target.scope,
        entity: user.target.entity || planned.target.entity,
        part: user.target.part || (user.target.scope === "whole_object" ? "" : planned.target.part),
        positions: user.target.positions.length ? user.target.positions : planned.target.positions,
        sourceColorFamilies: sourceFamilies
      },
      protectedRegions: user.protectedRegions,
      preserveAppearance: user.preserveAppearance
    });
    source.visualContract = authoritative;
    source.description = authoritative.target.label || text(source.description, 240);
    source.semanticScope = authoritative.target.scope;
    source.sourceColorFamilies = [...authoritative.target.sourceColorFamilies];
    source.protectedRegions = [...authoritative.protectedRegions];
    source.preserveAppearance = [...authoritative.preserveAppearance];
    if (settings.sanitizeModelExclusions === true && authoritative.protectedRegions.length === 0) {
      source.excludePoints = [];
    }
    return source;
  }

  function hasSpatialProtection(instruction) {
    return spatialProtectedRegions(instruction).length > 0;
  }

  return Object.freeze({
    CONTRACT_VERSION,
    buildUserContract,
    buildPlannedContract,
    auditContract,
    applyAuthoritativeContract,
    hasSpatialProtection,
    appearanceConstraints,
    normalizeContract
  });
});
