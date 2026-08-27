"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function loadHarness() {
  const source = fs.readFileSync(path.join(root, "uxp-v9.8", "selection-session.js"), "utf8");
  const calls = { polygons: 0, putSelection: 0 };
  let liveMask = new Uint8Array(12).fill(255);
  let restoreFault = "";
  const document = {
    id: 7,
    width: 100,
    height: 80,
    selection: {
      bounds: { left: 10, top: 20, right: 14, bottom: 23 },
      async selectPolygon() { calls.polygons += 1; }
    }
  };
  const photoshop = {
    app: { documents: [document], activeDocument: document },
    constants: {
      SelectionType: {
        REPLACE: "replace",
        EXTEND: "add",
        DIMINISH: "subtract",
        INTERSECT: "intersect"
      }
    },
    imaging: {
      async getSelection() {
        return {
          sourceBounds: {
            left: document.selection.bounds.left,
            top: document.selection.bounds.top,
            right: document.selection.bounds.right,
            bottom: document.selection.bounds.bottom
          },
          imageData: {
            width: 4,
            height: 3,
            async getData() { return new Uint8Array(liveMask); },
            dispose() {}
          }
        };
      },
      async createImageDataFromBuffer(data, options) {
        return { data: new Uint8Array(data), options, dispose() {} };
      },
      async putSelection(options) {
        calls.putSelection += 1;
        liveMask = new Uint8Array(options.imageData.data);
        document.selection.bounds = { left: 10, top: 20, right: 14, bottom: 23 };
        if (restoreFault === "shift") {
          document.selection.bounds = { left: 11, top: 20, right: 15, bottom: 23 };
        } else if (restoreFault === "mask") {
          liveMask[0] = 0;
        }
      }
    }
  };
  const context = {
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    module: { exports: {} },
    require(name) {
      if (name === "photoshop") return photoshop;
      throw new Error(`unexpected require: ${name}`);
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "selection-session.js" });
  return {
    sessions: context.module.exports,
    calls,
    setRestoreFault(value) { restoreFault = value; }
  };
}

async function main() {
  const harness = loadHarness();
  const locked = await harness.sessions.captureCurrent();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(locked.origin)), { left: 10, top: 20 });
  assert.strictEqual(locked.width, 4);
  assert.strictEqual(locked.height, 3);

  await harness.sessions.restore(locked.token);
  assert.strictEqual(harness.calls.putSelection, 1, "a valid locked selection must restore and verify");

  await assert.rejects(
    () => harness.sessions.applyPolygon("expired-token", [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 2, y: 4 }], "add"),
    /锁定选区已失效/
  );
  assert.strictEqual(harness.calls.polygons, 0, "an expired authority token must never modify the live selection");

  harness.setRestoreFault("shift");
  await assert.rejects(() => harness.sessions.restore(locked.token), /位置与锁定选区不一致/);

  harness.setRestoreFault("mask");
  await assert.rejects(() => harness.sessions.restore(locked.token), /内容与锁定选区不一致/);

  console.log("v9.8 authoritative selection restore readback and fail-closed correction tests passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
