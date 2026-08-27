"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.3";
const protocol = require(`../uxp-${testVersion}/protocol.js`);
const planner = require(`../uxp-${testVersion}/planner.js`);

const source = fs.readFileSync(path.resolve(__dirname, `../uxp-${testVersion}/engine.js`), "utf8");
const context = {
  console, Date, Set, Map, JSON, Math, Number, String, Object, Array,
  PhotoshopAssistantV8Protocol: protocol,
  PhotoshopAssistantV9Planner: planner,
  PhotoshopAssistantV8State: { compactForModel: (value) => value },
  PhotoshopAssistantV8Capabilities: {
    catalog: () => [...protocol.ACTIONS].map((id) => ({ id }))
  },
  require(name) {
    if (name === "photoshop") return { app: {}, core: {} };
    throw new Error(`unexpected require ${name}`);
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "engine.js" });
const engine = context.PhotoshopAssistantV8Engine;

const deterministicCases = [
  "\u628a\u5f53\u524d\u56fe\u5c42\u7684\u4e0d\u900f\u660e\u5ea6\u6539\u4e3a63%",
  "\u590d\u5236\u5f53\u524d\u56fe\u5c42\uff0c\u7136\u540e\u628a\u526f\u672c\u91cd\u547d\u540d\u4e3a\u6d3b\u52a8\u526f\u672c\uff0c\u518d\u5411\u53f3\u79fb\u52a840\u50cf\u7d20",
  "\u5efa\u7acb\u4e00\u4e2a\u7ec4\u53eb\u505a\u6d4b\u8bd5\u7ec4\uff0c\u7136\u540e\u628a\u9009\u4e2d\u7684\u56fe\u5c42\u653e\u5230\u6d4b\u8bd5\u7ec4\u4e2d",
  "\u628a\u5f53\u524d\u6587\u5b57\u5b57\u53f7\u6539\u4e3a48\u5e76\u4e14\u6539\u6210\u7ea2\u8272",
  "把当前文字改为“暑期活动”，字号80点，颜色#FF0000。",
  "\u5efa\u7acb\u4e00\u4e2a\u5de6100\u3001\u4e0a120\u3001\u53f3900\u3001\u4e0b1400\u50cf\u7d20\u7684\u77e9\u5f62\u9009\u533a\uff0c\u7136\u540e\u6536\u7f2910\u50cf\u7d20\uff0c\u518d\u7fbd\u53163\u50cf\u7d20"
];
for (const instruction of deterministicCases) {
  const intent = engine.parseFastInstruction(instruction);
  assert.ok(intent, `fast planning failed: ${instruction}`);
  const requirements = planner.buildRequirements(instruction);
  const audit = engine.auditPlanningCompleteness(instruction, intent, requirements);
  assert.strictEqual(audit.complete, true, `${instruction}: ${audit.missing.join(";")}`);
}

(async () => {
  const instruction = "\u628a\u5f53\u524d\u56fe\u5c42\u590d\u5236\u4e00\u4efd\uff0c\u7136\u540e\u628a\u526f\u672c\u91cd\u547d\u540d\u4e3a\u6d4b\u8bd5\u526f\u672c\uff0c\u518d\u628a\u526f\u672c\u4e0d\u900f\u660e\u5ea6\u6539\u4e3a70%";
  let calls = 0;
  const incompletePlanCall = () => engine.understand(instruction, {}, async ({ user }) => {
    calls += 1;
    const payload = JSON.parse(user);
    const ids = Object.fromEntries(payload.requirementChecklist.map((item) => [item.type, item.id]));
    if (calls === 1) {
      return JSON.stringify({
        operations: [{
          id: "copy",
          action: "layer.duplicate",
          target: { scope: "active_layer" },
          params: {},
          requirementIds: [ids.duplicate]
        }]
      });
    }
    return JSON.stringify({
      operations: [
        {
          id: "copy",
          action: "layer.duplicate",
          target: { scope: "active_layer" },
          params: {},
          requirementIds: [ids.duplicate]
        },
        {
          id: "rename",
          action: "layer.rename",
          target: { scope: "operation_result", resultOf: "copy" },
          params: { name: "\u6d4b\u8bd5\u526f\u672c" },
          requirementIds: [ids.rename]
        },
        {
          id: "opacity",
          action: "layer.set_opacity",
          target: { scope: "operation_result", resultOf: "copy" },
          params: { opacity: 70 },
          requirementIds: [ids.opacity]
        }
      ]
    });
  }, { forceModel: true });
  if (Number(testVersion.replace(/^v/, "")) >= 9.4) {
    await assert.rejects(incompletePlanCall, /没有进入执行/);
    assert.strictEqual(calls, 1, "v9.4+ must not make a hidden completeness-repair request");
  } else {
    const repaired = await incompletePlanCall();
    assert.strictEqual(calls, 2);
    assert.strictEqual(repaired.intent.operations.length, 3);
  }

  let jsonRepairCalls = 0;
  const brokenJsonCall = () => engine.understand("\u628a\u5f53\u524d\u56fe\u5c42\u91cd\u547d\u540d\u4e3a\u4e3b\u4f53\u6d4b\u8bd5", {}, async () => {
    jsonRepairCalls += 1;
    if (jsonRepairCalls === 1) return "{\"operations\":[";
    return JSON.stringify({
      operations: [{
        id: "rename",
        action: "layer.rename",
        target: { scope: "active_layer" },
        params: { name: "\u4e3b\u4f53\u6d4b\u8bd5" },
        requirementIds: ["req_1"]
      }]
    });
  }, { forceModel: true });
  if (Number(testVersion.replace(/^v/, "")) >= 9.4) {
    await assert.rejects(brokenJsonCall, /没有再次请求模型/);
    assert.strictEqual(jsonRepairCalls, 1, "v9.4+ must not make a hidden JSON-repair request");
  } else {
    const jsonRepaired = await brokenJsonCall();
    assert.strictEqual(jsonRepairCalls, 2);
    assert.strictEqual(jsonRepaired.intent.operations[0].action, "layer.rename");
  }

  console.log(`${testVersion} planning integration tests passed: ${deterministicCases.length} deterministic cases`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
