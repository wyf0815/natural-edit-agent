"use strict";

const { core, app, imaging, action } = require("photoshop");
const { storage } = require("uxp");
const protocol = globalThis.PhotoshopAssistantV8Protocol;
const stateEngine = globalThis.PhotoshopAssistantV8State;
const engine = globalThis.PhotoshopAssistantV8Engine;
const capabilities = globalThis.PhotoshopAssistantV8Capabilities;
const modelProviders = globalThis.PhotoshopAssistantV8Models;
const confidencePolicy = globalThis.PhotoshopAssistantV97Confidence;
const selectionSessions = globalThis.PhotoshopAssistantV97SelectionSession;

const PROXY_URL = "http://127.0.0.1:17861";
const SETTINGS_KEY = "photoshop_assistant_v8_settings";
const LOG_KEY = "photoshop_assistant_v8_logs";
const PREVIEW_HEIGHT = 1400;
// Every upstream call must have a visible purpose. Planning happens once, while
// visual verification may run twice per object: inspect, then verify one repair.
const MODEL_RETRY_DELAYS = Object.freeze([]);
const MODEL_REQUEST_TOTAL_LIMIT = 32;
const MODEL_REQUEST_STAGE_LIMITS = Object.freeze({
  planning: 1,
  inspection: 1,
  visual_mask_verification: 2
});
const REQUIRED_BRIDGE_VERSION = "0.9.8";
const SELECTION_PROVIDER_ACTIONS = new Set([
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

const runtime = {
  busy: false,
  snapshot: null,
  plan: null,
  activeInstruction: "",
  undoPoint: null,
  proxyConfigured: false,
  proxyCompatibilityError: "",
  reference: null,
  currentPreview: null,
  palette: [],
  fullPalette: [],
  semanticPalettes: [],
  semanticPaletteError: "",
  paletteError: "",
  visualEvidence: [],
  visualCandidateMode: "replace",
  visualConfirmedSteps: new Set(),
  visualCandidateErrors: new Map(),
  visualOriginalParams: new Map(),
  selectionSessionsByStep: new Map(),
  selectionConfidenceByStep: new Map(),
  lassoMode: "add",
  lassoDrawing: false,
  lassoPoints: [],
  highRiskConfirmed: false,
  prePlanSelection: null,
  colorPicker: null,
  colorPickerLoading: false,
  modelSettings: null,
  documentSignature: "",
  refreshingState: false,
  refreshPromise: null,
  insightDocumentId: null,
  insightsReady: false,
  insightsStale: false,
  requestControllers: new Set(),
  retryWaiting: false,
  cancelRequested: false,
  visualRequestEpoch: 0,
  proxyCapabilities: null,
  modelRequestTrace: [],
  analysisRunId: ""
};

function $(id) { return document.getElementById(id); }

function visualPlanSteps() {
  if (!runtime.plan || !Array.isArray(runtime.plan.steps)) return [];
  return runtime.plan.steps
    .map((step, index) => ({ index, step }))
    .filter((item) => item.step.action === "selection.visual_object");
}

function selectionPlanSteps() {
  if (!runtime.plan || !Array.isArray(runtime.plan.steps)) return [];
  return runtime.plan.steps
    .map((step, index) => ({ index, step }))
    .filter((item) => SELECTION_PROVIDER_ACTIONS.has(item.step.action));
}

function selectionPlanStep() {
  const steps = selectionPlanSteps();
  return steps.find((item) => !runtime.visualConfirmedSteps.has(item.index)) || steps[0] || null;
}

function visualPlanStep() {
  const active = selectionPlanStep();
  if (active && active.step.action === "selection.visual_object") return active;
  return null;
}

function planNeedsVisualConfirmation() {
  const selectionPending = selectionPlanSteps().some(({ index, step }) => (
    !runtime.visualConfirmedSteps.has(index) || !step.params.selectionSessionToken
  ));
  const highRiskPending = Boolean(runtime.plan && Array.isArray(runtime.plan.highRiskStepIds)
    && runtime.plan.highRiskStepIds.length && !runtime.highRiskConfirmed);
  return selectionPending || highRiskPending;
}

function planStepIndexesForRequirementGroupRemoval(steps, failedIndex) {
  const source = Array.isArray(steps) ? steps : [];
  const failed = source[failedIndex];
  if (!failed) return [];
  const requirementIds = new Set(Array.isArray(failed.requirementIds) ? failed.requirementIds.filter(Boolean) : []);
  const removed = new Set();
  const removedOperationIds = new Set();
  if (requirementIds.size) {
    for (let index = 0; index < source.length; index += 1) {
      const step = source[index];
      const sharesRequirement = Array.isArray(step.requirementIds)
        && step.requirementIds.some((id) => requirementIds.has(id));
      if (sharesRequirement) removed.add(index);
    }
  }
  const requirementGroupCrossesAnotherSelection = [...removed].some((index) => (
    index !== failedIndex && String(source[index] && source[index].action || "").startsWith("selection.")
  ));
  if (!removed.size || requirementGroupCrossesAnotherSelection) {
    removed.clear();
    let end = source.length;
    for (let index = failedIndex + 1; index < source.length; index += 1) {
      if (String(source[index] && source[index].action || "").startsWith("selection.")) {
        end = index;
        break;
      }
    }
    for (let index = failedIndex; index < end; index += 1) removed.add(index);
  }
  for (const index of removed) {
    const step = source[index];
    if (step && step.operationId) removedOperationIds.add(step.operationId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < source.length; index += 1) {
      if (removed.has(index)) continue;
      const step = source[index];
      const dependency = step && step.target && step.target.resultOf
        || step && step.params && step.params.groupResultOf;
      if (dependency && removedOperationIds.has(dependency)) {
        removed.add(index);
        if (step.operationId) removedOperationIds.add(step.operationId);
        changed = true;
      }
    }
  }
  return [...removed].sort((left, right) => left - right);
}

function remapIndexedRuntimeMap(source, indexMap) {
  const next = new Map();
  for (const [oldIndex, value] of source || []) {
    if (indexMap.has(oldIndex)) next.set(indexMap.get(oldIndex), value);
  }
  return next;
}

async function removeFailedTargetFromPlan() {
  if (runtime.busy || !runtime.plan) return;
  const failed = selectionPlanStep();
  if (!failed || !runtime.visualCandidateErrors.has(failed.index) || selectionPlanSteps().length <= 1) {
    showResult("当前没有可单独删除的失败目标。", "error");
    return;
  }
  const removedIndexes = planStepIndexesForRequirementGroupRemoval(runtime.plan.steps, failed.index);
  if (!removedIndexes.length) {
    showResult("这个失败目标缺少独立需求标识，无法安全删除；请取消整单后重新描述。", "error");
    return;
  }
  const removedSet = new Set(removedIndexes);
  const keptSelectionCount = runtime.plan.steps.filter((step, index) => (
    !removedSet.has(index) && SELECTION_PROVIDER_ACTIONS.has(step.action)
  )).length;
  if (!keptSelectionCount) {
    showResult("删除后将没有任何可执行目标，已保留原计划。", "error");
    return;
  }
  try {
    setBusy(true, "正在移除失败目标...");
    const oldSteps = runtime.plan.steps;
    const removedSteps = oldSteps.filter((_step, index) => removedSet.has(index));
    for (const step of removedSteps) {
      if (step.params && step.params.maskToken) capabilities.releaseSemanticMask(step.params.maskToken);
      if (step.params && step.params.selectionSessionToken) selectionSessions.release(step.params.selectionSessionToken);
    }
    const kept = oldSteps.filter((_step, index) => !removedSet.has(index));
    const indexMap = new Map();
    let nextIndex = 0;
    for (let oldIndex = 0; oldIndex < oldSteps.length; oldIndex += 1) {
      if (!removedSet.has(oldIndex)) indexMap.set(oldIndex, nextIndex++);
    }
    runtime.plan.steps = kept.map((step, index) => ({ ...step, index }));
    runtime.plan.highRiskStepIds = (runtime.plan.highRiskStepIds || [])
      .filter((id) => runtime.plan.steps.some((step) => step.id === id));
    runtime.plan.containsIrreversibleStep = runtime.plan.steps.some((step) => step.reversible === false);
    runtime.visualConfirmedSteps = new Set([...runtime.visualConfirmedSteps]
      .filter((index) => indexMap.has(index))
      .map((index) => indexMap.get(index)));
    runtime.visualCandidateErrors = remapIndexedRuntimeMap(runtime.visualCandidateErrors, indexMap);
    runtime.visualOriginalParams = remapIndexedRuntimeMap(runtime.visualOriginalParams, indexMap);
    runtime.selectionSessionsByStep = remapIndexedRuntimeMap(runtime.selectionSessionsByStep, indexMap);
    runtime.selectionConfidenceByStep = remapIndexedRuntimeMap(runtime.selectionConfidenceByStep, indexMap);
    runtime.visualEvidence = runtime.visualEvidence
      .filter((item) => indexMap.has(item.stepIndex))
      .map((item) => ({ ...item, stepIndex: indexMap.get(item.stepIndex) }));
    runtime.plan.sourceEvidenceRequirements = stateEvidenceRequirements(runtime.plan);
    if (runtime.snapshot && typeof stateEngine.buildEvidenceFingerprint === "function") {
      runtime.plan.sourceEvidenceFingerprint = stateEngine.buildEvidenceFingerprint(
        runtime.snapshot,
        runtime.plan.sourceEvidenceRequirements
      );
    }
    const next = selectionPlanStep();
    if (next && next.step.params.selectionSessionToken) {
      await activateSelectionStep(next, { rebase: true, authority: "remove-failed-target" });
    }
    renderPlan(runtime.plan);
    const removedLabel = failed.step.params && failed.step.params.description || failed.step.label || "失败目标";
    showResult(`已删除“${removedLabel}”及其关联操作；其余已生成候选和确认状态均已保留，没有重新调用定位或分割。`, "muted");
  } catch (error) {
    showResult(`删除失败目标时已停止：${friendlyError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function releaseVisualPlanMasks(plan) {
  if (!plan || !Array.isArray(plan.steps)) return;
  for (const step of plan.steps) {
    if (!step.params) continue;
    if (step.params.maskToken) capabilities.releaseSemanticMask(step.params.maskToken);
    if (step.params.selectionSessionToken && selectionSessions) selectionSessions.release(step.params.selectionSessionToken);
    delete step.params.maskToken;
    delete step.params.selectionSessionToken;
    delete step.params.segmentationMode;
  }
  runtime.selectionSessionsByStep = new Map();
}

async function savePrePlanSelection() {
  if (runtime.prePlanSelection || !app.documents.length) return;
  const documentID = Number(app.activeDocument.id);
  const hadSelection = Boolean(selectionSessions.activeBounds());
  if (!hadSelection) {
    runtime.prePlanSelection = { documentID, hadSelection: false, token: null };
    return;
  }
  const saved = await core.executeAsModal(
    async () => selectionSessions.captureCurrent({ metadata: { purpose: "pre-plan-selection", pinned: true } }),
    { commandName: "v9.8 保存用户原选区", timeOut: 8 }
  );
  runtime.prePlanSelection = { documentID, hadSelection: true, token: saved.token };
}

async function restorePrePlanSelection() {
  const saved = runtime.prePlanSelection;
  runtime.prePlanSelection = null;
  if (!saved) return;
  if (!app.documents.length || Number(app.activeDocument.id) !== saved.documentID) {
    if (saved.token) selectionSessions.release(saved.token);
    return;
  }
  try {
    await core.executeAsModal(async () => {
      if (saved.hadSelection && saved.token) await selectionSessions.restore(saved.token);
      else await app.activeDocument.selection.deselect();
    }, { commandName: "v9.8 恢复用户原选区", timeOut: 8 });
  } finally {
    if (saved.token) selectionSessions.release(saved.token);
  }
}

function setBusy(value, label) {
  runtime.busy = value;
  for (const id of ["analyze", "executePlan", "cancelPlan", "refreshState", "undoLast", "runSelfTest", "pasteReference", "chooseReference", "toggleColorPicker", "candidateReplace", "candidateAdd", "candidateExclude", "candidateReset", "confirmCandidate", "adoptCurrentSelection", "removeFailedTarget", "nativeSelectionHelp", "lassoReplace", "lassoAdd", "lassoSubtract", "lassoIntersect", "confirmHighRisk"]) {
    const element = $(id);
    if (element) {
      element.disabled = value
        || (id === "undoLast" && !runtime.undoPoint)
        || (id === "executePlan" && planNeedsVisualConfirmation())
        || (id === "toggleColorPicker" && (runtime.colorPickerLoading || !app.documents.length));
    }
  }
  const clearReference = $("clearReference");
  const analyze = $("analyze");
  if (clearReference) clearReference.disabled = value || !runtime.reference;
  if (analyze && label) analyze.textContent = label;
  if (analyze && !value) analyze.textContent = "分析 / 生成操作";
}

function showResult(message, type) {
  $("result").textContent = message;
  $("result").className = `result ${type || "muted"}`;
}

function showDetails(value) {
  $("technicalDetails").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function currentModelRequestSummary() {
  const attempts = runtime.modelRequestTrace.filter((item) => item.runId === runtime.analysisRunId);
  const stages = [...new Set(attempts.map((item) => item.stage))];
  return {
    attempts: attempts.length,
    stages,
    detail: attempts.map(({ stage, requestKey, purpose, provider, model, transport, attempt, startedAt }) => ({
      stage,
      requestKey,
      purpose,
      provider,
      model,
      transport,
      attempt,
      startedAt
    }))
  };
}

function assertModelRequestBudget(stage, requestKey) {
  const requests = runtime.modelRequestTrace.filter((item) => item.runId === runtime.analysisRunId);
  const normalizedStage = String(stage || "planning");
  const normalizedKey = String(requestKey || normalizedStage);
  const stageLimit = Number(MODEL_REQUEST_STAGE_LIMITS[normalizedStage] || 1);
  const usedForKey = requests.filter((item) => item.stage === normalizedStage && item.requestKey === normalizedKey).length;
  if (requests.length < MODEL_REQUEST_TOTAL_LIMIT && usedForKey < stageLimit) return;
  const error = new Error(`模型请求预算已用完：${normalizedStage}/${normalizedKey}。插件已停止继续请求，本次不会修改Photoshop。`);
  error.code = "MODEL_REQUEST_BUDGET_EXHAUSTED";
  throw error;
}

function friendlyError(error, options = {}) {
  const message = String((error && error.message) || error || "未知错误");
  const omitDocumentState = Boolean(options.omitDocumentState);
  if (error && /^LOCAL_(?:BRIDGE|SEGMENTATION)_/.test(String(error.code || ""))) return message;
  if (/Unsupported provider:\s*tokensea/i.test(message)) return "本地助手服务版本过旧，不支持 Tokensea。请通过 Natural Edit Agent 快捷方式重新启动服务。";
  if (/modal scope|executeasmodal/i.test(message)) return omitDocumentState
    ? "Photoshop拒绝了不在安全执行作用域中的修改。"
    : "Photoshop拒绝了不在安全执行作用域中的修改，文档没有被提交。";
  if (/host is in a modal state|running a modal command/i.test(message)) return "Photoshop正被其他操作占用，请结束当前变换或对话框后重试。";
  if (/AbortError|aborted|已停止等待/i.test(message)) return omitDocumentState
    ? "操作已停止等待。"
    : "已停止等待，本次没有修改Photoshop。";
  if (/Failed to fetch|fetch failed|NetworkError|Network request failed/i.test(message)) return omitDocumentState
    ? "无法连接所选模型服务；请检查服务地址、端口、防火墙和厂商服务状态。"
    : "无法连接所选模型服务；请检查服务地址、端口、防火墙和厂商服务状态。本次没有修改Photoshop。";
  if (/engine_overloaded|currently overloaded/i.test(message)) return omitDocumentState
    ? "模型服务当前拥堵；插件没有自动重试。"
    : "模型服务当前拥堵。插件没有自动重试，也没有修改Photoshop；请稍后手动重新分析。";
  if (/explicitly protected area|explicitly protected point/i.test(message)) return "候选与需要保持不变的区域发生冲突，请在目标上重新定位，或用“排除误选”补充保护点。";
  if (/Source-color refinement did not find/i.test(message)) return "没有从目标附近找到足够可靠的原颜色像素，请在要修改的部件内部重新点一下。";
  return message;
}

function protectedEvidenceSummary(outcome) {
  const protectedEvidence = outcome && outcome.protectedEvidence || {};
  const verificationLevel = String(outcome && outcome.verificationLevel || protectedEvidence.level || "not_sampled");
  const sampledLayerCount = Number(protectedEvidence.sampledLayerCount || 0);
  const unverifiedLayerIds = Array.isArray(protectedEvidence.unverifiedLayerIds)
    ? protectedEvidence.unverifiedLayerIds
    : [];
  const evidenceLimit = "证据范围不包括未抽样属性、矢量蒙版、外部文件或所有 Photoshop 内部状态。";
  if (verificationLevel === "pixel_and_mask_digest") {
    return `保护区抽样证据：比较了 ${sampledLayerCount} 个非目标图层的可读取像素摘要和用户蒙版摘要，这些抽样项未发现差异。${evidenceLimit}`;
  }
  if (verificationLevel === "partial") {
    const unverified = unverifiedLayerIds.length
      ? `；未完整验证的图层 ID：${unverifiedLayerIds.join("、")}`
      : "";
    return `保护区抽样证据不完整${unverified}。已取得的证据仅涉及部分非目标图层的可读取像素摘要和用户蒙版摘要，不能据此排除未验证范围内的变化。${evidenceLimit}`;
  }
  if (verificationLevel === "document_wide_not_applicable") {
    return `本次包含明确授权的整文档操作，因此没有建立非目标图层保护区抽样；完成结论只来自各步骤的可用回读。${evidenceLimit}`;
  }
  return `本次没有取得非目标图层像素摘要和用户蒙版摘要的保护区抽样；完成结论只来自各步骤的可用回读。${evidenceLimit}`;
}

function rollbackEvidenceSummary(verification) {
  const level = verification && verification.level;
  return level === "sampled_composite_digest"
    ? "执行前后的内容/选区指纹一致，并且有抽样合成摘要可用"
    : "执行前后的内容/选区指纹一致，但只有结构级证据";
}

function executionErrorReason(error) {
  const rootError = error && error.originalError || error;
  let reason = friendlyError(rootError, { omitDocumentState: true });
  if (String(error && error.code || "") === "POST_COMMIT_EXPORT_FAILED") {
    const exportMarker = reason.lastIndexOf("导出失败：");
    if (exportMarker >= 0) reason = reason.slice(exportMarker + "导出失败：".length);
    reason = reason.replace(/。可使用本次撤销点[\s\S]*$/, "").trim();
  }
  return reason || "未提供具体错误原因";
}

function executionFailurePresentation(error) {
  const code = String(error && error.code || "");
  const reason = executionErrorReason(error);
  const rollbackVerified = Boolean(error && error.rollbackVerified === true);
  const documentStateUncertain = Boolean(error && error.documentStateUncertain === true);
  const documentChangesCommitted = Boolean(error && error.documentChangesCommitted === true);
  const hasUndoPoint = Boolean(error && error.undoPoint);
  const undoGuidance = hasUndoPoint
    ? "可点击“撤销本次操作”；插件只会在当前历史状态仍匹配时切回记录的执行前历史点，之后会重新读取文档供你核对。"
    : "没有取得可安全自动使用的撤销点，请立即检查 Photoshop 历史记录面板和当前文档。";

  if (String(error && error.executionPhase || "") === "preflight" && !documentChangesCommitted && !documentStateUncertain) {
    return {
      stage: "执行前检查未通过（尚未开始修改）",
      message: `执行前检查未通过：${reason}。文档编辑步骤尚未开始；若你在此期间自行修改过 PSD，请重新分析后再执行。`,
      preserveUndoPoint: false
    };
  }

  if (code === "POST_COMMIT_EXPORT_FAILED") {
    if (documentChangesCommitted) {
      return {
        stage: "导出失败（文档编辑已提交）",
        message: `文档编辑步骤已提交，但导出阶段失败：${reason}。${undoGuidance}外部导出路径可能已留下完整或部分文件，Photoshop 撤销不会删除它们。`,
        preserveUndoPoint: hasUndoPoint
      };
    }
    return {
      stage: "导出失败（无文档编辑步骤）",
      message: `导出阶段失败：${reason}。引擎报告本计划没有已提交的文档编辑步骤；请检查导出路径是否留下完整或部分文件。`,
      preserveUndoPoint: false
    };
  }

  if (rollbackVerified) {
    return {
      stage: "执行失败（已取得回退证据）",
      message: `执行失败：${reason}。自动回退后，${rollbackEvidenceSummary(error.rollbackVerification)}。这是有限证据，不是逐像素、矢量蒙版、外部文件或所有 Photoshop 内部状态的完整证明。`,
      preserveUndoPoint: false
    };
  }

  if (documentStateUncertain) {
    const commitContext = documentChangesCommitted
      ? "引擎报告文档曾发生提交。"
      : "即使引擎未标记文档提交，当前证据仍不足。";
    return {
      stage: "执行失败（文档状态不确定）",
      message: `执行失败：${reason}。自动回退没有取得足够证据，不能确认文档是否已恢复或修改是否仍然存在。${commitContext}${undoGuidance}`,
      preserveUndoPoint: hasUndoPoint
    };
  }

  if (documentChangesCommitted) {
    return {
      stage: "执行失败（文档编辑已提交）",
      message: `执行失败，且引擎报告文档编辑已经提交：${reason}。这不是已确认的导出错误。${undoGuidance}`,
      preserveUndoPoint: hasUndoPoint
    };
  }

  return {
    stage: "执行失败（文档状态未证实）",
    message: `执行失败：${reason}。本次错误没有提供可验证的回退证据，因此不会声称文档“未提交”或“已恢复”；请检查当前文档和 Photoshop 历史记录后再继续。`,
    preserveUndoPoint: false
  };
}

function localServiceError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForModelRetry(ms) {
  runtime.retryWaiting = true;
  renderCancelState();
  try {
    let remaining = Math.max(0, Number(ms) || 0);
    while (remaining > 0) {
      if (runtime.cancelRequested) {
        const stopped = new Error("已停止等待");
        stopped.name = "AbortError";
        throw stopped;
      }
      const interval = Math.min(100, remaining);
      await delay(interval);
      remaining -= interval;
    }
  } finally {
    runtime.retryWaiting = false;
    renderCancelState();
  }
}

function isTransientModelError(error) {
  const message = String((error && error.message) || error || "");
  const status = Number(error && error.status);
  return [429, 502, 503, 529].includes(status)
    || /engine_overloaded|currently overloaded|too many requests|rate.?limit|temporarily unavailable|service unavailable|模型返回为空/i.test(message);
}

function isNetworkTransportError(error) {
  const message = String((error && error.message) || error || "");
  return !Number(error && error.status)
    && /Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed/i.test(message);
}

function renderCancelState() {
  const button = $("cancelRequest");
  if (!button) return;
  const canCancel = runtime.requestControllers.size > 0 || runtime.retryWaiting;
  button.classList.toggle("hidden", !canCancel);
  button.disabled = !canCancel;
}

function cancelActiveRequests() {
  runtime.cancelRequested = true;
  runtime.visualRequestEpoch += 1;
  for (const controller of runtime.requestControllers) controller.abort();
  showResult("正在停止模型请求，本次不会修改Photoshop。", "muted");
}

function assertVisualRequestCurrent(epoch) {
  if (epoch === runtime.visualRequestEpoch) return;
  const error = new Error("这次对象选区请求已被新的操作替代，旧结果已丢弃。");
  error.code = "STALE_VISUAL_REQUEST";
  throw error;
}

function appendLog(event) {
  try {
    const logs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    logs.push({ at: new Date().toISOString(), ...event });
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(-30)));
  } catch (_) {}
}

function getSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return modelProviders.normalizeSettings(saved);
  } catch (_) {
    return modelProviders.normalizeSettings({});
  }
}

async function saveSettings() {
  const settings = currentFormSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  runtime.modelSettings = settings;
  const provider = modelProviders.getProvider(settings.providerId);
  $("settingsState").textContent = `已保存 ${provider.label} 配置`;
  if (provider.discoversModels && settings.apiKeys[provider.id]) {
    $("settingsState").textContent = `正在读取 ${provider.label} 模型列表...`;
    try {
      await discoverProviderModels();
      $("settingsState").textContent = `已保存 ${provider.label} 配置并读取模型列表`;
    } catch (error) {
      $("settingsState").textContent = `配置已保存；模型列表读取失败，可手动填写模型 ID：${friendlyError(error)}`;
      appendLog({ stage: "provider_models_failed", provider: provider.id, error: String(error.message || error) });
    }
  }
  return settings;
}

function currentFormSettings() {
  const settings = runtime.modelSettings || getSettings();
  settings.providerId = $("provider").value;
  const provider = modelProviders.getProvider(settings.providerId);
  const manualModel = provider.discoversModels && $("customModel")
    ? $("customModel").value.trim()
    : "";
  settings.modelId = manualModel || $("model").value;
  settings.apiKeys[settings.providerId] = $("apiKey").value.trim();
  return settings;
}

function replaceOptions(select, options, selectedValue) {
  select.innerHTML = "";
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === selectedValue;
    select.appendChild(option);
  }
}

function renderModelOptions(selectedModel) {
  const provider = modelProviders.getProvider(runtime.modelSettings.providerId);
  const catalog = runtime.modelSettings.modelCatalogs && runtime.modelSettings.modelCatalogs[provider.id];
  const capabilityOverrides = runtime.modelSettings.modelCapabilities && runtime.modelSettings.modelCapabilities[provider.id];
  const models = provider.discoversModels && Array.isArray(catalog) && catalog.length
    ? catalog.map((id) => ({
      id,
      label: id,
      vision: capabilityOverrides && capabilityOverrides[id] === true,
      capabilityKnown: Boolean(capabilityOverrides && typeof capabilityOverrides[id] === "boolean")
    }))
    : provider.models.slice();
  const customId = String(selectedModel || "").trim();
  if (provider.discoversModels && customId && customId !== "auto" && !models.some((item) => item.id === customId)) {
    models.unshift({ id: customId, label: `${customId}（手动）`, vision: provider.customModelVision });
  }
  const modelId = models.some((item) => item.id === customId) ? customId : models[0].id;
  runtime.modelSettings.modelId = modelId;
  replaceOptions($("model"), models.map((model) => ({ value: model.id, label: model.label })), modelId);
  updateModelCapability();
}

function updateModelCapability() {
  const provider = modelProviders.getProvider(runtime.modelSettings.providerId);
  const overrides = runtime.modelSettings.modelCapabilities && runtime.modelSettings.modelCapabilities[provider.id];
  const model = modelProviders.resolveModel(provider.id, $("model").value || runtime.modelSettings.modelId, overrides);
  runtime.modelSettings.modelId = model ? model.id : provider.defaultModel;
  $("modelCapability").textContent = provider.discoversModels
    ? "保存 Key 后自动读取服务端模型；读取失败时可手动填写模型 ID。视觉能力由 Tokensea 后端模型决定。"
    : model && model.vision
    ? "会读取当前 Photoshop 画面；可直接描述对象、位置和修改要求。批注图仅用于补充说明。"
    : "可按图层、文字和数值执行；涉及画面对象定位时，请改选支持图片的模型。";
}

function renderProviderFields() {
  const provider = modelProviders.getProvider(runtime.modelSettings.providerId);
  $("apiKeyLabel").textContent = provider.apiKeyLabel;
  $("apiKey").placeholder = provider.apiKeyPlaceholder;
  $("apiKey").value = runtime.modelSettings.apiKeys[provider.id] || "";
  const customFields = $("customModelFields");
  if (customFields) customFields.classList.toggle("hidden", !provider.discoversModels);
  if ($("customModel")) {
    $("customModel").value = provider.discoversModels && runtime.modelSettings.modelId !== "auto"
      ? runtime.modelSettings.modelId
      : "";
  }
}

function initializeModelSettings() {
  runtime.modelSettings = getSettings();
  replaceOptions(
    $("provider"),
    modelProviders.providerIds().map((id) => ({ value: id, label: modelProviders.getProvider(id).label })),
    runtime.modelSettings.providerId
  );
  renderModelOptions(runtime.modelSettings.modelId);
  renderProviderFields();
  const hasKey = Boolean(runtime.modelSettings.apiKeys[runtime.modelSettings.providerId]);
  $("settingsState").textContent = hasKey ? "已读取保存的设置" : "请填写当前厂商的 API Key";
}

function changeProvider() {
  const previousProvider = runtime.modelSettings.providerId;
  runtime.modelSettings.apiKeys[previousProvider] = $("apiKey").value.trim();
  runtime.modelSettings.providerId = $("provider").value;
  renderModelOptions(modelProviders.getProvider(runtime.modelSettings.providerId).defaultModel);
  renderProviderFields();
  $("settingsState").textContent = runtime.modelSettings.apiKeys[runtime.modelSettings.providerId]
    ? "已载入该厂商保存的 Key"
    : "请填写当前厂商的 API Key";
}

async function discoverProviderModels() {
  const settings = currentFormSettings();
  const provider = modelProviders.getProvider(settings.providerId);
  const apiKey = settings.apiKeys[provider.id] || "";
  const request = modelProviders.buildModelsRequest(provider.id, apiKey);
  let data;
  await checkProxy();
  if (runtime.proxyConfigured) {
    data = await fetchJson(`${PROXY_URL}/provider-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ __providerId: provider.id, __apiKey: apiKey })
    }, request.timeoutMs + 5000);
  } else {
    data = await fetchJson(request.url, { method: "GET", headers: request.headers }, request.timeoutMs);
  }
  const catalog = typeof modelProviders.parseModelsCatalog === "function"
    ? modelProviders.parseModelsCatalog(provider.id, data)
    : modelProviders.parseModelsResponse(provider.id, data).map((id) => ({ id, vision: null }));
  const ids = catalog.map((item) => item.id);
  if (!settings.modelCatalogs) settings.modelCatalogs = {};
  settings.modelCatalogs[provider.id] = ids;
  if (!settings.modelCapabilities) settings.modelCapabilities = {};
  settings.modelCapabilities[provider.id] = Object.fromEntries(catalog.map((item) => [item.id, item.vision]));
  const requested = $("customModel") ? $("customModel").value.trim() : "";
  settings.modelId = requested && ids.includes(requested) ? requested : ids[0];
  runtime.modelSettings = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  renderModelOptions(settings.modelId);
  renderProviderFields();
  return ids;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  runtime.requestControllers.add(controller);
  renderCancelState();
  try {
    const requestOptions = { ...(options || {}) };
    if (String(url || "").startsWith(PROXY_URL)) {
      const token = String(
        globalThis.PS_AGENT_BRIDGE_TOKEN
        || localStorage.getItem("bridgeToken")
        || ""
      ).trim();
      requestOptions.headers = { ...(requestOptions.headers || {}) };
      if (token) requestOptions.headers["X-PS-Agent-Token"] = token;
    }
    const response = await fetch(url, { ...requestOptions, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text || "{}"); } catch (_) { data = { error: text || "服务返回内容无法解析。" }; }
    if (!response.ok) {
      const detail = typeof data.error === "string" ? data.error : JSON.stringify(data.error || data);
      const error = new Error(detail || `服务返回${response.status}`);
      error.status = response.status;
      error.responseData = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
    runtime.requestControllers.delete(controller);
    renderCancelState();
  }
}

async function checkProxy() {
  try {
    const data = await fetchJson(`${PROXY_URL}/health`, { method: "GET" }, 2500);
    const providers = Array.isArray(data && data.providers) ? data.providers : [];
    const compatible = Boolean(
      data
      && data.ok
      && data.bridgeVersion === REQUIRED_BRIDGE_VERSION
      && providers.includes("tokensea")
    );
    runtime.proxyConfigured = compatible;
    runtime.proxyCapabilities = data && data.v7 ? data.v7 : null;
    runtime.proxyCompatibilityError = compatible
      ? ""
      : `本地助手服务版本不匹配（需要 ${REQUIRED_BRIDGE_VERSION} 且支持 Tokensea）。`;
    return data;
  } catch (error) {
    runtime.proxyConfigured = false;
    runtime.proxyCapabilities = null;
    runtime.proxyCompatibilityError = "Natural Edit Agent 本地服务未启动或无法连接。";
    return null;
  }
}

async function ensureVisualRuntimeReady() {
  const health = await checkProxy();
  if (!runtime.proxyConfigured || !health) {
    throw localServiceError(
      "LOCAL_BRIDGE_UNAVAILABLE",
      "本地对象选区服务未启动。请通过 Natural Edit Agent 快捷方式启动服务后重试；本次没有向模型厂家发送请求，也没有修改 Photoshop。"
    );
  }
  if (!runtime.proxyCapabilities || runtime.proxyCapabilities.segmentation !== true) {
    throw localServiceError(
      "LOCAL_SEGMENTATION_UNAVAILABLE",
      "本地助手服务已启动，但对象分割引擎不完整。请运行环境自检；本次没有向模型厂家发送请求，也没有修改 Photoshop。"
    );
  }
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  return Number(value) || 0;
}

function safeDispose(value) {
  if (value && typeof value.dispose === "function") value.dispose();
}

async function captureComposite(heightLimit) {
  if (!app.documents.length) throw new Error("请先打开一个Photoshop文档。");
  const doc = app.activeDocument;
  const height = Math.min(
    Number(heightLimit) > 0 ? Number(heightLimit) : PREVIEW_HEIGHT,
    Math.max(1, Math.round(numberValue(doc.height)))
  );
  const imageObject = await imaging.getPixels({
    documentID: doc.id,
    targetSize: { height },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  });
  try {
    return {
      mime: "image/jpeg",
      base64: await imaging.encodeImageData({ imageData: imageObject.imageData, base64: true }),
      width: imageObject.imageData.width,
      height: imageObject.imageData.height
    };
  } finally {
    safeDispose(imageObject && imageObject.imageData);
  }
}

function visualBoundsToPixels(box, unit, snapshot) {
  const width = Math.max(1, Number(snapshot.document.width));
  const height = Math.max(1, Number(snapshot.document.height));
  const scaleX = unit === "percent" ? width / 100 : 1;
  const scaleY = unit === "percent" ? height / 100 : 1;
  return {
    left: Math.max(0, Math.floor(Number(box.left) * scaleX)),
    top: Math.max(0, Math.floor(Number(box.top) * scaleY)),
    right: Math.min(width, Math.ceil(Number(box.right) * scaleX)),
    bottom: Math.min(height, Math.ceil(Number(box.bottom) * scaleY))
  };
}

async function captureVisualTargetCrop(params, snapshot) {
  const target = visualBoundsToPixels(params.searchRegion || params.targetBox, params.unit, snapshot);
  const sourceBounds = { ...target };
  const targetHeight = Math.min(600, Math.max(2, sourceBounds.bottom - sourceBounds.top));
  const imageObject = await imaging.getPixels({
    documentID: Number(app.activeDocument.id),
    sourceBounds,
    targetSize: { height: targetHeight },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  });
  try {
    return {
      mime: "image/jpeg",
      base64: await imaging.encodeImageData({ imageData: imageObject.imageData, base64: true }),
      width: Number(imageObject.imageData.width),
      height: Number(imageObject.imageData.height),
      sourceBounds
    };
  } finally {
    safeDispose(imageObject && imageObject.imageData);
  }
}

async function captureSegmentationSearchCrop(params, snapshot) {
  const sourceBounds = visualBoundsToPixels(params.searchRegion, params.unit, snapshot);
  const sourceWidth = Math.max(2, sourceBounds.right - sourceBounds.left);
  const sourceHeight = Math.max(2, sourceBounds.bottom - sourceBounds.top);
  const maxSide = 2560;
  const pixelBudget = 8 * 1024 * 1024;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight), Math.sqrt(pixelBudget / (sourceWidth * sourceHeight)));
  const targetSize = {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale))
  };
  const imageObject = await imaging.getPixels({
    documentID: Number(app.activeDocument.id),
    sourceBounds,
    targetSize,
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  });
  try {
    return {
      mime: "image/jpeg",
      base64: await imaging.encodeImageData({ imageData: imageObject.imageData, base64: true }),
      width: Number(imageObject.imageData.width),
      height: Number(imageObject.imageData.height),
      sourceBounds,
      sourceCrop: {
        left: sourceBounds.left,
        top: sourceBounds.top,
        right: sourceBounds.right,
        bottom: sourceBounds.bottom,
        canvasWidth: Number(snapshot.document.width),
        canvasHeight: Number(snapshot.document.height)
      }
    };
  } finally {
    safeDispose(imageObject && imageObject.imageData);
  }
}

async function captureSelectionSearchOverlay(params, snapshot) {
  const sourceBounds = visualBoundsToPixels(params.searchRegion || params.targetBox, params.unit, snapshot);
  const sourceWidth = Math.max(2, sourceBounds.right - sourceBounds.left);
  const sourceHeight = Math.max(2, sourceBounds.bottom - sourceBounds.top);
  const scale = Math.min(1, 1400 / Math.max(sourceWidth, sourceHeight));
  const targetSize = {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale))
  };
  const documentID = Number(app.activeDocument.id);
  const pixels = await imaging.getPixels({
    documentID,
    sourceBounds,
    targetSize,
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  });
  const selection = await imaging.getSelection({ documentID, sourceBounds, targetSize });
  let overlay = null;
  try {
    const rgb = new Uint8Array(await pixels.imageData.getData({ chunky: true }));
    const mask = selection && selection.imageData
      ? new Uint8Array(await selection.imageData.getData({ chunky: true }))
      : new Uint8Array(targetSize.width * targetSize.height);
    const width = Number(pixels.imageData.width);
    const height = Number(pixels.imageData.height);
    const count = width * height;
    const rgbComponents = Math.max(1, Math.round(rgb.length / Math.max(1, count)));
    const maskComponents = Math.max(1, Math.round(mask.length / Math.max(1, count)));
    const rgba = new Uint8Array(count * 4);
    for (let index = 0; index < count; index += 1) {
      const source = index * rgbComponents;
      const alpha = Number(mask[index * maskComponents] || 0) / 255;
      const destination = index * 4;
      const red = Number(rgb[source] || 0);
      const green = Number(rgb[source + Math.min(1, rgbComponents - 1)] || 0);
      const blue = Number(rgb[source + Math.min(2, rgbComponents - 1)] || 0);
      rgba[destination] = Math.round(red * (1 - alpha * 0.45) + 38 * alpha);
      rgba[destination + 1] = Math.round(green * (1 - alpha * 0.20) + 230 * alpha * 0.65);
      rgba[destination + 2] = Math.round(blue * (1 - alpha * 0.45) + 105 * alpha * 0.25);
      rgba[destination + 3] = 255;
    }
    overlay = await imaging.createImageDataFromBuffer(rgba, {
      width,
      height,
      components: 4,
      chunky: true,
      colorSpace: "RGB",
      colorProfile: "sRGB IEC61966-2.1"
    });
    return {
      mime: "image/png",
      base64: await imaging.encodeImageData({ imageData: overlay, base64: true }),
      width,
      height,
      sourceBounds
    };
  } finally {
    safeDispose(overlay);
    safeDispose(selection && selection.imageData);
    safeDispose(pixels && pixels.imageData);
  }
}

function visualPointToPixels(point, params, snapshot) {
  const scaleX = params.unit === "percent" ? Number(snapshot.document.width) / 100 : 1;
  const scaleY = params.unit === "percent" ? Number(snapshot.document.height) / 100 : 1;
  return { x: Number(point.x) * scaleX, y: Number(point.y) * scaleY };
}

function normalizedCropPoint(point, params, snapshot, sourceBounds) {
  const pixel = visualPointToPixels(point, params, snapshot);
  return [
    Math.max(0, Math.min(1, (pixel.x - sourceBounds.left) / Math.max(1, sourceBounds.right - sourceBounds.left))),
    Math.max(0, Math.min(1, (pixel.y - sourceBounds.top) / Math.max(1, sourceBounds.bottom - sourceBounds.top)))
  ];
}

function normalizedCropBox(box, params, snapshot, sourceBounds) {
  const leftTop = normalizedCropPoint({ x: box.left, y: box.top }, params, snapshot, sourceBounds);
  const rightBottom = normalizedCropPoint({ x: box.right, y: box.bottom }, params, snapshot, sourceBounds);
  return [leftTop[0], leftTop[1], rightBottom[0], rightBottom[1]];
}

async function captureColorPickerComposite() {
  if (!app.documents.length) throw new Error("请先打开一个Photoshop文档。");
  const doc = app.activeDocument;
  const documentWidth = Math.max(1, Math.round(numberValue(doc.width)));
  const documentHeight = Math.max(1, Math.round(numberValue(doc.height)));
  const height = Math.min(900, documentHeight);
  const imageObject = await imaging.getPixels({
    documentID: Number(doc.id),
    targetSize: { height },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  });
  try {
    const width = Number(imageObject.imageData.width);
    const previewHeight = Number(imageObject.imageData.height);
    const source = await imageObject.imageData.getData({ chunky: true });
    const pixels = new Uint8Array(source);
    const components = Math.max(1, Math.round(pixels.length / Math.max(1, width * previewHeight)));
    return {
      documentId: Number(doc.id),
      documentWidth,
      documentHeight,
      width,
      height: previewHeight,
      components,
      pixels,
      mime: "image/jpeg",
      base64: await imaging.encodeImageData({ imageData: imageObject.imageData, base64: true })
    };
  } finally {
    safeDispose(imageObject && imageObject.imageData);
  }
}

function rgbToColorName(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = max ? delta / max : 0;
  if (max < 0.14) return "黑色";
  if (saturation < 0.1) return max > 0.9 ? "白色" : max > 0.65 ? "浅灰" : max > 0.32 ? "灰色" : "深灰";
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return "红色";
  if (hue < 45) return "橙色";
  if (hue < 70) return "黄色";
  if (hue < 165) return "绿色";
  if (hue < 195) return "青色";
  if (hue < 255) return "蓝色";
  if (hue < 300) return "紫色";
  return "粉色";
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function averagePickerColor(picker, centerX, centerY, radius) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  const left = Math.max(0, centerX - radius);
  const right = Math.min(picker.width - 1, centerX + radius);
  const top = Math.max(0, centerY - radius);
  const bottom = Math.min(picker.height - 1, centerY + radius);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * picker.width + x) * picker.components;
      red += Number(picker.pixels[offset]);
      green += Number(picker.pixels[offset + Math.min(1, picker.components - 1)]);
      blue += Number(picker.pixels[offset + Math.min(2, picker.components - 1)]);
      count += 1;
    }
  }
  return {
    red: Math.round(red / Math.max(1, count)),
    green: Math.round(green / Math.max(1, count)),
    blue: Math.round(blue / Math.max(1, count))
  };
}

function pickerCoordinates(event) {
  const picker = runtime.colorPicker;
  const image = $("colorPickerImage");
  if (!picker || !image) return null;
  const rect = image.getBoundingClientRect();
  const clientX = Number(event.clientX);
  const clientY = Number(event.clientY);
  const fallbackX = Number(event.offsetX);
  const fallbackY = Number(event.offsetY);
  let localX = Number.isFinite(clientX) ? clientX - Number(rect.left) : fallbackX;
  let localY = Number.isFinite(clientY) ? clientY - Number(rect.top) : fallbackY;
  if ((!Number.isFinite(localX) || localX < 0 || localX >= rect.width) && Number.isFinite(fallbackX)) localX = fallbackX;
  if ((!Number.isFinite(localY) || localY < 0 || localY >= rect.height) && Number.isFinite(fallbackY)) localY = fallbackY;
  if (!Number.isFinite(localX) || !Number.isFinite(localY) || localX < 0 || localY < 0 || localX >= rect.width || localY >= rect.height) return null;
  const pixelX = Math.max(0, Math.min(picker.width - 1, Math.floor(localX / Math.max(1, rect.width) * picker.width)));
  const pixelY = Math.max(0, Math.min(picker.height - 1, Math.floor(localY / Math.max(1, rect.height) * picker.height)));
  return {
    pixelX,
    pixelY,
    canvasX: Math.max(0, Math.min(picker.documentWidth - 1, Math.floor(pixelX / picker.width * picker.documentWidth))),
    canvasY: Math.max(0, Math.min(picker.documentHeight - 1, Math.floor(pixelY / picker.height * picker.documentHeight))),
    leftPercent: localX / Math.max(1, rect.width) * 100,
    topPercent: localY / Math.max(1, rect.height) * 100
  };
}

function updateColorPicker(event) {
  const point = pickerCoordinates(event);
  if (!point || !runtime.colorPicker) return null;
  const color = averagePickerColor(runtime.colorPicker, point.pixelX, point.pixelY, 2);
  const hex = rgbToHex(color.red, color.green, color.blue);
  runtime.colorPicker.lastColor = { ...color, hex, canvasX: point.canvasX, canvasY: point.canvasY };
  $("colorPickerSwatch").style.backgroundColor = hex;
  $("colorPickerHex").textContent = `${rgbToColorName(color.red, color.green, color.blue)} ${hex}`;
  $("colorPickerRgb").textContent = `RGB ${color.red}, ${color.green}, ${color.blue}`;
  $("colorPickerPosition").textContent = `画布坐标 X ${point.canvasX}，Y ${point.canvasY}`;
  const crosshair = $("colorPickerCrosshair");
  crosshair.style.left = `${point.leftPercent}%`;
  crosshair.style.top = `${point.topPercent}%`;
  crosshair.classList.remove("hidden");
  return runtime.colorPicker.lastColor;
}

function deactivateColorPicker() {
  runtime.colorPicker = null;
  $("colorPickerPanel").classList.add("hidden");
  $("colorPickerImage").src = "";
  $("colorPickerCrosshair").classList.add("hidden");
  $("toggleColorPicker").textContent = "悬停取色";
  $("colorPickerHex").textContent = "移动鼠标开始取色";
  $("colorPickerRgb").textContent = "单击即可复制色号";
  $("colorPickerPosition").textContent = "";
  $("colorPickerState").textContent = "默认读取光标周围 5×5 像素的平均色。";
}

async function toggleColorPicker() {
  if (runtime.colorPickerLoading) return;
  if (runtime.colorPicker) {
    deactivateColorPicker();
    return;
  }
  if (!app.documents.length) return showResult("请先打开一个Photoshop文档。", "error");
  const button = $("toggleColorPicker");
  try {
    runtime.colorPickerLoading = true;
    button.disabled = true;
    button.textContent = "正在读取...";
    $("colorPickerPanel").classList.remove("hidden");
    $("colorPickerState").textContent = "正在读取当前 Photoshop 合成画面...";
    const picker = await core.executeAsModal(
      async () => captureColorPickerComposite(),
      { commandName: "v9.8读取悬停取色画面", timeOut: 8 }
    );
    runtime.colorPicker = picker;
    const canvas = $("colorPickerCanvas");
    canvas.style.aspectRatio = `${picker.width} / ${picker.height}`;
    $("colorPickerImage").src = `data:${picker.mime};base64,${picker.base64}`;
    $("colorPickerState").textContent = "移动查看 5×5 平均色；单击复制当前 HEX。";
    button.textContent = "关闭取色";
  } catch (error) {
    deactivateColorPicker();
    showResult(`无法启动悬停取色：${friendlyError(error)}`, "error");
  } finally {
    runtime.colorPickerLoading = false;
    button.disabled = false;
  }
}

function leaveColorPicker() {
  $("colorPickerCrosshair").classList.add("hidden");
}

async function copyHoveredColor(event) {
  const color = updateColorPicker(event);
  if (!color) return;
  await copyPaletteHex(color.hex);
  $("colorPickerState").textContent = `已复制 ${color.hex}（X ${color.canvasX}，Y ${color.canvasY}）`;
}

function buildPalette(data, pixelCount, components, includePixel) {
  const bins = new Map();
  let visiblePixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (includePixel && !includePixel(index)) continue;
    const offset = index * components;
    const alpha = components > 3 ? Number(data[offset + 3]) : 255;
    if (alpha < 32) continue;
    const red = Number(data[offset]);
    const green = Number(data[offset + Math.min(1, components - 1)]);
    const blue = Number(data[offset + Math.min(2, components - 1)]);
    const key = `${red >> 4}-${green >> 4}-${blue >> 4}`;
    const bin = bins.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bin.count += 1;
    bin.red += red;
    bin.green += green;
    bin.blue += blue;
    bins.set(key, bin);
    visiblePixels += 1;
  }
  const candidates = [...bins.values()]
    .map((bin) => ({
      red: Math.round(bin.red / bin.count),
      green: Math.round(bin.green / bin.count),
      blue: Math.round(bin.blue / bin.count),
      count: bin.count
    }))
    .sort((a, b) => b.count - a.count);
  const selected = [];
  for (const color of candidates) {
    const tooSimilar = selected.some((item) => Math.hypot(item.red - color.red, item.green - color.green, item.blue - color.blue) < 42);
    if (tooSimilar) continue;
    selected.push(color);
    if (selected.length >= 10) break;
  }
  const toPaletteEntry = (color) => ({
    hex: `#${[color.red, color.green, color.blue].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`,
    name: rgbToColorName(color.red, color.green, color.blue),
    percent: visiblePixels ? color.count / visiblePixels * 100 : 0
  });
  return {
    primary: selected.map(toPaletteEntry),
    full: candidates.map(toPaletteEntry),
    sampledPixels: visiblePixels
  };
}

async function capturePalette() {
  if (!app.documents.length) return { primary: [], full: [], sampledPixels: 0 };
  console.log("[PSA8] capturePalette:start", app.activeDocument.id);
  const imageObject = await imaging.getPixels({
    documentID: Number(app.activeDocument.id),
    targetSize: { height: 256 },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: false
  });
  try {
    const data = await imageObject.imageData.getData({ chunky: true });
    const pixelCount = Number(imageObject.imageData.width) * Number(imageObject.imageData.height);
    const components = Math.max(1, Math.round(data.length / Math.max(1, pixelCount)));
    const palette = buildPalette(data, pixelCount, components);
    console.log("[PSA8] capturePalette:done", JSON.stringify({ primary: palette.primary, fullCount: palette.full.length }));
    return palette;
  } finally {
    safeDispose(imageObject && imageObject.imageData);
  }
}

function numericBounds(bounds) {
  if (!bounds) return null;
  const result = {};
  for (const key of ["left", "top", "right", "bottom"]) {
    const value = bounds[key];
    result[key] = Number(value && typeof value === "object" && "_value" in value ? value._value : value);
  }
  if (!Object.values(result).every(Number.isFinite) || result.right <= result.left || result.bottom <= result.top) return null;
  return result;
}

async function saveCurrentSelection(documentID) {
  const bounds = numericBounds(app.activeDocument.selection.bounds);
  if (!bounds) return null;
  const saved = await imaging.getSelection({ documentID, sourceBounds: bounds });
  return { imageData: saved.imageData, bounds: saved.sourceBounds };
}

async function restoreSelection(documentID, saved) {
  await app.activeDocument.selection.deselect();
  if (!saved) return;
  try {
    await imaging.putSelection({
      documentID,
      imageData: saved.imageData,
      targetBounds: { left: Number(saved.bounds.left), top: Number(saved.bounds.top) },
      replace: true,
      commandName: "恢复原选区"
    });
  } finally {
    safeDispose(saved && saved.imageData);
  }
}

async function captureActiveSelectionPalette(documentID) {
  const bounds = numericBounds(app.activeDocument.selection.bounds);
  if (!bounds) return null;
  const sampleHeight = Math.max(1, Math.min(256, Math.round(bounds.bottom - bounds.top)));
  const pixelObject = await imaging.getPixels({
    documentID,
    sourceBounds: bounds,
    targetSize: { height: sampleHeight },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: false
  });
  const maskObject = await imaging.getSelection({
    documentID,
    sourceBounds: bounds,
    targetSize: { height: sampleHeight }
  });
  try {
    const pixelData = await pixelObject.imageData.getData({ chunky: true });
    const maskData = await maskObject.imageData.getData({ chunky: true });
    const pixelCount = Number(pixelObject.imageData.width) * Number(pixelObject.imageData.height);
    const maskCount = Number(maskObject.imageData.width) * Number(maskObject.imageData.height);
    if (pixelCount !== maskCount) throw new Error("选区蒙版与画面采样尺寸不一致。");
    const components = Math.max(1, Math.round(pixelData.length / Math.max(1, pixelCount)));
    const maskComponents = Math.max(1, Math.round(maskData.length / Math.max(1, maskCount)));
    return buildPalette(pixelData, pixelCount, components, (index) => Number(maskData[index * maskComponents]) >= 32);
  } finally {
    safeDispose(pixelObject && pixelObject.imageData);
    safeDispose(maskObject && maskObject.imageData);
  }
}

async function captureSemanticPalettes() {
  if (!app.documents.length) return { groups: [], error: "" };
  const documentID = Number(app.activeDocument.id);
  let savedSelection = null;
  try {
    savedSelection = await saveCurrentSelection(documentID);
    const result = await action.batchPlay([{
      _obj: "autoCutout",
      sampleAllLayers: true,
      _options: { dialogOptions: "silent" }
    }], {});
    if (result && result[0] && result[0]._obj === "error") {
      throw new Error(result[0].message || "Photoshop没有识别出主体。");
    }
    const subject = await captureActiveSelectionPalette(documentID);
    if (!subject || !subject.sampledPixels) throw new Error("Photoshop没有识别出明确的人物或主体。");
    await app.activeDocument.selection.inverse();
    const background = await captureActiveSelectionPalette(documentID);
    return {
      groups: [
        { id: "subject", label: "人物 / 主体", ...subject },
        ...(background && background.sampledPixels ? [{ id: "background", label: "背景", ...background }] : [])
      ],
      error: ""
    };
  } catch (error) {
    return { groups: [], error: friendlyError(error) };
  } finally {
    try {
      await restoreSelection(documentID, savedSelection);
    } catch (error) {
      console.error("[PSA8] selection restore failed", String(error.stack || error));
    }
  }
}

async function captureSemanticPalettesWithoutHistory(executionContext) {
  if (!app.documents.length) return { groups: [], error: "" };
  const hostControl = executionContext && executionContext.hostControl;
  if (!hostControl || typeof hostControl.suspendHistory !== "function" || typeof hostControl.resumeHistory !== "function") {
    return { groups: [], error: "当前Photoshop环境不能安全回滚主体识别，已跳过人物/背景颜色拆分。" };
  }
  let suspension = null;
  try {
    suspension = await hostControl.suspendHistory({
      documentID: Number(app.activeDocument.id),
      name: "Natural Edit Agent 临时识别主体"
    });
    return await captureSemanticPalettes();
  } finally {
    if (suspension) {
      try {
        await hostControl.resumeHistory(suspension, false);
      } catch (error) {
        console.error("[PSA9] semantic inspection rollback failed", String(error.stack || error));
      }
    }
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function setReferenceImage(name, mime, base64) {
  runtime.reference = {
    name: String(name || "批注图"),
    mime: String(mime || "image/png"),
    base64: String(base64 || "")
  };
  $("referenceName").textContent = `已添加：${runtime.reference.name}`;
  $("referencePreview").src = `data:${runtime.reference.mime};base64,${runtime.reference.base64}`;
  $("referencePreview").classList.remove("hidden");
  $("clearReference").disabled = false;
}

async function chooseReference() {
  const file = await storage.localFileSystem.getFileForOpening({ types: ["png", "jpg", "jpeg"] });
  if (!file) return;
  const buffer = await file.read({ format: storage.formats.binary });
  const extension = String(file.name || "").toLowerCase().split(".").pop();
  const mime = extension === "png" ? "image/png" : "image/jpeg";
  setReferenceImage(file.name, mime, arrayBufferToBase64(buffer));
  showResult("已添加批注图。分析时会同时读取当前Photoshop画面。", "muted");
}

async function pasteReferenceFromClipboard(options) {
  const silent = Boolean(options && options.silent);
  try {
    if (!silent) {
      $("pasteReference").disabled = true;
      $("pasteReference").textContent = "正在读取...";
    }
    const data = await fetchJson(`${PROXY_URL}/clipboard-image`, { method: "POST" }, 10000);
    if (!data.base64) throw new Error(data.error || "剪贴板里没有截图。");
    setReferenceImage(data.name || "clipboard.png", data.mime || "image/png", data.base64);
    showResult("已从剪贴板添加截图，不需要先保存文件。", "muted");
    return true;
  } catch (error) {
    if (!silent) showResult(`无法粘贴截图：${friendlyError(error)}`, "error");
    return false;
  } finally {
    if (!silent) {
      $("pasteReference").disabled = false;
      $("pasteReference").textContent = "粘贴截图";
    }
  }
}

function clearReference() {
  runtime.reference = null;
  $("referenceName").textContent = "未添加批注图；可点“粘贴截图”，或在未编辑文字时按 Ctrl+V";
  $("referencePreview").src = "";
  $("referencePreview").classList.add("hidden");
  $("clearReference").disabled = true;
}

function instructionUsesReferenceCoordinates(instruction) {
  return /(?:批注|截图|参考图|红框|方框|框内|框里|圈出|圈住|箭头|标记|指向|指着|所指|这里|这个位置)/i.test(String(instruction || ""));
}

async function validateReferenceCorrespondence(instruction, currentPreview) {
  if (!runtime.reference || !instructionUsesReferenceCoordinates(instruction)) return null;
  if (!/^image\/(?:png|jpeg)$/i.test(String(runtime.reference.mime || ""))) {
    throw new Error("批注画面一致性校验只支持 PNG/JPG；请重新粘贴当前 Photoshop 画面的截图。");
  }
  const health = await checkProxy();
  if (!runtime.proxyConfigured || !health || !health.referenceMatching || health.referenceMatching.available !== true) {
    throw localServiceError(
      "REFERENCE_MATCH_UNAVAILABLE",
      "本地批注画面一致性校验不可用。为避免把错误截图坐标映射到当前文档，本次已在模型请求和 Photoshop 修改前停止。"
    );
  }
  const result = await fetchJson(`${PROXY_URL}/reference-match-v9.8`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentBase64: currentPreview.base64,
      referenceBase64: runtime.reference.base64
    })
  }, 35000);
  if (result.match !== true) {
    throw new Error(`批注截图与当前 Photoshop 画面不匹配（本地视觉指纹${Math.round(Number(result.confidence || 0) * 100)}%）。请重新截取当前画面后再批注；本次没有调用模型，也没有修改文档。`);
  }
  return {
    match: true,
    method: String(result.method || "unknown"),
    confidence: Number(result.confidence || 0)
  };
}

async function modelCaller(payload, visualContext, callOptions) {
  const options = callOptions || {};
  const settings = currentFormSettings();
  const provider = modelProviders.getProvider(settings.providerId);
  const requestedModelId = String(options.modelId || settings.modelId);
  const requestStage = String(options.stage || "planning");
  const requestKey = String(options.requestKey || requestStage);
  const requestPurpose = String(options.purpose || "理解并生成受控操作");
  const overrides = settings.modelCapabilities && settings.modelCapabilities[provider.id];
  const model = modelProviders.resolveModel(provider.id, requestedModelId, overrides);
  const apiKey = settings.apiKeys[provider.id] || "";
  if (!apiKey) {
    throw new Error(`该指令需要模型理解，请先在“模型设置”中填写${provider.apiKeyLabel}并保存。`);
  }
  if (visualContext && (!model || !model.vision)) {
    if (model && model.capabilityKnown === false) {
      throw new Error(`${model.label}的图片能力未知，因此不会向它发送 Photoshop 画面。请点“刷新模型列表”读取服务端能力声明，或选择明确标有“支持图片”的模型。`);
    }
    throw new Error(`${model ? model.label : settings.modelId}不支持读取当前Photoshop画面，不能可靠定位对象。请在“模型设置”中选择标有“支持图片”的模型。`);
  }
  let resolvedVisual = visualContext ? { ...visualContext } : {};
  if (model && model.vision) {
    resolvedVisual.current = resolvedVisual.current || await core.executeAsModal(
      async () => captureComposite(),
      { commandName: "v9.8读取当前合成画面", timeOut: 8 }
    );
    runtime.currentPreview = resolvedVisual.current;
  } else {
    resolvedVisual = null;
    runtime.currentPreview = null;
  }
  const evidenceImages = resolvedVisual && Array.isArray(resolvedVisual.evidence) ? resolvedVisual.evidence : [];
  const imageOrder = resolvedVisual
    ? [
        "第1张是当前Photoshop合成画面",
        ...evidenceImages.map((item, index) => `第${index + 2}张是${item.label || "候选目标局部裁剪"}`),
        ...(resolvedVisual.reference ? [`第${evidenceImages.length + 2}张是用户批注图`] : [])
      ].join("，")
    : "";
  const userContent = resolvedVisual ? [
    {
      type: "text",
      text: `${payload.user}\n图片顺序：${imageOrder}。所有视觉坐标必须以第1张完整画布为准。`
    },
    { type: "image_url", image_url: { url: `data:${resolvedVisual.current.mime};base64,${resolvedVisual.current.base64}` } }
  ] : payload.user;
  for (const item of evidenceImages) {
    userContent.push({ type: "image_url", image_url: { url: `data:${item.mime};base64,${item.base64}` } });
  }
  if (resolvedVisual && resolvedVisual.reference) {
    userContent.push({ type: "image_url", image_url: { url: `data:${resolvedVisual.reference.mime};base64,${resolvedVisual.reference.base64}` } });
  }
  const requestInput = {
    providerId: provider.id,
    modelId: requestedModelId,
    apiKey,
    stage: requestStage,
    system: payload.system,
    userContent,
    maxTokens: options.maxTokens
  };
  const nativeRequest = modelProviders.buildRequest(requestInput);
  runtime.cancelRequested = false;
  if (!runtime.proxyConfigured) await checkProxy();
  if (!runtime.proxyConfigured) {
    throw localServiceError(
      "LOCAL_BRIDGE_UNAVAILABLE",
      "Natural Edit Agent 本地服务未启动或版本不匹配。模型请求尚未发送；请运行 v9.8 启动脚本后重试。"
    );
  }
  const transport = "proxy";
  for (let attempt = 0; attempt <= MODEL_RETRY_DELAYS.length; attempt += 1) {
    try {
      assertModelRequestBudget(requestStage, requestKey);
      const trace = {
        runId: runtime.analysisRunId,
        stage: requestInput.stage,
        requestKey,
        purpose: requestPurpose,
        provider: provider.id,
        model: nativeRequest.modelId,
        transport,
        attempt: attempt + 1,
        startedAt: new Date().toISOString()
      };
      runtime.modelRequestTrace.push(trace);
      // Keep enough entries for the hard total budget to remain enforceable.
      runtime.modelRequestTrace = runtime.modelRequestTrace.slice(-(MODEL_REQUEST_TOTAL_LIMIT * 2));
      appendLog({ stage: "model_request_started", ...trace });
      let parsed;
      try {
        const proxyData = await fetchJson(`${PROXY_URL}/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(modelProviders.proxyEnvelope(requestInput))
        }, nativeRequest.timeoutMs + 10000);
        parsed = proxyData && typeof proxyData.content === "string"
          ? proxyData
          : modelProviders.parseResponse(provider.id, proxyData);
      } catch (proxyError) {
        if (isNetworkTransportError(proxyError)) {
          throw localServiceError(
            "LOCAL_BRIDGE_DISCONNECTED",
            "Natural Edit Agent 本地服务在请求期间断开。为避免同一次点击重复请求模型，插件没有自动切换通道；请启动服务后重新分析。",
            proxyError
          );
        }
        throw proxyError;
      }
      trace.completedAt = new Date().toISOString();
      appendLog({ stage: "model_transport", transport, provider: provider.id, model: nativeRequest.modelId, requestStage: requestInput.stage, attempt: attempt + 1 });
      if (!String(parsed.content || "").trim()) throw new Error(`模型返回为空（请求编号：${parsed.requestId || "未知"}）`);
      if (attempt > 0) appendLog({ stage: "model_retry_recovered", provider: provider.id, model: requestedModelId, attempt: attempt + 1 });
      return parsed.content;
    } catch (error) {
      if (runtime.cancelRequested) {
        const stopped = new Error("已停止等待");
        stopped.name = "AbortError";
        throw stopped;
      }
      if (!isTransientModelError(error) || attempt >= MODEL_RETRY_DELAYS.length) throw error;
      const waitMs = MODEL_RETRY_DELAYS[attempt];
      appendLog({ stage: "model_retry", provider: provider.id, model: requestedModelId, attempt: attempt + 1, waitMs, error: String(error.message || error) });
      showResult(`${provider.label}暂时拥堵，${Math.round(waitMs / 100) / 10}秒后自动重试（${attempt + 2}/${MODEL_RETRY_DELAYS.length + 1}）…`, "muted");
      await waitForModelRetry(waitMs);
    }
  }
  throw new Error("模型请求未返回。");
}

function formatRatio(value) {
  if (!Number.isFinite(value) || value <= 0) return "未知";
  if (value >= 1) return `${value.toFixed(2)}:1`;
  return `1:${(1 / value).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPalette() {
  const container = $("dominantColors");
  const semanticContainer = $("semanticColors");
  const semanticStatus = $("semanticColorsStatus");
  const copyState = $("paletteCopyState");
  if (copyState) copyState.textContent = "";
  if (runtime.paletteError) {
    container.className = "color-palette palette-error";
    container.value = `颜色分析失败：${runtime.paletteError}`;
    semanticContainer.textContent = "";
    semanticStatus.textContent = "";
    clearPalettePicker();
    return;
  }

  if (!runtime.palette.length) {
    container.className = "color-palette field-hint";
    container.value = "没有读取到可见颜色。";
    semanticContainer.textContent = "";
    semanticStatus.textContent = "";
    clearPalettePicker();
    return;
  }

  container.className = "color-palette palette-text";
  container.value = paletteText(runtime.palette);
  renderSemanticPalettes();
  renderPalettePicker();
}

function paletteCategories() {
  const categories = [{ id: "overall", label: "整幅画面", colors: runtime.palette }];
  for (const group of runtime.semanticPalettes) {
    categories.push({ id: group.id, label: group.label, colors: group.primary });
  }
  const textColors = textLayerColors().slice(0, 10).map((color) => ({
    name: "文字",
    hex: color.hex,
    percent: null,
    layerNames: color.layers
  }));
  if (textColors.length) categories.push({ id: "text", label: "文字图层", colors: textColors });
  return categories.filter((category) => category.colors.length);
}

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function clearPalettePicker() {
  $("paletteCategory").textContent = "";
  $("paletteCategory").disabled = true;
  for (let index = 0; index < 10; index += 1) {
    const slot = $(`paletteSlot${index}`);
    slot.textContent = "";
    slot.dataset.hex = "";
    slot.disabled = true;
  }
  $("paletteCopyState").textContent = "";
}

function renderPalettePicker() {
  const categorySelect = $("paletteCategory");
  categorySelect.textContent = "";
  const categories = paletteCategories();
  for (const category of categories) appendOption(categorySelect, category.id, `${category.label}（前${Math.min(10, category.colors.length)}种）`);
  categorySelect.disabled = !categories.length;
  renderPaletteColorOptions();
}

function renderPaletteColorOptions() {
  const categorySelect = $("paletteCategory");
  const category = paletteCategories().find((item) => item.id === categorySelect.value) || paletteCategories()[0];
  if (!category) {
    clearPalettePicker();
    return;
  }
  const colors = category.colors.slice(0, 10);
  for (let index = 0; index < 10; index += 1) {
    const slot = $(`paletteSlot${index}`);
    const color = colors[index];
    if (!color) {
      slot.textContent = "";
      slot.dataset.hex = "";
      slot.disabled = true;
      continue;
    }
    const suffix = color.percent == null ? "" : ` · ${formatPalettePercent(color.percent)}%`;
    const layers = color.layerNames ? ` · ${color.layerNames.join("、")}` : "";
    slot.textContent = `${index + 1}. ${color.name} ${color.hex}${suffix}${layers}`;
    slot.dataset.hex = color.hex;
    slot.title = `复制 ${color.hex}`;
    slot.disabled = false;
  }
  $("paletteCopyState").textContent = "";
}

function renderSemanticPalettes() {
  const container = $("semanticColors");
  const status = $("semanticColorsStatus");
  const textColors = textLayerColors();
  if (runtime.semanticPaletteError) {
    status.textContent = `暂未分类：${runtime.semanticPaletteError}`;
    container.textContent = "";
    appendTextColorGroup(container, textColors);
    return;
  }
  status.textContent = runtime.semanticPalettes.length
    ? "人物与背景由 Photoshop 主体选区分析；文字色号直接读取图层属性。"
    : (textColors.length ? "文字色号直接读取图层属性。" : "没有可用的区域分类。");
  if (runtime.insightsStale) {
    status.textContent = "画面已修改，当前颜色和主体分析为上次结果；点击右上角刷新按钮可重新分析。";
  } else if (runtime.insightsReady) {
    status.textContent += " 分析结果已缓存，选择图层不会重复识别主体。";
  }
  container.textContent = "";
  for (const group of runtime.semanticPalettes) {
    const details = document.createElement("details");
    details.className = "semantic-color-group";
    if (group.id === "subject") details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${group.label} · 前${Math.min(10, group.primary.length)}种`;
    details.appendChild(summary);
    const rows = document.createElement("div");
    rows.className = "semantic-primary";
    rows.textContent = paletteText(group.primary);
    details.appendChild(rows);
    container.appendChild(details);
  }
  appendTextColorGroup(container, textColors);
}

function textLayerColors() {
  const colors = new Map();
  for (const layer of runtime.snapshot && runtime.snapshot.flatLayers || []) {
    const hex = layer.text && layer.text.color;
    if (!hex) continue;
    const normalized = String(hex).toUpperCase();
    const entry = colors.get(normalized) || { hex: normalized, layers: [] };
    entry.layers.push(layer.name);
    colors.set(normalized, entry);
  }
  return [...colors.values()];
}

function appendTextColorGroup(container, colors) {
  if (!colors.length) return;
  const shown = colors.slice(0, 10);
  const details = document.createElement("details");
  details.className = "semantic-color-group";
  const summary = document.createElement("summary");
  summary.textContent = `文字图层 · 前${shown.length}种`;
  details.appendChild(summary);
  const rows = document.createElement("div");
  rows.className = "semantic-primary";
  rows.textContent = shown.map((color, index) => `${index + 1}. ${color.hex} · ${color.layers.join("、")}`).join("\n");
  details.appendChild(rows);
  container.appendChild(details);
}

function formatPalettePercent(value) {
  const percent = Number(value || 0);
  if (percent >= 1) return percent.toFixed(1);
  if (percent >= 0.1) return percent.toFixed(2);
  return percent.toFixed(3);
}

function paletteText(colors = runtime.fullPalette) {
  return colors
    .map((color, index) => `${index + 1}. ${color.name} ${color.hex}（约${formatPalettePercent(color.percent)}%）`)
    .join("\n");
}

async function copyPaletteHex(hex) {
  if (!hex) return;
  const state = $("paletteCopyState");
  try {
    await navigator.clipboard.writeText(hex);
    state.textContent = `已复制 ${hex}`;
    console.log("[PSA8] palette color copied", hex);
  } catch (error) {
    state.textContent = "复制失败";
    showResult(`颜色复制失败：${friendlyError(error)}`, "error");
    console.error("[PSA8] palette copy failed", String(error.stack || error));
  }
}

async function copyPaletteSlot(event) {
  await copyPaletteHex(event.currentTarget.dataset.hex);
}

function renderSnapshot(snapshot) {
  const dot = $("documentDot");
  if (!snapshot.hasDocument) {
    deactivateColorPicker();
    $("toggleColorPicker").disabled = true;
    dot.className = "status-dot error";
    $("documentTitle").textContent = "没有打开的Photoshop文档";
    $("documentSummary").textContent = "请先打开PSD后刷新。";
    $("stateMetrics").innerHTML = "";
    $("selectedLayers").textContent = "";
    $("dominantColors").value = "";
    clearPalettePicker();
    $("semanticColors").textContent = "";
    $("semanticColorsStatus").textContent = "";
    $("layerInventory").textContent = "";
    $("maskInventory").textContent = "";
    return;
  }
  $("toggleColorPicker").disabled = runtime.busy || runtime.colorPickerLoading;
  dot.className = "status-dot ready";
  const doc = snapshot.document;
  $("documentTitle").textContent = doc.title;
  $("documentSummary").textContent = `${Math.round(doc.width)}×${Math.round(doc.height)}px · ${doc.resolution}ppi · ${doc.mode} · 比例${formatRatio(doc.aspectRatio)}`;
  const metrics = [
    [snapshot.metrics.layers, "图层"],
    [snapshot.metrics.groups, "组"],
    [snapshot.metrics.textLayers, "文字层"],
    [snapshot.metrics.maskedLayers || 0, "蒙版"],
    [snapshot.metrics.hiddenLayers, "隐藏"],
    [snapshot.metrics.lockedLayers, "锁定"]
  ];
  $("stateMetrics").innerHTML = metrics.map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
  $("selectedLayers").textContent = snapshot.activeLayers.length
    ? `当前选中：${snapshot.activeLayers.map((layer) => `${layer.name}（ID ${layer.id}）`).join("、")}`
    : "当前没有选中图层。";
  renderPalette();
  const shownLayers = snapshot.flatLayers.slice(0, 80);
  $("layerInventory").textContent = shownLayers.length
    ? shownLayers.map((layer) => `${"  ".repeat(layer.depth)}${layer.visible ? "●" : "○"} ${layer.name} · ${layer.kind}${layer.children.length ? ` · ${layer.children.length}项` : ""}`).join("\n")
      + (snapshot.flatLayers.length > shownLayers.length ? `\n…还有${snapshot.flatLayers.length - shownLayers.length}个图层` : "")
    : "当前文档没有图层。";
  const masks = snapshot.flatLayers.filter((layer) => layer.hasLayerMask || layer.hasVectorMask || layer.clippingMask);
  const texts = snapshot.flatLayers.filter((layer) => layer.text);
  const maskLines = masks.length
    ? masks.map((layer) => `${layer.name}：${[layer.hasLayerMask ? "像素蒙版" : "", layer.hasVectorMask ? "矢量蒙版" : "", layer.clippingMask ? "剪贴蒙版" : ""].filter(Boolean).join("、")}`)
    : ["没有蒙版"];
  const textLines = texts.length
    ? texts.map((layer) => `文字「${String(layer.text.contents).replace(/\s+/g, " ").slice(0, 32)}」 · ${layer.name}`)
    : ["没有文字层"];
  $("maskInventory").textContent = [...maskLines, "", ...textLines].join("\n");
}

async function performRefreshState(options = {}) {
  if (runtime.colorPicker) deactivateColorPicker();
  const hasDocument = app.documents.length > 0;
  const activeDocumentId = hasDocument ? Number(app.activeDocument.id) : null;
  const refreshInsights = hasDocument && (
    options.forceInsights === true
    || !runtime.insightsReady
    || runtime.insightsStale
    || runtime.insightDocumentId !== activeDocumentId
  );
  const paletteElement = $("dominantColors");
  $("paletteCopyState").textContent = "";
  if (refreshInsights) {
    $("semanticColorsStatus").textContent = "正在识别人物 / 主体与背景...";
  }
  if (paletteElement && (refreshInsights || !hasDocument)) {
    paletteElement.className = "color-palette field-hint";
    paletteElement.value = hasDocument ? "正在读取当前画面的主要颜色..." : "请先打开一份 Photoshop 文档。";
  }
  console.log("[PSA8] refreshState:start", app.documents.length, refreshInsights ? "with-insights" : "state-only");
  try {
    const inspection = await core.executeAsModal(async (executionContext) => {
      let palette = { primary: runtime.palette, full: runtime.fullPalette };
      let semantic = { groups: runtime.semanticPalettes, error: runtime.semanticPaletteError };
      let paletteError = runtime.paletteError;
      if (refreshInsights) {
        palette = { primary: [], full: [] };
        semantic = { groups: [], error: "" };
        paletteError = "";
        try {
          palette = await capturePalette();
          semantic = await captureSemanticPalettesWithoutHistory(executionContext);
        } catch (error) {
          paletteError = friendlyError(error);
        }
      }
      const snapshot = await stateEngine.snapshot();
      return { snapshot, palette, semantic, paletteError, insightsRefreshed: refreshInsights };
    }, { commandName: "v9.8读取文档与颜色", timeOut: 8 });
    runtime.snapshot = inspection.snapshot;
    runtime.palette = inspection.palette.primary;
    runtime.fullPalette = inspection.palette.full;
    runtime.semanticPalettes = inspection.semantic.groups;
    runtime.semanticPaletteError = inspection.semantic.error;
    runtime.paletteError = inspection.paletteError;
    if (inspection.insightsRefreshed) {
      runtime.insightDocumentId = inspection.snapshot.hasDocument ? inspection.snapshot.document.id : null;
      runtime.insightsReady = inspection.snapshot.hasDocument;
      runtime.insightsStale = false;
    } else if (!inspection.snapshot.hasDocument) {
      runtime.insightDocumentId = null;
      runtime.insightsReady = false;
      runtime.insightsStale = false;
      runtime.palette = [];
      runtime.fullPalette = [];
      runtime.semanticPalettes = [];
      runtime.semanticPaletteError = "";
      runtime.paletteError = "";
    }
    runtime.snapshot.palette = runtime.palette;
    runtime.documentSignature = documentSignature();
    renderSnapshot(runtime.snapshot);
    console.log("[PSA8] refreshState:done", runtime.palette.length, runtime.paletteError, inspection.insightsRefreshed ? "insights-refreshed" : "cache-reused");
    return runtime.snapshot;
  } catch (error) {
    if (refreshInsights) {
      runtime.palette = [];
      runtime.fullPalette = [];
      runtime.semanticPalettes = [];
      runtime.semanticPaletteError = "";
      runtime.paletteError = friendlyError(error);
      runtime.insightsReady = false;
    }
    renderPalette();
    console.error("[PSA8] refreshState:error", String(error.stack || error));
    if (!options.silentError) showResult(`读取文档失败：${friendlyError(error)}`, "error");
    throw error;
  }
}

async function refreshState(options = {}) {
  if (runtime.refreshPromise) return runtime.refreshPromise;
  runtime.refreshingState = true;
  const refreshPromise = performRefreshState(options);
  runtime.refreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (runtime.refreshPromise === refreshPromise) runtime.refreshPromise = null;
    runtime.refreshingState = false;
  }
}

function markInsightsStale() {
  if (!runtime.insightsReady) return;
  runtime.insightsStale = true;
}

function documentSignature() {
  if (!app.documents.length) return "no-document";
  try {
    const doc = app.activeDocument;
    const activeIds = Array.from(doc.activeLayers || []).map((layer) => Number(layer.id)).join(",");
    const activeHistory = doc.activeHistoryState;
    const historyId = activeHistory ? Number(activeHistory.id || 0) : 0;
    return [
      Number(doc.id),
      String(doc.title || doc.name || ""),
      Math.round(numberValue(doc.width)),
      Math.round(numberValue(doc.height)),
      Array.from(doc.layers || []).length,
      historyId,
      activeIds
    ].join(":");
  } catch (_) {
    return `documents:${app.documents.length}`;
  }
}

async function refreshWhenDocumentChanges() {
  if (runtime.busy || runtime.refreshingState) return;
  if (runtime.plan) return;
  const signature = documentSignature();
  if (signature === runtime.documentSignature) return;
  try {
    await refreshState({ forceInsights: false });
  } catch (_) {
    // The visible palette error is the source of truth; polling will retry on the next document change.
  }
}

function renderPlan(plan) {
  $("planSection").classList.remove("hidden");
  $("planTitle").textContent = plan.steps.length === 1 ? "1项修改等待确认" : `${plan.steps.length}项修改等待确认`;
  $("routeBadge").textContent = "已检查";
  $("planSummary").textContent = plan.summary;
  renderTargetPreview(plan);
  $("planSteps").innerHTML = plan.steps.map((step) => {
    const params = Object.entries(step.params).filter(([key]) => !key.startsWith("_") && !["maskToken", "selectionSessionToken"].includes(key)).map(([key, value]) => {
      const shown = value && typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key}=${shown}`;
    }).join("，");
    return `<li><strong>${escapeHtml(step.label)}</strong> · ${escapeHtml(step.target.path)}<small>${escapeHtml(params || "无额外参数")}</small></li>`;
  }).join("");
  if (plan.constraints.length) {
    $("planWarnings").classList.remove("hidden");
    $("planWarnings").textContent = plan.constraints.map((item) => `• ${item}`).join("\n");
  } else {
    $("planWarnings").classList.add("hidden");
  }
  const highRiskPanel = $("highRiskConfirmation");
  const highRiskText = $("highRiskConfirmationText");
  const highRiskCheckbox = $("confirmHighRisk");
  const highRiskIds = Array.isArray(plan.highRiskStepIds) ? plan.highRiskStepIds : [];
  if (highRiskPanel) highRiskPanel.classList.toggle("hidden", highRiskIds.length === 0);
  if (highRiskText && highRiskIds.length) {
    const labels = plan.steps.filter((step) => highRiskIds.includes(step.id)).map((step) => step.label || step.action);
    highRiskText.textContent = `高风险操作需要单独授权：${labels.join("、")}`;
  }
  if (highRiskCheckbox) highRiskCheckbox.checked = runtime.highRiskConfirmed;
  const planSection = $("planSection");
  const executeButton = $("executePlan");
  if (executeButton) executeButton.disabled = planNeedsVisualConfirmation();
  if (planSection && typeof planSection.scrollIntoView === "function") planSection.scrollIntoView();
}

function renderTargetPreview(plan) {
  const container = $("targetPreview");
  const activeVisual = selectionPlanStep();
  const step = activeVisual && activeVisual.step;
  const preview = runtime.currentPreview;
  const removeFailedButton = $("removeFailedTarget");
  const canRemoveFailedTarget = Boolean(activeVisual
    && selectionPlanSteps().length > 1
    && runtime.visualCandidateErrors.has(activeVisual.index));
  if (removeFailedButton) removeFailedButton.classList.toggle("hidden", !canRemoveFailedTarget);
  if (!step || !preview) {
    container.classList.add("hidden");
    return;
  }
  const params = step.params;
  const width = Number(runtime.snapshot.document.width);
  const height = Number(runtime.snapshot.document.height);
  const toPercentX = (value) => params.unit === "percent" ? Number(value) : Number(value) / Math.max(1, width) * 100;
  const toPercentY = (value) => params.unit === "percent" ? Number(value) : Number(value) / Math.max(1, height) * 100;
  const region = params.searchRegion || { left: 0, top: 0, right: width, bottom: height };
  const target = params.targetBox || null;
  const left = Math.max(0, Math.min(100, toPercentX(region.left)));
  const top = Math.max(0, Math.min(100, toPercentY(region.top)));
  const right = Math.max(left, Math.min(100, toPercentX(region.right)));
  const bottom = Math.max(top, Math.min(100, toPercentY(region.bottom)));
  const canvas = $("targetPreviewCanvas");
  canvas.style.aspectRatio = `${preview.width} / ${preview.height}`;
  const stepIndex = activeVisual ? activeVisual.index : plan.steps.indexOf(step);
  const evidence = runtime.visualEvidence.find((item) => item.stepIndex === stepIndex);
  const visualSteps = selectionPlanSteps();
  const visualPosition = activeVisual ? visualSteps.findIndex((item) => item.index === activeVisual.index) + 1 : 0;
  const confirmed = activeVisual ? runtime.visualConfirmedSteps.has(activeVisual.index) : false;
  // The bridge may return a search-crop preview (and omits source pixels on
  // cache hits). Keep the panel base image in full-canvas coordinates; the
  // exact authority is always the Photoshop active selection/session.
  const shownPreview = preview;
  $("targetPreviewImage").src = `data:${shownPreview.mime};base64,${shownPreview.base64}`;
  const box = $("targetSearchBox");
  box.style.left = `${left}%`;
  box.style.top = `${top}%`;
  box.style.width = `${right - left}%`;
  box.style.height = `${bottom - top}%`;
  const objectBox = $("targetObjectBox");
  if (target) {
    const targetLeft = Math.max(0, Math.min(100, toPercentX(target.left)));
    const targetTop = Math.max(0, Math.min(100, toPercentY(target.top)));
    const targetRight = Math.max(targetLeft, Math.min(100, toPercentX(target.right)));
    const targetBottom = Math.max(targetTop, Math.min(100, toPercentY(target.bottom)));
    objectBox.style.left = `${targetLeft}%`;
    objectBox.style.top = `${targetTop}%`;
    objectBox.style.width = `${targetRight - targetLeft}%`;
    objectBox.style.height = `${targetBottom - targetTop}%`;
    objectBox.classList.remove("hidden");
  } else {
    objectBox.classList.add("hidden");
  }
  const seed = $("targetSeed");
  if (params.seed) {
    seed.style.left = `${Math.max(0, Math.min(100, toPercentX(params.seed.x)))}%`;
    seed.style.top = `${Math.max(0, Math.min(100, toPercentY(params.seed.y)))}%`;
    seed.classList.remove("hidden");
  } else {
    seed.classList.add("hidden");
  }
  const matchBox = $("targetMatchBox");
  if (evidence && evidence.selectionBounds) {
    const match = evidence.selectionBounds;
    matchBox.style.left = `${Math.max(0, Math.min(100, match.left / Math.max(1, width) * 100))}%`;
    matchBox.style.top = `${Math.max(0, Math.min(100, match.top / Math.max(1, height) * 100))}%`;
    matchBox.style.width = `${Math.max(0, Math.min(100, (match.right - match.left) / Math.max(1, width) * 100))}%`;
    matchBox.style.height = `${Math.max(0, Math.min(100, (match.bottom - match.top) / Math.max(1, height) * 100))}%`;
    matchBox.classList.remove("hidden");
  } else {
    matchBox.classList.add("hidden");
  }
  const qualityWarningText = evidence && Array.isArray(evidence.qualityWarnings) && evidence.qualityWarnings.length
    ? ` · 需要人工确认：${evidence.qualityWarnings.join("；")}`
    : "";
  const refinementText = evidence && evidence.colorRefined
    ? ` · 已按目标原颜色细化${Array.isArray(evidence.sourceColorFamilies) && evidence.sourceColorFamilies.length ? `（${evidence.sourceColorFamilies.join("/")}）` : ""}`
    : "";
  const targetPrefix = activeVisual && visualSteps.length > 1 ? `目标${visualPosition}/${visualSteps.length} · ` : "";
  const locationConfidence = Math.round(Number(params.confidence || 0) * 100);
  const geometryConfidence = Math.round(Number(evidence && evidence.geometricIntegrity || 0) * 100);
  const semanticReview = evidence && evidence.semanticVerified === true
    ? `语义复核${Math.round(Number(evidence.semanticConfidence || 0) * 100)}%`
    : "语义复核待确认";
  const providerLabel = params.description || ({
    "selection.subject": "Photoshop 选择主体",
    "selection.subject_region": "选择主体后裁剪到区域（旧计划兼容）",
    "selection.color_range": "颜色范围候选",
    "selection.rectangle": "矩形候选",
    "selection.ellipse": "椭圆候选",
    "selection.polygon": "多边形候选",
    "selection.select_all": "全画布候选",
    "selection.load_layer": "图层透明度候选"
  }[step.action] || "候选选区");
  const sessionToken = step.params && step.params.selectionSessionToken;
  const session = selectionSessions && selectionSessions.describe(sessionToken);
  objectBox.classList.toggle("location-only", !session);
  seed.classList.toggle("location-only", !session);
  const policy = runtime.selectionConfidenceByStep.get(stepIndex)
    || confidencePolicy.classify(params.confidence, { hasCandidate: Boolean(session) });
  $("targetPreviewLabel").textContent = evidence && step.action === "selection.visual_object"
    ? `${targetPrefix}${providerLabel} · 候选蒙版已生成（定位置信度${locationConfidence}%，蒙版几何完整度${geometryConfidence}%，${semanticReview}）${refinementText}${qualityWarningText}`
    : step.action === "selection.subject_region"
      ? `${providerLabel} · 注意：这是“选择主体”后裁剪，不是 Photoshop 对象选择`
      : `${targetPrefix}${providerLabel} · ${session ? "候选已写入 Photoshop 活动选区" : runtime.visualCandidateErrors.get(stepIndex) || "等待建立候选"}`;
  const state = $("candidateState");
  const confirmButton = $("confirmCandidate");
  const help = $("targetPreviewHelp");
  if (help) {
    const needsFineEdge = /发丝|头发|毛发|绒毛|透明|半透明|软边|烟雾|玻璃|hair|fur|transparent|translucent|soft\s*edge|refine\s*hair/i
      .test(`${runtime.activeInstruction} ${params.description || ""}`);
    help.textContent = session
      ? `${policy.message} 候选已写入 Photoshop 活动选区；可直接用套索、对象选择或快速选择做加减，完成后点“采用 Photoshop 当前选区”。${needsFineEdge ? " 此目标包含发丝、毛发、透明或软边；二值 MobileSAM 只作为粗候选，请在 Photoshop 使用“选择并遮住 / 调整边缘 / Refine Hair”精修后再采用当前选区。" : ""}`
      : `${policy.message} 青色虚线框和红点只是模型定位参考，不是 Photoshop 选区；请在预览图重新定位，或在 Photoshop 建立选区后点“采用 Photoshop 当前选区”。`;
  }
  if (state) {
    state.textContent = confirmed
      ? "已锁定 Photoshop 当前选区；执行时不会再用自动蒙版覆盖"
      : session
        ? `${policy.level === "low" ? "低置信度：请修正或明确接受" : policy.level === "medium" ? "建议检查并修正边缘" : "请检查候选；始终可以修正"}${session.corrected ? "（已人工修正）" : ""}`
        : `尚无可执行选区${runtime.visualCandidateErrors.get(stepIndex) ? `：${runtime.visualCandidateErrors.get(stepIndex)}` : ""}`;
    state.classList.toggle("confirmed", confirmed);
    state.classList.toggle("confidence-low", policy.level === "low");
    state.classList.toggle("confidence-medium", policy.level === "medium");
  }
  const acceptRow = $("lowConfidenceAcceptRow");
  if (acceptRow) acceptRow.classList.toggle("hidden", policy.explicitAcceptRequired !== true || confirmed);
  const acceptBox = $("acceptLowConfidence");
  if (acceptBox) acceptBox.checked = Boolean(session && session.lowConfidenceAccepted);
  if (confirmButton) {
    confirmButton.disabled = !confidencePolicy.mayConfirm(policy, session) || confirmed;
    confirmButton.textContent = session ? "这个选区正确" : "尚未生成选区";
  }
  const pointTools = $("pointCandidateTools");
  if (pointTools) pointTools.classList.toggle("hidden", step.action !== "selection.visual_object");
  container.classList.remove("hidden");
}

function normalizedVisualCoordinate(value, unit, axisSize) {
  const number = Number(value);
  if (unit === "percent") return Math.max(0, Math.min(1, number / 100));
  if (unit === "normalized") return Math.max(0, Math.min(1, number));
  return Math.max(0, Math.min(1, number / Math.max(1, axisSize)));
}

function normalizedVisualBox(box, params, snapshot) {
  return [
    normalizedVisualCoordinate(box.left, params.unit, snapshot.document.width),
    normalizedVisualCoordinate(box.top, params.unit, snapshot.document.height),
    normalizedVisualCoordinate(box.right, params.unit, snapshot.document.width),
    normalizedVisualCoordinate(box.bottom, params.unit, snapshot.document.height)
  ];
}

function normalizedVisualPoint(point, params, snapshot) {
  return [
    normalizedVisualCoordinate(point.x, params.unit, snapshot.document.width),
    normalizedVisualCoordinate(point.y, params.unit, snapshot.document.height)
  ];
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function candidateConfidence(step, evidence) {
  if (step.action === "selection.visual_object") {
    const location = Number(step.params.confidence || 0);
    const pixel = Number(evidence && evidence.pixelConfidence || 0);
    return Math.max(0, Math.min(1, location * 0.55 + pixel * 0.45));
  }
  if (step.action === "selection.color_range") return 0.82;
  if (["selection.rectangle", "selection.ellipse", "selection.polygon", "selection.select_all", "selection.load_layer"].includes(step.action)) return 0.96;
  if (step.action === "selection.subject") return 0.72;
  if (step.action === "selection.subject_region") return Number(step.params.confidence == null ? 0 : step.params.confidence);
  return 0;
}

function applyAutomaticSelectionConfirmationPolicy() {
  for (const item of selectionPlanSteps()) {
    const session = selectionSessions.describe(item.step.params.selectionSessionToken);
    const policy = runtime.selectionConfidenceByStep.get(item.index)
      || confidencePolicy.classify(item.step.params.confidence, { hasCandidate: Boolean(session) });
    const evidence = runtime.visualEvidence.find((value) => value.stepIndex === item.index);
    const hasBlockingQualityWarning = item.step.action === "selection.visual_object" && (
      !evidence
      || evidence.requiresHumanConfirmation === true
      || (Array.isArray(evidence.qualityWarnings) && evidence.qualityWarnings.length > 0)
    );
    if (policy.level === "high" && !hasBlockingQualityWarning && confidencePolicy.mayConfirm(policy, session)) {
      runtime.visualConfirmedSteps.add(item.index);
      if (evidence) {
        evidence.requiresHumanConfirmation = false;
        if (!evidence.semanticReason) evidence.semanticReason = "高置信度候选已自动锁定，仍可在执行前修正";
      }
    } else {
      runtime.visualConfirmedSteps.delete(item.index);
      if (evidence) {
        evidence.requiresHumanConfirmation = true;
        if (!evidence.semanticReason) evidence.semanticReason = policy.message;
      }
    }
  }
}

async function captureAuthoritativeSelection(step, stepIndex, materialized, options = {}) {
  const existingToken = step.params.selectionSessionToken || runtime.selectionSessionsByStep.get(stepIndex);
  const session = await selectionSessions.captureCurrent({
    token: existingToken || undefined,
    corrected: options.corrected === true,
    correctionSource: options.correctionSource || "automatic-candidate",
    metadata: {
      ...(materialized || {}),
      providerAction: step.action,
      featherAppliedBeforeLock: Number(step.params.feather || 0)
    }
  });
  step.params.selectionSessionToken = session.token;
  runtime.selectionSessionsByStep.set(stepIndex, session.token);
  const evidence = runtime.visualEvidence.find((item) => item.stepIndex === stepIndex);
  if (evidence) evidence.selectionBounds = { ...session.selectionBounds };
  const confidence = candidateConfidence(step, evidence);
  runtime.selectionConfidenceByStep.set(stepIndex, confidencePolicy.classify(confidence, { hasCandidate: true }));
  return session;
}

async function materializeSelectionCandidate(step, stepIndex, options = {}) {
  const result = await core.executeAsModal(async () => {
    const materialized = await capabilities.materializeSelectionCandidate(step.action, step.params, runtime.snapshot, step.target);
    return {
      materialized,
      session: await captureAuthoritativeSelection(step, stepIndex, materialized, options)
    };
  }, { commandName: `v9.8 建立候选选区：${step.label || step.action}`, timeOut: 20 });
  return result;
}

const STRICT_SNAPSHOT_STABILITY_ATTEMPTS = 5;
const STRICT_SNAPSHOT_STABILITY_DELAY_MS = 45;

function waitForStrictSnapshotStability() {
  return new Promise((resolve) => setTimeout(resolve, STRICT_SNAPSHOT_STABILITY_DELAY_MS));
}

function stateEvidenceRequirements(plan) {
  if (engine && typeof engine.stateEvidenceRequirements === "function") {
    return engine.stateEvidenceRequirements(plan);
  }
  // Conservative compatibility for an older engine module.
  return {
    needsCompositeDigest: true,
    needsSelectionDigest: true,
    needsActiveLayers: true,
    needsLayerTree: true
  };
}

function hasCompleteStrictSnapshotEvidence(state, requirements) {
  return stateEngine.isCompleteIntegritySnapshot(state, requirements);
}

function strictSnapshotEvidenceDiagnostics(stage, latest, requirements) {
  return {
    stage,
    requirements: requirements || null,
    hasDocument: Boolean(latest && latest.hasDocument),
    documentId: latest && latest.document ? Number(latest.document.id) : null,
    fingerprint: latest && latest.fingerprint || null,
    contentFingerprint: latest && latest.contentFingerprint || null,
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

async function readStableStrictSnapshot(stage = "selection_stability", plan = runtime.plan) {
  let previous = null;
  let latest = null;
  const requirements = stateEvidenceRequirements(plan);
  for (let attempt = 0; attempt < STRICT_SNAPSHOT_STABILITY_ATTEMPTS; attempt += 1) {
    const current = await core.executeAsModal(
      async () => stateEngine.snapshot(),
      { commandName: "v9.8 稳定回读权威选区", timeOut: 5 }
    );
    latest = current;
    if (hasCompleteStrictSnapshotEvidence(current, requirements)) {
      const evidenceFingerprint = typeof stateEngine.buildEvidenceFingerprint === "function"
        ? stateEngine.buildEvidenceFingerprint(current, requirements)
        : current.fingerprint;
      if (previous && evidenceFingerprint === previous.evidenceFingerprint) return current;
      previous = { evidenceFingerprint };
    } else {
      previous = null;
    }
    if (attempt + 1 < STRICT_SNAPSHOT_STABILITY_ATTEMPTS) await waitForStrictSnapshotStability();
  }
  const error = new Error("Photoshop 没有返回本次操作所需的稳定状态证据；已在修改前停止，请重试或查看技术日志中的缺失项。");
  error.code = "INCOMPLETE_OR_UNSTABLE_STATE_EVIDENCE";
  error.stateEvidence = strictSnapshotEvidenceDiagnostics(stage, latest, requirements);
  throw error;
}

async function snapshotAndRebaseSelection(authority, selectionItem = null) {
  if (!runtime.plan) return null;
  const after = await readStableStrictSnapshot(`post_selection_restore:${authority || "unknown"}`);
  if (typeof engine.rebasePlanAfterSelection === "function") {
    const active = selectionItem || selectionPlanStep();
    const session = active && selectionSessions.describe(active.step.params.selectionSessionToken);
    runtime.plan = engine.rebasePlanAfterSelection(runtime.plan, runtime.snapshot, after, {
      source: authority,
      sessionId: session && session.token,
      selectionDigest: after.selectionDigest
    });
  } else {
    runtime.plan.sourceFingerprint = after.fingerprint;
  }
  after.palette = runtime.palette;
  runtime.snapshot = after;
  runtime.documentSignature = documentSignature();
  return after;
}

async function activateSelectionStep(item, options = {}) {
  if (!item || !item.step || !item.step.params.selectionSessionToken) return null;
  const session = await core.executeAsModal(
    async () => selectionSessions.restore(item.step.params.selectionSessionToken),
    { commandName: "v9.8 显示待确认选区", timeOut: 8 }
  );
  if (options.rebase === true) await snapshotAndRebaseSelection(
    options.authority || "restore-locked-selection-session",
    item
  );
  return session;
}

async function probeNonVisualSelectionCandidates(plan) {
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (!SELECTION_PROVIDER_ACTIONS.has(step.action) || step.action === "selection.visual_object") continue;
    try {
      const result = await materializeSelectionCandidate(step, index);
      runtime.visualEvidence.push({
        stepIndex: index,
        selectionBounds: result.session.selectionBounds,
        matchingPixels: result.session.selectedPixels,
        candidateProvider: step.action,
        qualityWarnings: step.action === "selection.subject_region"
          ? ["兼容旧计划：先全画布选择主体再裁剪，不等于对象选择"]
          : []
      });
      runtime.visualCandidateErrors.delete(index);
    } catch (error) {
      runtime.visualCandidateErrors.set(index, friendlyError(error));
      runtime.selectionConfidenceByStep.set(index, confidencePolicy.classify(0, { hasCandidate: false }));
    }
  }
}

function visualParamsAsPercent(params, snapshot) {
  const box = (value) => ({
    left: normalizedVisualCoordinate(value.left, params.unit, snapshot.document.width) * 100,
    top: normalizedVisualCoordinate(value.top, params.unit, snapshot.document.height) * 100,
    right: normalizedVisualCoordinate(value.right, params.unit, snapshot.document.width) * 100,
    bottom: normalizedVisualCoordinate(value.bottom, params.unit, snapshot.document.height) * 100
  });
  const point = (value) => ({
    x: normalizedVisualCoordinate(value.x, params.unit, snapshot.document.width) * 100,
    y: normalizedVisualCoordinate(value.y, params.unit, snapshot.document.height) * 100
  });
  return {
    ...params,
    unit: "percent",
    targetBox: box(params.targetBox),
    searchRegion: box(params.searchRegion),
    seed: point(params.seed),
    positivePoints: (params.positivePoints || []).map(point),
    excludePoints: (params.excludePoints || []).map(point)
  };
}

function boundedBoxAround(x, y, widthValue, heightValue) {
  const width = Math.max(6, Math.min(70, widthValue));
  const height = Math.max(6, Math.min(70, heightValue));
  let left = x - width / 2;
  let top = y - height / 2;
  left = Math.max(0, Math.min(100 - width, left));
  top = Math.max(0, Math.min(100 - height, top));
  return { left, top, right: left + width, bottom: top + height };
}

function expandBox(box, point, padding) {
  return {
    left: Math.max(0, Math.min(box.left, point.x - padding)),
    top: Math.max(0, Math.min(box.top, point.y - padding)),
    right: Math.min(100, Math.max(box.right, point.x + padding)),
    bottom: Math.min(100, Math.max(box.bottom, point.y + padding))
  };
}

const VISUAL_COLOR_FAMILIES = [
  ["red", /红色|红发|红头发|红胡子|红色块|\b(?:red)\b/i],
  ["orange", /橙色|橘色|橙发|橘发|\b(?:orange)\b/i],
  ["yellow", /黄色|金黄|黄色块|\b(?:yellow|gold)\b/i],
  ["green", /绿色|翠绿|墨绿|浅绿|深绿|绿发|绿头发|\b(?:green)\b/i],
  ["cyan", /青色|青绿|湖蓝|\b(?:cyan|teal)\b/i],
  ["blue", /蓝色|深蓝|浅蓝|天蓝|藏蓝|\b(?:blue|navy)\b/i],
  ["purple", /紫色|紫发|紫胡子|\b(?:purple|violet)\b/i],
  ["pink", /粉色|粉红|玫红|\b(?:pink|magenta)\b/i],
  ["black", /黑色|黑发|黑胡子|\b(?:black)\b/i],
  ["white", /白色|白发|白胡子|\b(?:white)\b/i],
  ["gray", /灰色|灰发|灰胡子|\b(?:gray|grey)\b/i],
  ["brown", /棕色|褐色|咖啡色|棕发|棕胡子|\b(?:brown)\b/i]
];

function visualSourceColorFamilies(params) {
  const explicit = Array.isArray(params && params.sourceColorFamilies)
    ? params.sourceColorFamilies.map((value) => String(value || "").toLowerCase()).filter(Boolean)
    : [];
  if (explicit.length) return [...new Set(explicit)];
  const description = String(params && params.description || "")
    .split(/改成|变成|换成|调整为|设为|变为|替换为|recolou?r(?:ed)?\s+(?:to|as)|\bto\b/i)[0];
  return VISUAL_COLOR_FAMILIES
    .filter(([, pattern]) => pattern.test(description))
    .map(([family]) => family);
}

function visualSourceColorHints(params) {
  if (Array.isArray(params && params.sourceColors) && params.sourceColors.length) {
    return params.sourceColors.slice();
  }
  return [];
}

function enforceVisualTargetContract(step, instruction, options = {}) {
  if (!step || step.action !== "selection.visual_object" || !step.params) return step;
  if (typeof protocol.applyAuthoritativeVisualContract === "function") {
    protocol.applyAuthoritativeVisualContract(step.params, instruction, options);
  }
  const contract = step.params.visualContract
    || (typeof protocol.buildUserVisualContract === "function"
      ? protocol.buildUserVisualContract(instruction, step.params.description)
      : null);
  const classification = protocol.classifyVisualTargetInstruction(instruction, step.params.description);
  if (classification.scope !== "unknown") step.params.semanticScope = classification.scope;
  const label = String(contract && contract.target && contract.target.label || classification.label || step.params.description || "目标对象")
    .replace(/（完整对象：[^）]*）/g, "")
    .trim();
  step.params.description = label.slice(0, 240);
  const isWholeObject = step.params.semanticScope === "whole_object";
  const locatorColors = contract && contract.target && Array.isArray(contract.target.sourceColorFamilies)
    ? contract.target.sourceColorFamilies
    : [];
  step.params.colorRefine = !isWholeObject && locatorColors.length ? "source" : "none";
  step.params.sourceColorFamilies = isWholeObject ? [] : [...locatorColors];
  if (isWholeObject) step.params.sourceColors = [];
  step.params.allowColorFallback = false;
  step.params.selectionMode = "semantic";
  if (step.params.targetBox) {
    step.params.positivePoints = (step.params.positivePoints || [])
      .filter((point) => pointInsideVisualBox(point, step.params.targetBox))
      .slice(0, 5);
  }

  const userProtectedParts = Boolean(contract && Array.isArray(contract.protectedRegions) && contract.protectedRegions.length)
    || protocol.hasExplicitVisualSpatialProtection(instruction);
  // Initial planner and semantic-review negative points are not authoritative.
  // Remove them unless the user named a real spatial region/object to protect.
  // User clicks rebuild the candidate with sanitization disabled, so their
  // explicit "exclude" corrections remain intact.
  if (options.sanitizeModelExclusions === true && !userProtectedParts) step.params.excludePoints = [];
  return step;
}

function enforceVisualPlanContracts(plan, instruction, options = {}) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  for (const step of plan.steps) enforceVisualTargetContract(step, instruction, options);
  return plan;
}

function foldSelectionFeatherBeforeLock(plan) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const refinements = new Set([
    "selection.invert",
    "selection.expand",
    "selection.contract",
    "selection.feather",
    "selection.border",
    "selection.grow",
    "selection.smooth"
  ]);
  for (let index = 0; index < plan.steps.length - 1; index += 1) {
    const provider = plan.steps[index];
    if (!SELECTION_PROVIDER_ACTIONS.has(provider.action)) continue;
    while (plan.steps[index + 1] && refinements.has(plan.steps[index + 1].action)) {
      const refinement = plan.steps[index + 1];
      provider.params._preLockSelectionRefinements = [
        ...(provider.params._preLockSelectionRefinements || []),
        { action: refinement.action, params: cloneValue(refinement.params || {}) }
      ];
      provider.requirementIds = [...new Set([...(provider.requirementIds || []), ...(refinement.requirementIds || [])])];
      provider.label = `${provider.label}（含锁定前选区精修）`;
      plan.steps.splice(index + 1, 1);
    }
  }
  return plan;
}

function shouldRefineVisualSourceColor(params, instruction) {
  const classification = protocol.classifyVisualTargetInstruction(instruction, params && params.description);
  const semanticScope = String(params && params.semanticScope || classification.scope || "unknown");
  if (semanticScope === "whole_object" || classification.scope === "whole_object") return false;
  const mode = String(params && params.colorRefine || "auto").toLowerCase();
  if (mode === "none") return false;
  const hasSourceColor = visualSourceColorFamilies(params).length > 0
    || visualSourceColorHints(params).length > 0;
  if (!hasSourceColor) return false;
  if (mode === "source") return true;
  return /仅|只|局部|部分|颜色|色块|头发|发丝|胡子|胡须|眉毛|帽檐|袖口|衣袖|领口|叶子|叶片|花瓣|花纹|图案|斑点|污点|奖杯|皮肤|身体/.test(String(params.description || ""));
}

function pointInsideVisualBox(point, box) {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

function setVisualCandidateMode(mode) {
  runtime.visualCandidateMode = mode;
  runtime.lassoActive = false;
  for (const id of ["lassoReplace", "lassoAdd", "lassoSubtract", "lassoIntersect"]) {
    const button = $(id);
    if (button) button.classList.remove("active");
  }
  for (const [id, value] of [["candidateReplace", "replace"], ["candidateAdd", "add"], ["candidateExclude", "exclude"]]) {
    const button = $(id);
    if (button) button.classList.toggle("active", value === mode);
  }
  const help = $("targetPreviewHelp");
  if (help) {
    help.textContent = mode === "add"
      ? "补选模式：点击漏掉的手臂、花纹或同一对象的其他部件，可连续添加。"
      : mode === "exclude"
        ? "排除模式：点击被误选的邻近人物或背景，可连续添加。"
        : "重新定位模式：点击正确目标，系统会以该点重新生成完整对象蒙版。";
  }
}

async function regenerateVisualCandidate(options = {}) {
  const visual = visualPlanStep();
  if (!visual || runtime.busy) return;
  try {
    setBusy(true, "正在重建候选...");
    runtime.visualConfirmedSteps.delete(visual.index);
    runtime.visualCandidateErrors.delete(visual.index);
    capabilities.releaseSemanticMask(visual.step.params.maskToken);
    delete visual.step.params.maskToken;
    delete visual.step.params.segmentationMode;
    const evidence = await buildSemanticVisualEvidence(visual.step, runtime.snapshot, {
      selectionCapture: {
        corrected: options.corrected === true,
        correctionSource: options.correctionSource || "automatic-candidate"
      }
    });
    runtime.visualEvidence = runtime.visualEvidence.filter((item) => item.stepIndex !== visual.index);
    runtime.visualEvidence.push({ stepIndex: visual.index, ...evidence });
    await snapshotAndRebaseSelection("local-point-correction", visual);
    showResult("候选选区已更新并写入 Photoshop 活动选区。请检查、修正并锁定后再执行。", "muted");
  } catch (error) {
    runtime.visualEvidence = runtime.visualEvidence.filter((item) => item.stepIndex !== visual.index);
    runtime.visualCandidateErrors.set(visual.index, friendlyError(error));
    showResult(`候选选区仍不可靠：${friendlyError(error)}。请改用重新定位、补选或排除模式继续点选。`, "error");
  } finally {
    renderTargetPreview(runtime.plan);
    setBusy(false);
  }
}

async function correctVisualCandidate(event) {
  const visual = visualPlanStep();
  const canvas = $("targetPreviewCanvas");
  if (!visual || !canvas || runtime.busy) return;
  const rect = canvas.getBoundingClientRect();
  const hasClientPoint = Number.isFinite(Number(event.clientX)) && Number.isFinite(Number(event.clientY));
  const localX = hasClientPoint ? Number(event.clientX) - rect.left : Number(event.offsetX);
  const localY = hasClientPoint ? Number(event.clientY) - rect.top : Number(event.offsetY);
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    showResult("没有读取到有效的点选位置，请再点击一次预览图。", "error");
    return;
  }
  const x = Math.max(0, Math.min(100, localX / Math.max(1, rect.width) * 100));
  const y = Math.max(0, Math.min(100, localY / Math.max(1, rect.height) * 100));
  const point = { x, y };
  const params = visualParamsAsPercent(visual.step.params, runtime.snapshot);
  if (runtime.visualCandidateMode === "replace") {
    const targetWidth = Math.max(8, params.targetBox.right - params.targetBox.left);
    const targetHeight = Math.max(8, params.targetBox.bottom - params.targetBox.top);
    params.targetBox = boundedBoxAround(x, y, targetWidth, targetHeight);
    const contextPadding = Math.max(8, Math.min(24, Math.max(targetWidth, targetHeight) * 0.45));
    params.searchRegion = expandBox(params.targetBox, point, contextPadding);
    params.seed = point;
    params.positivePoints = [];
    params.excludePoints = (params.excludePoints || []).filter((excluded) => pointInsideVisualBox(excluded, params.searchRegion));
  } else if (runtime.visualCandidateMode === "add") {
    params.positivePoints = [...(params.positivePoints || []), point].slice(-15);
    params.targetBox = expandBox(params.targetBox, point, 1.5);
    params.searchRegion = expandBox(params.searchRegion, point, 6);
  } else {
    params.excludePoints = [...(params.excludePoints || []), point].slice(-16);
    params.searchRegion = expandBox(params.searchRegion, point, 4);
  }
  params.requiresHumanConfirmation = true;
  visual.step.params = protocol.normalizeIntent({
    operations: [{
      action: "selection.visual_object",
      target: { scope: "document" },
      params,
      requirementIds: Array.isArray(visual.step.requirementIds) && visual.step.requirementIds.length
        ? visual.step.requirementIds
        : ["interactive_selection_correction"]
    }]
  }).operations[0].params;
  await regenerateVisualCandidate({ corrected: true, correctionSource: `point-${runtime.visualCandidateMode}` });
}

async function resetVisualCandidate() {
  const visual = selectionPlanStep();
  const original = visual && runtime.visualOriginalParams.get(visual.index);
  if (!visual || !original) return;
  runtime.visualConfirmedSteps.delete(visual.index);
  visual.step.params = cloneValue(original);
  setVisualCandidateMode("replace");
  if (visual.step.action === "selection.visual_object") {
    await regenerateVisualCandidate();
  } else {
    try {
      setBusy(true, "正在恢复自动候选...");
      await materializeSelectionCandidate(visual.step, visual.index);
      await snapshotAndRebaseSelection("reset-automatic-selection-candidate", visual);
      renderTargetPreview(runtime.plan);
    } catch (error) {
      showResult(`无法恢复自动候选：${friendlyError(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }
}

async function confirmVisualCandidate() {
  const item = selectionPlanStep();
  if (!item || !item.step.params.selectionSessionToken) {
    return showResult("还没有可执行的候选选区。请先建立或采用 Photoshop 当前选区。", "error");
  }
  let session = selectionSessions.describe(item.step.params.selectionSessionToken);
  const policy = runtime.selectionConfidenceByStep.get(item.index)
    || confidencePolicy.classify(0, { hasCandidate: Boolean(session) });
  const acceptBox = $("acceptLowConfidence");
  if (policy.explicitAcceptRequired && acceptBox && acceptBox.checked) {
    session = selectionSessions.setLowConfidenceAccepted(session.token, true);
  }
  if (!confidencePolicy.mayConfirm(policy, session)) {
    return showResult("这是低置信度候选。请先用点选、套索或 Photoshop 原生工具修正，或明确勾选接受当前候选。", "error");
  }
  try {
    setBusy(true, "正在锁定选区...");
    await activateSelectionStep(item, { rebase: true });
    runtime.visualConfirmedSteps.add(item.index);
    const rebasedStep = runtime.plan.steps[item.index];
    if (rebasedStep.params.maskToken) capabilities.releaseSemanticMask(rebasedStep.params.maskToken);
    delete rebasedStep.params.maskToken;
    delete rebasedStep.params.segmentationMode;
    const remaining = selectionPlanSteps().filter((candidate) => !runtime.visualConfirmedSteps.has(candidate.index));
    if (remaining.length) await activateSelectionStep(remaining[0], { rebase: true });
    const button = $("executePlan");
    if (button) button.disabled = planNeedsVisualConfirmation();
    renderTargetPreview(runtime.plan);
    showResult(remaining.length
      ? `当前权威选区已锁定。还需检查并确认 ${remaining.length} 个选区。`
      : "全部权威选区已锁定。执行时会恢复这些已锁定选区，不会再用 MobileSAM 或自动选择覆盖。", "muted");
  } catch (error) {
    showResult(`无法锁定当前选区：${friendlyError(error)}`, "error");
  } finally {
    runtime.documentSignature = documentSignature();
    setBusy(false);
  }
}

async function adoptCurrentPhotoshopSelection() {
  const item = selectionPlanStep();
  if (!item || runtime.busy) return;
  try {
    setBusy(true, "正在采用选区...");
    runtime.visualConfirmedSteps.delete(item.index);
    const before = runtime.snapshot;
    const session = await core.executeAsModal(
      async () => captureAuthoritativeSelection(item.step, item.index, {}, {
        corrected: true,
        correctionSource: "photoshop-native-tools"
      }),
      { commandName: "v9.8 采用 Photoshop 当前选区", timeOut: 8 }
    );
    const after = await core.executeAsModal(async () => stateEngine.snapshot(), { commandName: "v9.8 回读当前选区", timeOut: 5 });
    if (typeof engine.rebasePlanAfterSelection === "function") {
      runtime.plan = engine.rebasePlanAfterSelection(runtime.plan, before, after, {
        source: "photoshop-current-selection",
        sessionId: session.token,
        selectionDigest: after.selectionDigest
      });
    } else {
      runtime.plan.sourceFingerprint = after.fingerprint;
    }
    after.palette = runtime.palette;
    runtime.snapshot = after;
    const evidence = runtime.visualEvidence.find((value) => value.stepIndex === item.index);
    if (evidence) evidence.selectionBounds = session.selectionBounds;
    showResult("已采用 Photoshop 当前活动选区。请再次确认该选区后才能执行。", "muted");
    renderTargetPreview(runtime.plan);
  } catch (error) {
    showResult(`无法采用当前选区：${friendlyError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function showNativeSelectionHandoff() {
  showResult("请直接在 Photoshop 画布中使用对象选择、快速选择或套索工具做加选/减选。完成后回到本面板，点击“采用 Photoshop 当前选区”。Adobe 没有提供稳定公开接口让插件静默触发对象选择，因此这里不会伪装成全自动。", "muted");
}

function setLassoMode(mode) {
  runtime.lassoMode = mode;
  runtime.lassoActive = true;
  for (const id of ["candidateReplace", "candidateAdd", "candidateExclude"]) {
    const button = $(id);
    if (button) button.classList.remove("active");
  }
  for (const [id, value] of [["lassoReplace", "replace"], ["lassoAdd", "add"], ["lassoSubtract", "subtract"], ["lassoIntersect", "intersect"]]) {
    const button = $(id);
    if (button) button.classList.toggle("active", value === mode);
  }
  showResult(`面板自由套索已启用（${{ replace: "替换", add: "加选", subtract: "减选", intersect: "交集" }[mode]}）。在预览图上按住鼠标绘制封闭轨迹。`, "muted");
}

function lassoEventPoint(event) {
  const canvas = $("targetPreviewCanvas");
  const rect = canvas && canvas.getBoundingClientRect();
  if (!rect) return null;
  const clientX = Number(event.clientX);
  const clientY = Number(event.clientY);
  const x = Number.isFinite(clientX) ? clientX - rect.left : Number(event.offsetX);
  const y = Number.isFinite(clientY) ? clientY - rect.top : Number(event.offsetY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(rect.width, x)),
    y: Math.max(0, Math.min(rect.height, y)),
    documentX: Math.max(0, Math.min(runtime.snapshot.document.width, x / Math.max(1, rect.width) * runtime.snapshot.document.width)),
    documentY: Math.max(0, Math.min(runtime.snapshot.document.height, y / Math.max(1, rect.height) * runtime.snapshot.document.height))
  };
}

function renderLassoPath() {
  const path = $("selectionLassoPath");
  if (!path) return;
  path.setAttribute("d", runtime.lassoPoints.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" "));
}

function beginLasso(event) {
  if (!runtime.lassoActive || runtime.busy || !selectionPlanStep()) return;
  const point = lassoEventPoint(event);
  if (!point) return;
  const overlay = $("selectionLassoOverlay");
  const canvasRect = $("targetPreviewCanvas").getBoundingClientRect();
  if (overlay) overlay.setAttribute("viewBox", `0 0 ${Math.max(1, canvasRect.width)} ${Math.max(1, canvasRect.height)}`);
  runtime.lassoDrawing = true;
  runtime.lassoPoints = [point];
  renderLassoPath();
  if (event.preventDefault) event.preventDefault();
}

function continueLasso(event) {
  if (!runtime.lassoDrawing) return;
  const point = lassoEventPoint(event);
  const previous = runtime.lassoPoints[runtime.lassoPoints.length - 1];
  if (!point || (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2)) return;
  runtime.lassoPoints.push(point);
  renderLassoPath();
}

async function finishLasso() {
  if (!runtime.lassoDrawing) return;
  runtime.lassoDrawing = false;
  const points = runtime.lassoPoints.slice();
  runtime.lassoPoints = [];
  renderLassoPath();
  const item = selectionPlanStep();
  if (!item || points.length < 3) return showResult("套索轨迹太短，请至少围出一个区域。", "error");
  try {
    setBusy(true, "正在应用套索...");
    runtime.visualConfirmedSteps.delete(item.index);
    const session = await core.executeAsModal(
      async () => selectionSessions.applyPolygon(
        item.step.params.selectionSessionToken,
        points.map((point) => ({ x: point.documentX, y: point.documentY })),
        runtime.lassoMode
      ),
      { commandName: `v9.8 自由套索${runtime.lassoMode}`, timeOut: 10 }
    );
    item.step.params.selectionSessionToken = session.token;
    runtime.selectionSessionsByStep.set(item.index, session.token);
    const previousPolicy = runtime.selectionConfidenceByStep.get(item.index);
    runtime.selectionConfidenceByStep.set(
      item.index,
      confidencePolicy.classify(previousPolicy ? previousPolicy.confidence : 0, { hasCandidate: true })
    );
    const evidence = runtime.visualEvidence.find((value) => value.stepIndex === item.index);
    if (evidence) evidence.selectionBounds = session.selectionBounds;
    await snapshotAndRebaseSelection(`panel-lasso:${runtime.lassoMode}`, item);
    showResult("套索修正已写入。请再次确认当前选区后才能执行。", "muted");
    renderTargetPreview(runtime.plan);
  } catch (error) {
    showResult(`套索修正失败：${friendlyError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function acceptLowConfidenceChanged(event) {
  const item = selectionPlanStep();
  if (!item || !item.step.params.selectionSessionToken) return;
  selectionSessions.setLowConfidenceAccepted(item.step.params.selectionSessionToken, Boolean(event.target && event.target.checked));
  renderTargetPreview(runtime.plan);
}

function confirmHighRiskPlan(event) {
  if (!runtime.plan) return;
  runtime.highRiskConfirmed = Boolean(event.target && event.target.checked);
  runtime.plan.confirmedHighRiskStepIds = runtime.highRiskConfirmed
    ? Array.from(runtime.plan.highRiskStepIds || [])
    : [];
  const execute = $("executePlan");
  if (execute) execute.disabled = planNeedsVisualConfirmation();
}

async function buildSemanticVisualEvidence(step, snapshot, options = {}) {
  const requestEpoch = ++runtime.visualRequestEpoch;
  await ensureVisualRuntimeReady();
  enforceVisualTargetContract(step, runtime.activeInstruction, { sanitizeModelExclusions: false });
  if (!runtime.currentPreview) {
    runtime.currentPreview = await core.executeAsModal(
      async () => captureComposite(PREVIEW_HEIGHT),
      { commandName: "v9.8读取语义分割画面", timeOut: 5 }
    );
  }
  const segmentationCrop = await core.executeAsModal(
    async () => captureSegmentationSearchCrop(step.params, snapshot),
    { commandName: "v9.8 读取高分辨率对象搜索区域", timeOut: 12 }
  );
  const useSourceColor = shouldRefineVisualSourceColor(step.params, runtime.activeInstruction);
  step.params.colorRefine = useSourceColor ? "source" : "none";
  const positivePoints = [
    normalizedCropPoint(step.params.seed, step.params, snapshot, segmentationCrop.sourceBounds),
    ...(step.params.positivePoints || []).map((point) => normalizedCropPoint(point, step.params, snapshot, segmentationCrop.sourceBounds))
  ].slice(0, 16);
  const negativePoints = (step.params.excludePoints || [])
    .map((point) => normalizedCropPoint(point, step.params, snapshot, segmentationCrop.sourceBounds))
    .slice(0, 16);
  let result;
  try {
    result = await fetchJson(`${PROXY_URL}/segment-v9.8`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: segmentationCrop.base64,
        sourceCrop: segmentationCrop.sourceCrop,
        box: normalizedCropBox(step.params.targetBox, step.params, snapshot, segmentationCrop.sourceBounds),
        clipBox: [0, 0, 1, 1],
        positivePoints,
        negativePoints,
        colorRefine: useSourceColor ? "source" : "none",
        colorFamilies: useSourceColor ? visualSourceColorFamilies(step.params) : [],
        colorHints: useSourceColor ? visualSourceColorHints(step.params) : [],
        colorTolerance: Number(step.params.tolerance || 52),
        targetWidth: snapshot.document.width,
        targetHeight: snapshot.document.height,
        semanticScope: String(step.params.semanticScope || "unknown")
      })
    }, 180000);
  } catch (error) {
    if (isNetworkTransportError(error)) {
      throw localServiceError(
        "LOCAL_SEGMENTATION_DISCONNECTED",
        "本地对象选区服务在生成蒙版时断开。模型已经完成定位，但没有再次请求模型；请启动本地服务后直接在预览图上点选目标。",
        error
      );
    }
    throw error;
  }
  assertVisualRequestCurrent(requestEpoch);
  const evidence = await capabilities.registerSemanticMask(result, step.params, snapshot);
  try {
    assertVisualRequestCurrent(requestEpoch);
  } catch (error) {
    capabilities.releaseSemanticMask(evidence && evidence.maskToken);
    throw error;
  }
  step.params.maskToken = evidence.maskToken;
  step.params.segmentationMode = "semantic";
  const stepIndex = runtime.plan && Array.isArray(runtime.plan.steps) ? runtime.plan.steps.indexOf(step) : -1;
  if (stepIndex >= 0) {
    const materialized = await materializeSelectionCandidate(step, stepIndex, options.selectionCapture || {});
    evidence.selectionBounds = materialized.session.selectionBounds;
    evidence.authoritativeSelectionDigest = materialized.session.digest;
    runtime.selectionConfidenceByStep.set(
      stepIndex,
      confidencePolicy.classify(candidateConfidence(step, evidence), { hasCandidate: true })
    );
  }
  return evidence;
}

async function probeVisualTargets(plan, snapshot, options = {}) {
  runtime.visualEvidence = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (step.action !== "selection.visual_object") continue;
    let evidence;
    try {
      evidence = await buildSemanticVisualEvidence(step, snapshot);
    } catch (error) {
      if (step.params.allowColorFallback !== true) {
        if (options.allowUnresolved === true) {
          runtime.visualCandidateErrors.set(index, friendlyError(error));
          continue;
        }
        throw new Error(`“${step.params.description}”没有生成可靠的语义对象蒙版：${friendlyError(error)}。为避免整块误改，没有用矩形或颜色连通域冒充对象。`);
      }
      try {
        evidence = await core.executeAsModal(
          async () => capabilities.probeVisualObject({ ...step.params, selectionMode: "seeded" }, snapshot),
          { commandName: `v9.8颜色兜底复核：${step.params.description}`, timeOut: 10 }
        );
        step.params.segmentationMode = "color_fallback";
        evidence.segmentationMode = "color_fallback";
      } catch (fallbackError) {
        const message = `语义蒙版失败：${friendlyError(error)}；颜色兜底失败：${friendlyError(fallbackError)}`;
        if (options.allowUnresolved === true) {
          runtime.visualCandidateErrors.set(index, message);
          continue;
        }
        throw new Error(`“${step.params.description}”没有生成可靠对象选区：${message}`);
      }
    }
    if (!step.params.selectionSessionToken) {
      try {
        const materialized = await materializeSelectionCandidate(step, index);
        evidence.selectionBounds = materialized.session.selectionBounds;
      } catch (error) {
        runtime.visualCandidateErrors.set(index, friendlyError(error));
        continue;
      }
    }
    runtime.visualCandidateErrors.delete(index);
    runtime.visualEvidence.push({ stepIndex: index, ...evidence });
  }
}

function parseModelObject(raw, label) {
  try {
    const value = protocol.parseJsonValue(String(raw));
    if (!value || typeof value !== "object") throw new Error("不是对象");
    return value;
  } catch (_) {
    throw new Error(`${label}没有返回有效JSON。`);
  }
}

async function verifyVisualTargetSemantics(step, stepIndex, snapshot, instruction, visualContext) {
  const captures = await core.executeAsModal(async () => {
    if (step.params.selectionSessionToken) await selectionSessions.restore(step.params.selectionSessionToken);
    return {
      crop: await captureVisualTargetCrop(step.params, snapshot),
      overlay: await captureSelectionSearchOverlay(step.params, snapshot)
    };
  }, { commandName: `v9.8 模型复核搜索区域：${step.params.description}`, timeOut: 15 });
  const crop = captures.crop;
  const evidence = [
    { ...crop, label: `候选“${step.params.description}”的完整搜索区域` },
    { ...captures.overlay, label: "同一搜索区域的 Photoshop 实际选区叠加图（绿色会被修改）" }
  ];
  const settings = currentFormSettings();
  const provider = modelProviders.getProvider(settings.providerId);
  const verifierModelId = provider.verificationModel
    && modelProviders.findModel(provider.id, provider.verificationModel)
    ? provider.verificationModel
    : settings.modelId;
  const verificationOverview = await core.executeAsModal(
    async () => captureComposite(720),
    { commandName: "v9.8读取轻量验收画面", timeOut: 5 }
  );
  const raw = await modelCaller({
    system: [
      "你是Photoshop局部目标定位和实际选区蒙版的模型复核器，只返回严格JSON。你可能与规划模型相同，因此你的判断只是辅助证据，不是独立真值。",
      "第1张图是完整画面，第2张图是候选的完整搜索区域，第3张图是与第2张完全对齐的 Photoshop 实际选区叠加图，绿色区域会被修改。必须同时检查搜索区域内的漏选与目标外泄漏。",
      "不要相信候选自己填写的confidence，也不能只因为颜色相同就判定正确。",
      "candidate.visualContract是从用户原话生成的权威合同：target是唯一修改目标，protectedRegions是空间上不能修改的区域，preserveAppearance是仍须选入但后续保持的外观属性。不得自行增加、删除或交换这些角色。",
      "只有同时满足以下条件才能match=true：visualContract.target指向的对象确实出现在targetBox内；seed落在该对象本身而非同色的其他区域；targetBox紧密包住完整目标且没有错包其他对象；searchRegion包含足够上下文；实际白色蒙版覆盖用户要求修改的全部部件和必要的深浅纹理，同时没有覆盖protectedRegions。",
      "目标可以是人物、商品、奖杯、文字、配饰、色块或任意局部。完整对象必须覆盖全部可见部分、内部花纹、明暗和分离部件；局部对象只覆盖描述指定的部分。",
      "高光、阴影、明暗、纹理、质感、立体感、褶皱和光泽都属于目标内部外观；用户要求保留这些外观时仍必须把对应像素选入，绝不能为它们输出excludePoints。外观保真由后续调整或混合模式完成。",
      "遮挡物属于另一个对象时必须排除，例如手搭在奖杯前面时：保留奖杯全部可见像素，但不能把手选入，也不能虚构被手遮住的奖杯像素。",
      "漏选明显部件或误选邻近对象时必须match=false。corrected中用positivePoints补漏选，用excludePoints点在实际误选且不属于target的对象内部；不能把preserveAppearance对应的像素作为排除点，也不能用颜色列表代替对象理解。",
      "返回JSON：{\"match\":true|false,\"confidence\":0..1,\"reason\":\"中文原因\",\"corrected\":null或{\"targetBox\":{\"left\":0..100,\"top\":0..100,\"right\":0..100,\"bottom\":0..100},\"searchRegion\":{\"left\":0..100,\"top\":0..100,\"right\":0..100,\"bottom\":0..100},\"seed\":{\"x\":0..100,\"y\":0..100},\"positivePoints\":[{\"x\":0..100,\"y\":0..100}],\"excludePoints\":[{\"x\":0..100,\"y\":0..100}]}}。完整对象的corrected必须给出覆盖不同可见部件的positivePoints；局部零件可为空数组。",
      "若不匹配但能可靠定位，match=false并返回完整corrected；若仍无法消歧，corrected=null。所有坐标基于第1张完整画面，使用0到100。"
    ].join("\n"),
    user: JSON.stringify({
      instruction,
      candidate: step.params,
      cropSourceBounds: crop.sourceBounds,
      document: {
        width: snapshot.document.width,
        height: snapshot.document.height
      }
    })
  }, {
    current: verificationOverview,
    evidence,
    ...(visualContext && visualContext.reference ? { reference: visualContext.reference } : {})
  }, {
    modelId: verifierModelId,
    maxTokens: 500,
    stage: "visual_mask_verification",
    requestKey: `visual:${stepIndex}`,
    purpose: `验收并必要时修正对象蒙版：${step.params.description}`
  });
  const result = parseModelObject(raw, "视觉语义复核");
  result.match = result.match === true;
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  result.reason = String(result.reason || "").trim();
  return result;
}

function correctedVisualParams(step, verification) {
  if (!verification.corrected || typeof verification.corrected !== "object") {
    throw new Error(`视觉语义复核没有确认“${step.params.description}”：${verification.reason || "无法可靠定位目标"}`);
  }
  const corrected = {
    ...step.params,
    ...verification.corrected,
    unit: "percent",
    confidence: verification.confidence
  };
  delete corrected.maskToken;
  delete corrected.segmentationMode;
  const normalized = protocol.normalizeIntent({
    operations: [{
      action: "selection.visual_object",
      target: { scope: "document" },
      params: corrected,
      requirementIds: Array.isArray(step.requirementIds) && step.requirementIds.length
        ? step.requirementIds
        : ["visual_verifier_correction"]
    }]
  });
  const correctedStep = normalized.operations[0];
  enforceVisualTargetContract(correctedStep, runtime.activeInstruction, { sanitizeModelExclusions: false });
  return correctedStep.params;
}

function recordVisualSemanticWarning(index, message) {
  const evidence = runtime.visualEvidence.find((item) => item.stepIndex === index);
  if (!evidence) return;
  evidence.semanticVerified = false;
  evidence.semanticConfidence = 0;
  evidence.semanticReason = message;
  evidence.qualityWarnings = [...new Set([...(evidence.qualityWarnings || []), message])];
  evidence.requiresHumanConfirmation = true;
  runtime.selectionConfidenceByStep.set(index, confidencePolicy.classify(0.35, { hasCandidate: true }));
}

async function verifyVisualTargetsSemantically(plan, snapshot, instruction, visualContext, options = {}) {
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (step.action !== "selection.visual_object") continue;
    if (!step.params.maskToken) {
      recordVisualSemanticWarning(index, "尚未生成语义对象蒙版，请在预览图上重新定位目标");
      continue;
    }
    try {
      let verification = await verifyVisualTargetSemantics(step, index, snapshot, instruction, visualContext);
      if ((!verification.match || verification.confidence < 0.72) && verification.corrected) {
        showResult(`“${step.params.description}”的语义位置与像素落点不一致，正在自动纠正一次。`, "muted");
        capabilities.releaseSemanticMask(step.params.maskToken);
        step.params = correctedVisualParams(step, verification);
        const evidence = await buildSemanticVisualEvidence(step, snapshot);
        runtime.visualEvidence = runtime.visualEvidence.filter((item) => item.stepIndex !== index);
        runtime.visualEvidence.push({ stepIndex: index, ...evidence });
        verification = await verifyVisualTargetSemantics(step, index, snapshot, instruction, visualContext);
      }
      if (!verification.match || verification.confidence < 0.72) {
        const message = `视觉语义复核未确认“${step.params.description}”：${verification.reason || "目标与坐标不一致"}`;
        if (options.allowHumanReview !== true) throw new Error(message);
        runtime.visualCandidateErrors.set(index, message);
        recordVisualSemanticWarning(index, message);
        continue;
      }
      const evidence = runtime.visualEvidence.find((item) => item.stepIndex === index);
      if (evidence) {
        evidence.semanticVerified = true;
        evidence.semanticConfidence = verification.confidence;
        evidence.semanticReason = verification.reason;
        const combined = Math.max(0, Math.min(1,
          candidateConfidence(step, evidence) * 0.75 + verification.confidence * 0.25
        ));
        runtime.selectionConfidenceByStep.set(index, confidencePolicy.classify(combined, { hasCandidate: true }));
      }
    } catch (error) {
      if (options.allowHumanReview !== true) throw error;
      const message = `视觉语义复核暂未通过：${friendlyError(error)}`;
      runtime.visualCandidateErrors.set(index, message);
      recordVisualSemanticWarning(index, message);
    }
  }
}

function isReadOnlyInspection(instruction) {
  const asksForState = /(有什么|有哪些|多少|分析|查看|识别|列出|告诉我|帮我看).*(颜色|色彩|图层|蒙版|文字|字体|尺寸|大小|比例|分辨率|文件结构)|^(颜色|色彩|图层|蒙版|文字|字体|尺寸|比例|分辨率)/.test(instruction);
  const asksForVisualContent = /(图中|画面|图片|当前图(?!层)).*(有什么|是什么|内容|人物|对象|物体|主体|构图)/.test(instruction);
  const asksToModify = engine.isModificationInstruction(instruction);
  return (asksForState || asksForVisualContent) && !asksToModify;
}

function buildInspectionAnswer(instruction, snapshot) {
  const sections = [];
  if (/(颜色|色彩)/.test(instruction)) {
    const asksForAllColors = /(所有|全部|完整|小颜色|低占比|详细)/.test(instruction);
    const colors = asksForAllColors ? runtime.fullPalette : runtime.palette;
    sections.push(colors.length
      ? `${asksForAllColors ? "完整色谱" : "主要颜色"}：${colors.map((color) => `${color.name}${color.hex}（约${formatPalettePercent(color.percent)}%）`).join("、")}`
      : "没有读取到可见颜色。");
  }
  if (/(尺寸|大小|比例|分辨率|文件)/.test(instruction)) {
    const doc = snapshot.document;
    sections.push(`文档：${doc.title}，${Math.round(doc.width)}×${Math.round(doc.height)}像素，${doc.resolution}ppi，比例${formatRatio(doc.aspectRatio)}，${doc.mode}。`);
  }
  if (/(图层|结构)/.test(instruction)) {
    sections.push(`图层：共${snapshot.metrics.layers}个，其中${snapshot.metrics.groups}个组、${snapshot.metrics.textLayers}个文字层、${snapshot.metrics.hiddenLayers}个隐藏层。\n${snapshot.flatLayers.slice(0, 40).map((layer) => `${"  ".repeat(layer.depth)}- ${layer.name}（${layer.kind}）`).join("\n")}${snapshot.flatLayers.length > 40 ? `\n…还有${snapshot.flatLayers.length - 40}个图层` : ""}`);
  }
  if (/(蒙版)/.test(instruction)) {
    const masks = snapshot.flatLayers.filter((layer) => layer.hasLayerMask || layer.hasVectorMask || layer.clippingMask);
    sections.push(masks.length
      ? `蒙版：${masks.map((layer) => `${layer.name}（${[layer.hasLayerMask ? "像素蒙版" : "", layer.hasVectorMask ? "矢量蒙版" : "", layer.clippingMask ? "剪贴蒙版" : ""].filter(Boolean).join("、")}）`).join("、")}`
      : "当前文档没有图层蒙版、矢量蒙版或剪贴蒙版。");
  }
  if (/(文字|字体)/.test(instruction)) {
    const texts = snapshot.flatLayers.filter((layer) => layer.text);
    sections.push(texts.length
      ? `文字层：${texts.map((layer) => `「${String(layer.text.contents).replace(/\s+/g, " ").slice(0, 50)}」/ ${layer.text.font || "字体未知"} / ${layer.text.uiSizePoints || layer.text.size || "字号未知"}`).join("；")}`
      : "当前文档没有可编辑文字层。");
  }
  if (!sections.length) sections.push("已读取当前文档。主要颜色、图层、蒙版和文字信息显示在上方“查看当前文件结构”中。");
  return sections.join("\n\n");
}

async function answerInspection(instruction, snapshot) {
  const localAnswer = buildInspectionAnswer(instruction, snapshot);
  if (!/(图中|画面|图片|当前图(?!层)).*(内容|人物|对象|物体|主体|构图|有什么)/.test(instruction)) return localAnswer;
  const raw = await modelCaller({
    system: [
      "你是Photoshop文件只读分析助手。",
      "只回答当前画面里可见的内容、对象、构图和颜色，不生成操作，不修改文档。",
      "输出严格JSON：{\"answer\":\"简洁、明确的中文回答\"}。",
      `本地已经读取的文档信息：${JSON.stringify(stateEngine.compactForModel(snapshot))}`
    ].join("\n"),
    user: instruction
  }, {}, {
    stage: "inspection",
    requestKey: "inspection",
    purpose: "只读分析当前Photoshop画面"
  });
  let parsed;
  try { parsed = protocol.parseJsonValue(raw); } catch (_) { parsed = null; }
  const visualAnswer = parsed && parsed.answer ? String(parsed.answer) : "";
  return [visualAnswer, localAnswer].filter(Boolean).join("\n\n");
}

async function analyzeInstruction() {
  if (runtime.busy) return;
  const instruction = $("instruction").value.trim();
  if (!instruction) return showResult("请先输入你想完成的Photoshop操作。", "error");
  try {
    runtime.visualRequestEpoch += 1;
    runtime.activeInstruction = instruction;
    runtime.analysisRunId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    runtime.modelRequestTrace = [];
    runtime.cancelRequested = false;
    setBusy(true, "正在分析...");
    await restorePrePlanSelection();
    releaseVisualPlanMasks(runtime.plan);
    runtime.plan = null;
    $("planSection").classList.add("hidden");
    showResult("正在读取最新PSD状态并选择受控能力。", "muted");
    const snapshot = await refreshState({ forceInsights: false });
    if (!snapshot.hasDocument) throw new Error("请先打开一个Photoshop文档。");
    if (isReadOnlyInspection(instruction)) {
      const answer = await answerInspection(instruction, snapshot);
      showResult(answer, "success");
      showDetails({ stage: "只读文件分析", palette: runtime.palette, document: snapshot.document, metrics: snapshot.metrics, layers: snapshot.flatLayers });
      appendLog({ stage: "inspection_answered", instruction });
      return;
    }
    runtime.currentPreview = null;
    runtime.visualEvidence = [];
    runtime.visualConfirmedSteps = new Set();
    runtime.visualCandidateErrors = new Map();
    runtime.visualOriginalParams = new Map();
    runtime.selectionSessionsByStep = new Map();
    runtime.selectionConfidenceByStep = new Map();
    runtime.highRiskConfirmed = false;
    setVisualCandidateMode("replace");
    capabilities.clearSemanticMasks();
    const requiresVisual = engine.requiresVisualGrounding(instruction);
    if (requiresVisual) {
      showResult("正在读取画面并生成受控计划；只有计划实际使用外部分割时才会检查 MobileSAM。", "muted");
    }
    let visualContext = requiresVisual || runtime.reference
      ? { ...(runtime.reference ? { reference: runtime.reference } : {}) }
      : null;
    if (runtime.reference && instructionUsesReferenceCoordinates(instruction)) {
      runtime.currentPreview = runtime.currentPreview || await core.executeAsModal(
        async () => captureComposite(PREVIEW_HEIGHT),
        { commandName: "v9.8 校验批注对应画面", timeOut: 8 }
      );
      const referenceVerification = await validateReferenceCorrespondence(instruction, runtime.currentPreview);
      visualContext = { ...(visualContext || {}), current: runtime.currentPreview, referenceVerification };
    }
    const understood = await engine.understand(
      instruction,
      snapshot,
      (payload) => modelCaller(payload, visualContext, {
        stage: "planning",
        requestKey: "planning",
        purpose: "理解用户指令并生成受控Photoshop计划"
      }),
      { forceModel: requiresVisual || Boolean(runtime.reference) }
    );
    runtime.plan = engine.compilePlan(understood, snapshot);
    foldSelectionFeatherBeforeLock(runtime.plan);
    enforceVisualPlanContracts(runtime.plan, instruction, { sanitizeModelExclusions: true });
    if (selectionPlanSteps().length) await savePrePlanSelection();
    if (selectionPlanSteps().length && !runtime.currentPreview) {
      runtime.currentPreview = await core.executeAsModal(
        async () => captureComposite(PREVIEW_HEIGHT),
        { commandName: "v9.8 读取选区候选预览", timeOut: 8 }
      );
    }
    await probeVisualTargets(runtime.plan, snapshot, { allowUnresolved: true });
    await probeNonVisualSelectionCandidates(runtime.plan);
    await verifyVisualTargetsSemantically(runtime.plan, snapshot, instruction, visualContext, { allowHumanReview: true });
    applyAutomaticSelectionConfirmationPolicy();
    for (const visual of selectionPlanSteps()) {
      runtime.visualOriginalParams.set(visual.index, cloneValue(visual.step.params));
    }
    const visual = selectionPlanStep();
    if (visual && visual.step.params.selectionSessionToken) await activateSelectionStep(visual);
    const executionBaseline = await core.executeAsModal(
      async () => stateEngine.snapshot(),
      { commandName: "v9.8锁定执行基线", timeOut: 5 }
    );
    if (!executionBaseline.hasDocument || executionBaseline.document.id !== runtime.plan.sourceDocumentId) {
      throw new Error("分析期间当前文档已切换，请重新分析。");
    }
    if (typeof engine.rebasePlanAfterSelection === "function" && visual && visual.step.params.selectionSessionToken) {
      const session = selectionSessions.describe(visual.step.params.selectionSessionToken);
      runtime.plan = engine.rebasePlanAfterSelection(runtime.plan, snapshot, executionBaseline, {
        source: "automatic-selection-candidate",
        sessionId: session && session.token,
        selectionDigest: executionBaseline.selectionDigest
      });
    } else {
      const requirements = stateEvidenceRequirements(runtime.plan);
      const beforeEvidence = typeof stateEngine.buildEvidenceFingerprint === "function"
        ? stateEngine.buildEvidenceFingerprint(snapshot, requirements)
        : snapshot.fingerprint;
      const afterEvidence = typeof stateEngine.buildEvidenceFingerprint === "function"
        ? stateEngine.buildEvidenceFingerprint(executionBaseline, requirements)
        : executionBaseline.fingerprint;
      if (beforeEvidence !== afterEvidence) {
        throw new Error("分析期间本次操作依赖的 PSD 状态发生变化，为避免改错对象，请重新分析。");
      }
    }
    executionBaseline.palette = runtime.palette;
    runtime.snapshot = executionBaseline;
    runtime.plan.sourceFingerprint = executionBaseline.fingerprint;
    runtime.plan.sourceEvidenceRequirements = stateEvidenceRequirements(runtime.plan);
    if (typeof stateEngine.buildEvidenceFingerprint === "function") {
      runtime.plan.sourceEvidenceFingerprint = stateEngine.buildEvidenceFingerprint(
        executionBaseline,
        runtime.plan.sourceEvidenceRequirements
      );
    }
    renderPlan(runtime.plan);
    const modelRequests = currentModelRequestSummary();
    showResult(visual
      ? Boolean(visual.step.params.selectionSessionToken)
        ? `候选选区已写入 Photoshop。本次向模型厂家发送${modelRequests.attempts}次请求；后续点选和套索修正只使用本地选区能力。请检查活动选区后确认。`
        : `系统没有生成可执行候选：${runtime.visualCandidateErrors.get(visual.index) || "请使用 Photoshop 原生工具或面板套索建立选区"}。你仍可建立选区后点“采用 Photoshop 当前选区”。`
      : `操作方案已生成。本次向模型厂家发送${modelRequests.attempts}次请求，请确认后执行。`, runtime.visualEvidence.length || !visual ? "muted" : "error");
    showDetails({ stage: "计划完成", sourceFingerprint: snapshot.fingerprint, modelRequests, plan: runtime.plan });
    appendLog({ stage: "planned", instruction, route: runtime.plan.route, steps: runtime.plan.steps });
  } catch (error) {
    showResult(`没有执行修改：${friendlyError(error)}`, "error");
    showDetails({ stage: "规划失败", error: String(error.stack || error) });
    appendLog({ stage: "plan_failed", instruction, error: String(error.message || error) });
    releaseVisualPlanMasks(runtime.plan);
    runtime.plan = null;
    runtime.visualEvidence = [];
    runtime.visualConfirmedSteps = new Set();
    runtime.visualCandidateErrors = new Map();
    try { await restorePrePlanSelection(); } catch (_) {}
  } finally {
    setBusy(false);
  }
}

async function executePlan() {
  if (!runtime.plan || runtime.busy) return;
  if (planNeedsVisualConfirmation()) {
    return showResult("请先逐个锁定权威选区，并单独确认所有高风险操作。选区可用点选、面板套索或 Photoshop 原生工具修正。", "error");
  }
  // Freeze the exact approved payload before the first await. UI cancellation or
  // candidate refresh must never swap/null the plan between the baseline check
  // and engine execution.
  const executionPlan = cloneValue(runtime.plan);
  if (runtime.prePlanSelection) {
    executionPlan.restoreSelectionHadSelection = runtime.prePlanSelection.hadSelection === true;
    executionPlan.restoreSelectionSessionToken = runtime.prePlanSelection.token || null;
    executionPlan.restoreSelectionDocumentId = Number(runtime.prePlanSelection.documentID);
  }
  try {
    setBusy(true);
    if (runtime.refreshPromise) await runtime.refreshPromise;
    showResult("正在稳定回读已确认的严格基线，随后立即执行。", "muted");
    const executionBaseline = await readStableStrictSnapshot("pre_execute_baseline", executionPlan);
    engine.assertSafeSelectionRestoreBaseline(executionPlan, executionBaseline);
    runtime.snapshot = executionBaseline;
    runtime.documentSignature = documentSignature();
    showResult("选区严格基线已锁定，正在执行并回读验收；证据不足会明确降级，不会当作完整证明。", "muted");
    const outcome = await engine.execute(executionPlan, { executionBaseline });
    runtime.undoPoint = outcome.undoPoint;
    $("undoLast").disabled = !runtime.undoPoint;
    $("planSection").classList.add("hidden");
    const checks = outcome.records.map((record) => `• ${record.verification}`);
    const protectedEvidence = outcome.protectedEvidence || {};
    const protectionSummary = protectedEvidenceSummary(outcome);
    showResult(`执行流程完成，${outcome.records.length} 项步骤回读通过。\n${checks.join("\n")}\n• ${protectionSummary}`, "success");
    showDetails({ stage: "执行完成", plan: executionPlan, checks: outcome.records, protectedEvidence, verificationLevel: outcome.verificationLevel, finalFingerprint: outcome.finalState.fingerprint });
    appendLog({ stage: "completed", plan: executionPlan, checks: outcome.records, protectedEvidence, verificationLevel: outcome.verificationLevel });
    if (runtime.prePlanSelection && runtime.prePlanSelection.token) selectionSessions.release(runtime.prePlanSelection.token);
    runtime.prePlanSelection = null;
    releaseVisualPlanMasks(runtime.plan);
    runtime.plan = null;
    runtime.snapshot = outcome.finalState;
    markInsightsStale();
    renderSnapshot(outcome.finalState);
  } catch (error) {
    const presentation = executionFailurePresentation(error);
    runtime.undoPoint = presentation.preserveUndoPoint && error.undoPoint ? error.undoPoint : null;
    $("undoLast").disabled = !runtime.undoPoint;
    const errorFlags = {
      code: error && error.code || null,
      rollbackVerified: error && typeof error.rollbackVerified === "boolean" ? error.rollbackVerified : null,
      rollbackVerification: error && error.rollbackVerification || null,
      documentStateUncertain: error && typeof error.documentStateUncertain === "boolean" ? error.documentStateUncertain : null,
      documentChangesCommitted: error && typeof error.documentChangesCommitted === "boolean" ? error.documentChangesCommitted : null,
      hasUndoPoint: Boolean(error && error.undoPoint)
    };
    showResult(presentation.message, "error");
    const baselineDiagnostics = error && error.baselineDiagnostics || null;
    const stateEvidence = error && error.stateEvidence || null;
    const lightweightGateDiagnostics = error && error.lightweightGateDiagnostics || null;
    showDetails({ stage: presentation.stage, plan: executionPlan, error: String(error.stack || error), errorFlags, baselineDiagnostics, stateEvidence, lightweightGateDiagnostics, checks: error && error.records || [] });
    appendLog({ stage: "execute_failed", outcomeStage: presentation.stage, plan: executionPlan, error: String(error.message || error), errorFlags, baselineDiagnostics, stateEvidence, lightweightGateDiagnostics });
    try {
      await refreshState({ forceInsights: false, silentError: true });
    } catch (refreshError) {
      showDetails({
        stage: presentation.stage,
        plan: executionPlan,
        error: String(error.stack || error),
        errorFlags,
        baselineDiagnostics,
        stateEvidence,
        lightweightGateDiagnostics,
        refreshError: String(refreshError.stack || refreshError)
      });
    }
  } finally {
    setBusy(false);
  }
}

async function undoLast() {
  if (!runtime.undoPoint || runtime.busy) return;
  try {
    setBusy(true);
    await engine.undo(runtime.undoPoint);
    runtime.undoPoint = null;
    $("undoLast").disabled = true;
    showResult("Photoshop 已切换到本次操作前记录的历史状态，插件会重新读取当前文档供你核对。这只确认历史状态切换，不是对所有内部状态、矢量蒙版或外部文件的逐项证明；外部导出文件不会被删除。", "muted");
    appendLog({ stage: "undone" });
    markInsightsStale();
    await refreshState({ forceInsights: false });
  } catch (error) {
    showResult(`为了避免误删后续工作，自动撤销已停止：${friendlyError(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

async function runSelfTest() {
  if (runtime.busy) return;
  const state = $("selfTestState");
  try {
    setBusy(true);
    state.className = "";
    state.textContent = "正在用临时文档验证核心能力和精确回退...";
    const report = await engine.selfTest({
      onProgress(progress) {
        if (!progress || !progress.label) return;
        state.textContent = progress.status === "passed"
          ? `已通过：${progress.label}，继续验证下一项...`
          : `正在验证：${progress.label}...`;
      }
    });
    state.className = "success";
    state.textContent = `通过：${report.capabilityCount}项能力，${report.checks.length}次验收，回退正常`;
    showResult("v9.8运行环境自检通过。临时文档已关闭，当前海报没有被修改。", "success");
    showDetails({ stage: "运行环境自检通过", report });
    appendLog({ stage: "selftest_passed", report });
    await refreshState({ forceInsights: false });
  } catch (error) {
    state.className = "error";
    state.textContent = "自检失败";
    showResult(`v9.8运行环境自检失败：${friendlyError(error)}`, "error");
    showDetails({ stage: "运行环境自检失败", error: String(error.stack || error) });
    appendLog({ stage: "selftest_failed", error: String(error.message || error) });
    await refreshState({ forceInsights: false });
  } finally {
    setBusy(false);
  }
}

async function cancelPlan() {
  if (runtime.busy) {
    showResult("当前分析或执行尚未结束，不能同时取消计划；如正在请求模型，请使用“取消请求”。", "muted");
    return;
  }
  runtime.visualRequestEpoch += 1;
  let restoreError = null;
  try { await restorePrePlanSelection(); } catch (error) { restoreError = error; }
  releaseVisualPlanMasks(runtime.plan);
  runtime.plan = null;
  runtime.visualEvidence = [];
  runtime.visualConfirmedSteps = new Set();
  runtime.visualCandidateErrors = new Map();
  runtime.visualOriginalParams = new Map();
  runtime.selectionSessionsByStep = new Map();
  runtime.selectionConfidenceByStep = new Map();
  runtime.highRiskConfirmed = false;
  runtime.lassoActive = false;
  capabilities.clearSemanticMasks();
  $("planSection").classList.add("hidden");
  showResult(restoreError
    ? `计划已取消，但恢复原选区失败：${friendlyError(restoreError)}`
    : "已取消计划，并恢复分析前的 Photoshop 选区。", restoreError ? "error" : "muted");
}

function bindEvent(id, eventName, handler) {
  const element = $(id);
  if (!element) {
    console.error(`[PSA9] missing UI element #${id}`);
    appendLog({ stage: "ui_element_missing", id, eventName });
    return false;
  }
  element.addEventListener(eventName, handler);
  return true;
}

function isTextEditingTarget(target) {
  if (!target) return false;
  const tagName = String(target.tagName || "").toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(target.isContentEditable);
}

function bindUiEvents() {
  bindEvent("provider", "change", changeProvider);
  bindEvent("model", "change", () => {
    const provider = modelProviders.getProvider(runtime.modelSettings.providerId);
    if (provider.discoversModels && $("customModel")) $("customModel").value = $("model").value;
    updateModelCapability();
    $("settingsState").textContent = "设置有变更，尚未保存";
  });
  bindEvent("apiKey", "input", () => {
    runtime.modelSettings.apiKeys[runtime.modelSettings.providerId] = $("apiKey").value.trim();
    $("settingsState").textContent = "设置有变更，尚未保存";
  });
  bindEvent("customModel", "input", () => {
    const value = $("customModel").value.trim();
    if (value) runtime.modelSettings.modelId = value;
    $("settingsState").textContent = "设置有变更，尚未保存";
  });
  bindEvent("refreshModels", "click", async () => {
    $("settingsState").textContent = "正在读取 Tokensea 模型列表...";
    try {
      const ids = await discoverProviderModels();
      $("settingsState").textContent = `已读取 ${ids.length} 个 Tokensea 模型`;
    } catch (error) {
      $("settingsState").textContent = `读取失败：${friendlyError(error)}`;
    }
  });
  bindEvent("saveSettings", "click", saveSettings);
  bindEvent("pasteReference", "click", () => pasteReferenceFromClipboard({ silent: false }));
  bindEvent("chooseReference", "click", async () => {
    try { await chooseReference(); } catch (error) { showResult(`读取批注图失败：${friendlyError(error)}`, "error"); }
  });
  bindEvent("clearReference", "click", clearReference);
  bindEvent("toggleColorPicker", "click", toggleColorPicker);
  bindEvent("colorPickerCanvas", "mousemove", updateColorPicker);
  bindEvent("colorPickerCanvas", "mouseleave", leaveColorPicker);
  bindEvent("colorPickerCanvas", "click", copyHoveredColor);
  bindEvent("paletteCategory", "change", renderPaletteColorOptions);
  for (let index = 0; index < 10; index += 1) {
    bindEvent(`paletteSlot${index}`, "click", copyPaletteSlot);
  }
  bindEvent("refreshState", "click", async () => {
    if (runtime.plan) {
      showResult("当前有待确认或待执行的计划，为避免覆盖其严格基线，请先执行或取消计划再刷新。", "error");
      return;
    }
    try {
      await refreshState({ forceInsights: true });
    } catch (_) {}
  });
  bindEvent("analyze", "click", analyzeInstruction);
  bindEvent("cancelRequest", "click", cancelActiveRequests);
  bindEvent("executePlan", "click", executePlan);
  bindEvent("cancelPlan", "click", cancelPlan);
  bindEvent("targetPreviewCanvas", "click", (event) => {
    if (!runtime.lassoActive) correctVisualCandidate(event);
  });
  bindEvent("targetPreviewCanvas", "mousedown", beginLasso);
  bindEvent("targetPreviewCanvas", "mousemove", continueLasso);
  bindEvent("targetPreviewCanvas", "mouseup", finishLasso);
  bindEvent("targetPreviewCanvas", "mouseleave", () => {
    if (runtime.lassoDrawing) finishLasso();
  });
  bindEvent("candidateReplace", "click", () => setVisualCandidateMode("replace"));
  bindEvent("candidateAdd", "click", () => setVisualCandidateMode("add"));
  bindEvent("candidateExclude", "click", () => setVisualCandidateMode("exclude"));
  bindEvent("candidateReset", "click", resetVisualCandidate);
  bindEvent("confirmCandidate", "click", confirmVisualCandidate);
  bindEvent("adoptCurrentSelection", "click", adoptCurrentPhotoshopSelection);
  bindEvent("removeFailedTarget", "click", removeFailedTargetFromPlan);
  bindEvent("nativeSelectionHelp", "click", showNativeSelectionHandoff);
  bindEvent("lassoReplace", "click", () => setLassoMode("replace"));
  bindEvent("lassoAdd", "click", () => setLassoMode("add"));
  bindEvent("lassoSubtract", "click", () => setLassoMode("subtract"));
  bindEvent("lassoIntersect", "click", () => setLassoMode("intersect"));
  bindEvent("acceptLowConfidence", "change", acceptLowConfidenceChanged);
  bindEvent("confirmHighRisk", "change", confirmHighRiskPlan);
  bindEvent("undoLast", "click", undoLast);
  bindEvent("runSelfTest", "click", runSelfTest);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey)
      && String(event.key || "").toLowerCase() === "v"
      && !isTextEditingTarget(event.target)) {
      pasteReferenceFromClipboard({ silent: true });
    }
  });
}

async function initializePanel() {
  console.log("[PSA9] DOMContentLoaded");
  try {
    initializeModelSettings();
  } catch (error) {
    console.error("[PSA9] model settings initialization failed", String(error.stack || error));
    appendLog({ stage: "model_settings_init_failed", error: String(error.message || error) });
  }
  bindUiEvents();
  renderCancelState();
  setBusy(false);
  try {
    await checkProxy();
  } catch (error) {
    console.error("[PSA9] proxy check failed", String(error.stack || error));
  }
  try {
    await refreshState({ forceInsights: true });
  } catch (error) {
    console.error("[PSA9] startup state refresh failed", String(error.stack || error));
  }
  setInterval(refreshWhenDocumentChanges, 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  initializePanel().catch((error) => {
    console.error("[PSA9] panel initialization failed", String(error.stack || error));
    showResult(`插件初始化未完全成功：${friendlyError(error)}。基础按钮仍可继续使用。`, "error");
  });
});
