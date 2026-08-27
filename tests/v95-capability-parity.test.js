"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.5";
const protocol = require(path.join(root, `uxp-${testVersion}`, "protocol.js"));
const maskRleSource = fs.readFileSync(path.join(root, `uxp-${testVersion}`, "mask-rle.js"), "utf8");
const source = fs.readFileSync(path.join(root, `uxp-${testVersion}`, "capabilities.js"), "utf8");
const context = {
  console,
  Math,
  Number,
  String,
  Object,
  Array,
  Boolean,
  JSON,
  Date,
  Map,
  Set,
  Uint8Array,
  require(name) {
    if (name !== "photoshop") throw new Error(`unexpected require ${name}`);
    return {
      app: {},
      constants: { Orientation: { VERTICAL: "vertical", HORIZONTAL: "horizontal" } },
      action: { batchPlay: async () => [] },
      imaging: {}
    };
  }
};
context.globalThis = context;
vm.runInNewContext(maskRleSource, context, { filename: "mask-rle.js" });
vm.runInNewContext(source, context, { filename: "capabilities.js" });

const capabilities = context.PhotoshopAssistantV8Capabilities;
const declared = [...protocol.ACTIONS].sort();
const catalog = JSON.parse(JSON.stringify(capabilities.catalog()));
const registered = catalog.map((item) => item.id).sort();

assert.deepStrictEqual(registered, declared, "protocol actions and native capability registry must match exactly");
assert.strictEqual(new Set(registered).size, registered.length, "native capability IDs must be unique");
for (const item of catalog) {
  assert(item.label && typeof item.label === "string", `${item.id} is missing a user-facing label`);
  assert(Array.isArray(item.targetTypes) && item.targetTypes.length > 0, `${item.id} is missing target types`);
  const native = capabilities.get(item.id);
  assert.strictEqual(typeof native.preflight, "function", `${item.id} is missing preflight`);
  assert.strictEqual(typeof native.execute, "function", `${item.id} is missing execute`);
  assert.strictEqual(typeof native.verify, "function", `${item.id} is missing verification`);
}

console.log(`${testVersion} capability parity passed: ${registered.length} native Photoshop actions`);
