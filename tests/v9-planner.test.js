"use strict";

const assert = require("assert");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.3";
const planner = require(`../uxp-${testVersion}/planner.js`);
const strictRequirementIds = /^v9\.(?:[7-9]|\d{2,})$/.test(testVersion);

const createAndMoveText = "\u5efa\u7acb\u4e00\u4e2a\u7ec4\u53eb\u505a\u6d4b\u8bd5\u7ec4\uff0c\u7136\u540e\u628a\u9009\u4e2d\u7684\u56fe\u5c42\u653e\u5230\u6d4b\u8bd5\u7ec4\u4e2d";
const createAndMove = planner.buildRequirements(createAndMoveText);
assert.deepStrictEqual(createAndMove.map((item) => item.key), ["create_group", "move_to_group"]);

const normalized = planner.normalizeDependencies({
  operations: [
    {
      id: "create",
      action: "layer.create_group",
      target: { scope: "document" },
      params: { name: "\u6d4b\u8bd5\u7ec4" },
      requirementIds: [createAndMove[0].id]
    },
    {
      id: "move",
      action: "layer.move_to_group",
      target: { scope: "active_layer" },
      params: { groupName: "\u6d4b\u8bd5\u7ec4" },
      requirementIds: [createAndMove[1].id]
    }
  ]
});
assert.strictEqual(normalized.operations[1].params.groupResultOf, "create");
assert.strictEqual(planner.validateDependencyGraph(normalized).valid, true);
assert.strictEqual(planner.auditRequirementCoverage(createAndMove, normalized).complete, true);

const incomplete = {
  operations: [{
    id: "create",
    action: "layer.create_group",
    target: { scope: "document" },
    params: { name: "\u6d4b\u8bd5\u7ec4" },
    requirementIds: [createAndMove[0].id]
  }]
};
assert.strictEqual(planner.auditRequirementCoverage(createAndMove, incomplete).complete, false);

const wrongFamily = {
  operations: [{
    id: "wrong",
    action: "layer.set_opacity",
    target: { scope: "active_layer" },
    params: { opacity: 50 },
    requirementIds: createAndMove.map((item) => item.id)
  }]
};
const wrongFamilyAudit = planner.auditRequirementCoverage(createAndMove, wrongFamily);
assert.strictEqual(wrongFamilyAudit.complete, false);
if (strictRequirementIds) {
  assert.ok(wrongFamilyAudit.missing.filter((item) => item.startsWith("req_")).every((item) => item.includes("\u64cd\u4f5c\u7c7b\u578b\u4e0d\u5339\u914d")));
  assert.deepStrictEqual(Array.from(wrongFamilyAudit.unauthorizedOperations), ["wrong:layer.set_opacity\uff08\u64cd\u4f5c\u7c7b\u578b\u4e0d\u7b26\u5408\u6240\u5173\u8054\u7684\u7528\u6237\u9700\u6c42\uff09"]);
} else {
  assert.ok(wrongFamilyAudit.missing.every((item) => item.includes("\u64cd\u4f5c\u7c7b\u578b\u4e0d\u5339\u914d")));
}

assert.strictEqual(planner.validateDependencyGraph({
  operations: [
    {
      id: "rename",
      action: "layer.rename",
      target: { scope: "operation_result", resultOf: "copy" },
      params: { name: "\u526f\u672c" }
    },
    {
      id: "copy",
      action: "layer.duplicate",
      target: { scope: "active_layer" },
      params: {}
    }
  ]
}).valid, false);

const paraphrases = [
  ["\u65b0\u5efa\u4e00\u4e2a\u53eb\u7d20\u6750\u7684\u56fe\u5c42\u7ec4", "create_group"],
  ["\u628a\u5f53\u524d\u5c42\u590d\u5236\u4e00\u4efd", "duplicate"],
  ["\u628a\u526f\u672c\u6539\u540d\u4e3a\u6d3b\u52a8\u5c42", "rename"],
  ["\u5c06\u8fd9\u5c42\u7684\u4e0d\u900f\u660e\u5ea6\u8bbe\u4e3a63%", "opacity"],
  ["\u586b\u5145\u4e0d\u900f\u660e\u5ea6\u8c03\u6574\u4e3a61%", "fill_opacity"],
  ["\u5411\u53f3\u79fb\u52a820\u50cf\u7d20", "move"],
  ["\u5c06\u56fe\u5c42\u7f29\u653e\u523080%", "scale"],
  ["\u987a\u65f6\u9488\u65cb\u8f6c15\u5ea6", "rotate"],
  ["\u628a\u5f53\u524d\u6587\u5b57\u5b57\u53f7\u6539\u4e3a48", "text_size"],
  ["\u628a\u5b57\u4f53\u8bbe\u7f6e\u4e3a\u6c49\u4eea\u65d7\u9ed1", "text_font"],
  ["\u628a\u6587\u5b57\u6539\u6210\u7ea2\u8272", "text_color"],
  ["\u9009\u62e9\u753b\u9762\u4e3b\u4f53", "selection"],
  ["\u628a\u53f3\u4fa7\u4eba\u7269\u62a0\u51fa\u5e76\u9690\u85cf\u80cc\u666f", "cutout"],
  ["\u5c06\u56fe\u50cf\u5927\u5c0f\u8c03\u6574\u4e3a1080x1920", "document_size"],
  ["\u5bfc\u51fa\u4e3aPNG", "export"],
  ["\u628a\u9009\u4e2d\u56fe\u5c42\u79fb\u5165\u7d20\u6750\u7ec4\u4e2d", "move_to_group"]
];
for (const [phrase, expectedKey] of paraphrases) {
  const requirements = planner.buildRequirements(phrase);
  assert.ok(requirements.some((item) => item.key === expectedKey), `missing ${expectedKey}: ${phrase}`);
}

const compound = planner.buildRequirements(
  "\u590d\u5236\u5f53\u524d\u56fe\u5c42\uff0c\u7136\u540e\u628a\u526f\u672c\u91cd\u547d\u540d\u4e3a\u6d3b\u52a8\u526f\u672c\uff0c\u5411\u53f3\u79fb\u52a840\u50cf\u7d20\uff0c\u4e0d\u900f\u660e\u5ea6\u6539\u4e3a70%"
);
for (const key of ["duplicate", "rename", "move", "opacity"]) {
  assert.ok(compound.some((item) => item.key === key), `missing compound requirement ${key}`);
}

console.log(`${testVersion} planner tests passed: ${paraphrases.length} paraphrases`);
