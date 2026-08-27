"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
process.env.PS_AGENT_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-v98-bridge-"));
const bridge = require(path.join(root, "server.js"));

assert.strictEqual(bridge.BRIDGE_VERSION, "0.9.8");
assert.strictEqual(
  bridge.BRIDGE_BUILD.serverSha256,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "server.js"))).digest("hex"),
  "health build identity must change when server behavior changes without a version bump"
);
assert.strictEqual(
  bridge.BRIDGE_BUILD.providerSha256,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "uxp-v9.8", "model-providers.js"))).digest("hex")
);

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

assert.deepStrictEqual(
  bridge.decodeSegmentImage(pngHeader(100, 80)).dimensions,
  { format: "png", width: 100, height: 80 }
);
assert.throws(() => bridge.decodeSegmentImage(pngHeader(5000, 2)), /dimensions exceed/);
assert.throws(() => bridge.decodeSegmentImage(pngHeader(4096, 4096)), /dimensions exceed/);
assert.throws(() => bridge.decodeSegmentImage(Buffer.from("not-an-image").toString("base64")), /valid PNG or JPEG/);

const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
assert(serverSource.includes('req.url === "/segment-v9.8"'), "v9.8 panel and bridge must share a segmentation route");
const authenticatedRouteSection = serverSource.slice(
  serverSource.indexOf("if (!isAuthenticated(req))"),
  serverSource.indexOf('if (req.method === "POST" && req.url === "/provider-models")')
);
assert(
  !authenticatedRouteSection.includes("requireValidConfig();"),
  "an invalid provider config must not disable local segmentation or clipboard capture"
);

console.log("v9.8 bridge build identity, route isolation, and decoded-image budget tests passed");
