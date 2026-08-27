(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV97Confidence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HIGH_THRESHOLD = 0.78;
  const MEDIUM_THRESHOLD = 0.50;

  function clamp(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }

  function classify(value, options = {}) {
    const confidence = clamp(value);
    const hasCandidate = options.hasCandidate !== false;
    if (!hasCandidate) {
      return Object.freeze({
        level: "unsafe",
        confidence,
        requiresCorrection: true,
        correctionRecommended: true,
        explicitAcceptRequired: false,
        canConfirm: false,
        message: "系统没有生成可执行选区。请在 Photoshop 中建立选区，或使用面板套索后再采用。"
      });
    }
    if (confidence >= HIGH_THRESHOLD) {
      return Object.freeze({
        level: "high",
        confidence,
        requiresCorrection: false,
        correctionRecommended: false,
        explicitAcceptRequired: false,
        canConfirm: true,
        message: "定位置信度较高；仍可随时用点选、套索或 Photoshop 原生工具修正。"
      });
    }
    if (confidence >= MEDIUM_THRESHOLD) {
      return Object.freeze({
        level: "medium",
        confidence,
        requiresCorrection: false,
        correctionRecommended: true,
        explicitAcceptRequired: false,
        canConfirm: true,
        message: "定位置信度一般，建议用点选、套索或 Photoshop 原生工具检查边缘。"
      });
    }
    return Object.freeze({
      level: "low",
      confidence,
      requiresCorrection: true,
      correctionRecommended: true,
      explicitAcceptRequired: true,
      canConfirm: true,
      message: "定位置信度较低：必须修正选区，或明确勾选接受当前候选。"
    });
  }

  function mayConfirm(policy, session) {
    if (!policy || policy.canConfirm !== true || !session) return false;
    if (!policy.explicitAcceptRequired) return true;
    return session.corrected === true || session.lowConfidenceAccepted === true;
  }

  return {
    HIGH_THRESHOLD,
    MEDIUM_THRESHOLD,
    classify,
    mayConfirm
  };
});
