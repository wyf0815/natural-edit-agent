"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "uxp-v9.8", "capabilities.js"), "utf8");
const start = source.indexOf("async function withPreservedSelection");
const end = source.indexOf("\n  function batchPlayError", start);
assert(start >= 0 && end > start);

function loadGuard(options = {}) {
  let callbackCalls = 0;
  let putCalls = 0;
  let digestCalls = 0;
  const originalBounds = { left: 10, top: 20, right: 14, bottom: 23 };
  let liveBounds = { ...originalBounds };
  const context = {
    app: {
      activeDocument: {
        id: 7,
        selection: {
          async deselect() { liveBounds = null; }
        }
      }
    },
    imaging: {
      async getSelection() {
        if (options.captureFails) return null;
        return { imageData: { dispose() {} } };
      },
      async putSelection() {
        putCalls += 1;
        liveBounds = options.shiftedRestore
          ? { left: 11, top: 20, right: 15, bottom: 23 }
          : { ...originalBounds };
      }
    },
    activeSelectionBounds() { return liveBounds && { ...liveBounds }; },
    async selectionDigest() {
      digestCalls += 1;
      return options.changedDigest && digestCalls > 1 ? "changed" : "original";
    },
    safeDispose() {},
    result: null
  };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = withPreservedSelection;`, context, { filename: "capabilities-selection-guard.js" });
  return {
    guard: context.result,
    async callback() { callbackCalls += 1; return "done"; },
    calls() { return { callbackCalls, putCalls }; }
  };
}

async function main() {
  const missing = loadGuard({ captureFails: true });
  await assert.rejects(() => missing.guard(missing.callback), /已停止执行/);
  assert.strictEqual(missing.calls().callbackCalls, 0, "a whole-layer transform must not run under an uncaptured live selection");

  const valid = loadGuard();
  assert.strictEqual(await valid.guard(valid.callback), "done");
  assert.deepStrictEqual(valid.calls(), { callbackCalls: 1, putCalls: 1 });

  const shifted = loadGuard({ shiftedRestore: true });
  await assert.rejects(() => shifted.guard(shifted.callback), /未能精确恢复原活动选区/);

  const changed = loadGuard({ changedDigest: true });
  await assert.rejects(() => changed.guard(changed.callback), /未能精确恢复原活动选区/);

  assert(/id: "layer\.duplicate"[\s\S]{0,180}preflight: requireReadable/.test(source), "duplicating a locked source is a read operation");
  assert(/id: "selection\.load_layer"[\s\S]{0,180}preflight: requireReadable/.test(source), "loading transparency is a read operation");
  console.log("v9.8 whole-layer selection isolation and read-only source preflight tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
