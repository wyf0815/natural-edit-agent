"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.5";

const maskRleSource = fs.readFileSync(path.resolve(__dirname, `../uxp-${testVersion}/mask-rle.js`), "utf8");
const source = fs.readFileSync(path.resolve(__dirname, `../uxp-${testVersion}/capabilities.js`), "utf8");
const actionCalls = [];
const context = {
  console,
  Math,
  Number,
  String,
  Object,
  Array,
  Boolean,
  JSON,
  Map,
  Set,
  require(name) {
    if (name === "photoshop") {
      return {
        app: {},
        constants: { Orientation: { VERTICAL: "vertical", HORIZONTAL: "horizontal" } },
        action: {
          async batchPlay(commands, options) {
            actionCalls.push({ commands: JSON.parse(JSON.stringify(commands)), options });
            const type = commands[0] && commands[0]._obj;
            if (type === "get") return [transformedDescriptor];
            return commands.map(() => ({}));
          }
        },
        imaging: {}
      };
    }
    throw new Error(`unexpected require ${name}`);
  }
};
context.globalThis = context;
vm.runInNewContext(maskRleSource, context, { filename: "mask-rle.js" });
vm.runInNewContext(source, context, { filename: "capabilities.js" });

const capabilities = context.PhotoshopAssistantV8Capabilities;
const sizeCommands = capabilities.buildNativeTextStyleCommands(42, { size: 80 });
assert.strictEqual(sizeCommands.length, 1);
assert.strictEqual(sizeCommands[0].to._obj, "textStyle");
assert.strictEqual(sizeCommands[0].to.size._unit, "pointsUnit");
assert.strictEqual(sizeCommands[0].to.size._value, 80, "Photoshop must receive the requested UI point value without transform pre-compensation");

const commands = capabilities.buildNativeTextStyleCommands(42, {
  leading: 30,
  baselineShift: 3,
  firstLineIndent: 6,
  leftIndent: 4,
  rightIndent: 4,
  spaceBefore: 2,
  spaceAfter: 3
});

assert.strictEqual(commands.length, 2, "character and paragraph point properties must use separate native set commands");
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(commands[0]._target)),
  [
    { _property: "textStyle", _ref: "property" },
    { _enum: "ordinal", _ref: "textLayer", _value: "targetEnum" }
  ],
  "native writer must follow Adobe's selected text-layer target"
);
assert.strictEqual(commands[0].to._obj, "textStyle");
assert.strictEqual(commands[0].to.autoLeading, false);
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[0].to.leading)), { _unit: "pointsUnit", _value: 30 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[0].to.baselineShift)), { _unit: "pointsUnit", _value: 3 });

assert.strictEqual(commands[1].to._obj, "paragraphStyle");
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[1].to.firstLineIndent)), { _unit: "pointsUnit", _value: 6 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[1].to.startIndent)), { _unit: "pointsUnit", _value: 4 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[1].to.endIndent)), { _unit: "pointsUnit", _value: 4 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[1].to.spaceBefore)), { _unit: "pointsUnit", _value: 2 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(commands[1].to.spaceAfter)), { _unit: "pointsUnit", _value: 3 });

const highResolutionCommands = capabilities.buildNativeTextStyleCommands(42, {
  firstLineIndent: 6,
  baselineShift: 3
});
assert.strictEqual(
  highResolutionCommands[0].to.baselineShift._value,
  3,
  "native character point values must not be multiplied by document resolution"
);
assert.strictEqual(
  highResolutionCommands[1].to.firstLineIndent._value,
  6,
  "native paragraph point values must not depend on a prior value or document resolution"
);

assert.doesNotThrow(() => capabilities.assertNativeTextStyleResults([{}, {}], commands));
assert.throws(
  () => capabilities.batchPlayError([{ _obj: "failure", message: "not available" }], "测试命令"),
  /测试命令失败/
);
assert.throws(
  () => capabilities.batchPlayError([{ result: -1 }], "测试命令"),
  /测试命令失败/
);
assert.throws(
  () => capabilities.batchPlayError([null], "测试命令"),
  /测试命令失败/
);
assert.throws(() => capabilities.assertNativeTextStyleResults([null, {}], commands));
assert.throws(
  () => capabilities.assertNativeTextStyleResults([{}], commands),
  /没有返回完整结果/
);
assert.throws(
  () => capabilities.assertNativeTextStyleResults([{ _obj: "error", message: "bad" }, {}], commands),
  /原生文字属性textStyle写入失败/
);
assert.throws(
  () => capabilities.buildNativeTextStyleCommands(0, { baselineShift: 3 }),
  /缺少有效图层ID/
);
assert.throws(() => capabilities.assertClose(undefined, 3, 0.1, "strict readback"));
assert.throws(() => capabilities.assertClose(Number.NaN, 3, 0.1, "strict readback"));
assert.doesNotThrow(() => capabilities.assertClose(3.00001, 3, 0.1, "strict readback"));
assert.ok(!source.includes("style[key] = deltaPixels"), "v9.5 must not treat absolute text properties as deltas");
assert.ok(!source.includes("assignedAbsoluteDeltaPixels"), "v9.5 must remove the old cumulative-drift path");
assert.ok(!source.includes("character.size = assignedTextPixels"), "font size execution must not depend on a stale state snapshot");
assert.ok(!source.includes("prepareNativeTextStyleParams"), "font size must not be divided by the text transform before writing");

(async () => {
  actionCalls.length = 0;
  await capabilities.applyNativeTextStylePoints(42, { size: 80 });
  assert.strictEqual(actionCalls.length, 2, "native size write must select the exact layer and write once");
  assert.strictEqual(actionCalls[0].commands[0]._obj, "select");
  assert.strictEqual(actionCalls[1].commands[0]._obj, "set");
  assert.strictEqual(actionCalls[1].commands[0].to.size._value, 80);
  console.log(`${testVersion} native absolute text property tests passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

