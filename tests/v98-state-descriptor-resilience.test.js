"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "uxp-v9.8", "state-engine.js"), "utf8");
const calls = [];
const action = {
  async batchPlay(commands) {
    const ids = commands.map((command) => Number(command._target[0]._id));
    calls.push(ids);
    if (ids.includes(2)) throw new Error("one unsupported complex layer descriptor");
    return ids.map((id) => ({ id, bounds: { left: 0, top: 0, right: 1, bottom: 1 } }));
  }
};
const context = {
  console, Date, Math, Number, String, Object, Array, Boolean, JSON,
  require(name) {
    if (name === "photoshop") return { app: {}, action, constants: {} };
    throw new Error(`unexpected require: ${name}`);
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "state-engine.js" });

async function main() {
  const state = context.PhotoshopAssistantV8State;
  const commands = [1, 2, 3].map((id) => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }] }));
  const result = await state.readDescriptorBatch(commands, { synchronousExecution: true });
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].id, 1);
  assert.strictEqual(result[1], null, "only the unreadable layer must remain unknown");
  assert.strictEqual(result[2].id, 3, "a single complex layer must not erase safety evidence for every other layer");
  assert(calls.length >= 3, "failed batches must be bisected to isolate the unreadable descriptor");
  console.log("v9.8 per-layer descriptor fallback test passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
