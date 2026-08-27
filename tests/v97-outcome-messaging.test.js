"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const main = fs.readFileSync(path.join(root, `uxp-${testVersion}`, "main.js"), "utf8");

for (const helper of [
  "function protectedEvidenceSummary",
  "function rollbackEvidenceSummary",
  "function executionErrorReason",
  "function executionFailurePresentation"
]) {
  assert(main.includes(helper), `main.js must define ${helper}`);
}

for (const engineSignal of [
  "POST_COMMIT_EXPORT_FAILED",
  "rollbackVerified",
  "rollbackVerification",
  "documentStateUncertain",
  "documentChangesCommitted",
  "undoPoint"
]) {
  assert(main.includes(engineSignal), `execution messaging must consume ${engineSignal}`);
}

for (const evidenceLevel of [
  "pixel_and_mask_digest",
  "partial",
  "document_wide_not_applicable",
  "not_sampled",
  "sampled_composite_digest"
]) {
  assert(main.includes(evidenceLevel), `execution messaging must distinguish ${evidenceLevel}`);
}

for (const honestScope of [
  "非目标图层",
  "用户蒙版",
  "矢量蒙版",
  "外部文件",
  "所有 Photoshop 内部状态",
  "证据不足会明确降级",
  "外部导出路径可能已留下完整或部分文件"
]) {
  assert(main.includes(honestScope), `execution messaging must disclose scope: ${honestScope}`);
}

for (const obsoleteClaim of [
  "任何未授权变化都会触发回退",
  "文档编辑已经提交，但最后的文件导出失败",
  "Photoshop没有提交本次文档修改",
  'stage: "执行失败并回退"'
]) {
  assert(!main.includes(obsoleteClaim), `main.js must not retain the overclaim: ${obsoleteClaim}`);
}

assert(main.includes('code === "POST_COMMIT_EXPORT_FAILED"'), "only the explicit export error code may use export-failure messaging");
assert(main.includes('error.rollbackVerified === true'), "verified rollback must require an explicit true signal");
assert(main.includes('error.documentStateUncertain === true'), "uncertain state must require an explicit true signal");
assert(main.includes("不会声称文档“未提交”或“已恢复”"), "unknown failures must not invent a rollback result");
assert(main.includes("这不是已确认的导出错误"), "committed non-export failures must not be labeled as export failures");
assert(main.includes("这只确认历史状态切换"), "manual undo messaging must state its evidence boundary");

const messagingStart = main.indexOf("function friendlyError");
const messagingEnd = main.indexOf("function localServiceError", messagingStart);
assert(messagingStart >= 0 && messagingEnd > messagingStart, "messaging helpers must remain extractable for regression tests");
const messaging = vm.runInNewContext(`
  "use strict";
  ${main.slice(messagingStart, messagingEnd)}
  ({ protectedEvidenceSummary, executionFailurePresentation });
`);

const preflightFailure = messaging.executionFailurePresentation({
  executionPhase: "preflight",
  message: "规划后PSD状态已经变化",
  documentChangesCommitted: false,
  documentStateUncertain: false
});
assert(preflightFailure.stage.includes("尚未开始修改"));
assert(preflightFailure.message.includes("文档编辑步骤尚未开始"));
assert.strictEqual(preflightFailure.preserveUndoPoint, false);

const completeEvidence = messaging.protectedEvidenceSummary({
  verificationLevel: "pixel_and_mask_digest",
  protectedEvidence: { sampledLayerCount: 3 }
});
assert(completeEvidence.includes("3 个非目标图层"));
assert(completeEvidence.includes("用户蒙版摘要"));
assert(completeEvidence.includes("不包括未抽样属性、矢量蒙版"));

const partialEvidence = messaging.protectedEvidenceSummary({
  verificationLevel: "partial",
  protectedEvidence: { unverifiedLayerIds: [7, 11] }
});
assert(partialEvidence.includes("7、11"));
assert(partialEvidence.includes("不能据此排除未验证范围内的变化"));

const exportFailure = messaging.executionFailurePresentation({
  code: "POST_COMMIT_EXPORT_FAILED",
  message: "文档修改已经提交，但导出失败：磁盘已满。可使用本次撤销点恢复文档；外部文件不会自动删除。",
  documentChangesCommitted: true,
  undoPoint: { documentId: 4 }
});
assert.strictEqual(exportFailure.stage, "导出失败（文档编辑已提交）");
assert.strictEqual(exportFailure.preserveUndoPoint, true);
assert(exportFailure.message.includes("磁盘已满"));
assert(!exportFailure.message.includes("恢复文档"), "the UI must not repeat the engine's stronger undo wording");

const nonExportCommitFailure = messaging.executionFailurePresentation({
  code: "PROTECTED_EVIDENCE_READ_FAILED",
  message: "保护区摘要读取失败",
  documentChangesCommitted: true,
  undoPoint: { documentId: 4 }
});
assert.strictEqual(nonExportCommitFailure.stage, "执行失败（文档编辑已提交）");
assert(nonExportCommitFailure.message.includes("不是已确认的导出错误"));

const verifiedRollback = messaging.executionFailurePresentation({
  message: "步骤回读失败",
  rollbackVerified: true,
  rollbackVerification: { level: "structure_only", exactPixelProof: false },
  documentChangesCommitted: false
});
assert.strictEqual(verifiedRollback.stage, "执行失败（已取得回退证据）");
assert(verifiedRollback.message.includes("只有结构级证据"));
assert(verifiedRollback.message.includes("不是逐像素"));

const uncertainState = messaging.executionFailurePresentation({
  message: "自动回退后无法充分验证",
  rollbackVerified: false,
  documentStateUncertain: true,
  documentChangesCommitted: false
});
assert.strictEqual(uncertainState.stage, "执行失败（文档状态不确定）");
assert(uncertainState.message.includes("不能确认文档是否已恢复"));

const unknownState = messaging.executionFailurePresentation(new Error("未知执行错误"));
assert.strictEqual(unknownState.stage, "执行失败（文档状态未证实）");
assert(unknownState.message.includes("不会声称文档“未提交”或“已恢复”"));

console.log(`${testVersion} execution outcome messaging distinguishes evidence levels, export failures, rollback proof, and uncertain document state`);
