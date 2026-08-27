"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const imagePath = path.join(root, "tests", "visual-object-fixture.png");
const modelDirectory = path.join(root, "models", "mobilesam");
const expectedModels = {
  "mobile_sam_image_encoder.onnx": {
    size: 28157093,
    sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
  },
  "sam_mask_decoder_single.onnx": {
    size: 16501323,
    sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d"
  }
};
const TOKEN = "d".repeat(64);
const width = 400;
const height = 300;
const testVersion = process.env.PS_AGENT_TEST_VERSION === "v9.8" ? "v9.8" : "v9.7";
const expectedBridgeVersion = testVersion === "v9.8" ? "0.9.8" : "0.9.7";
const segmentRoute = testVersion === "v9.8" ? "/segment-v9.8" : "/segment-v9.7";
const strictBridgeScript = `test:v${testVersion.replace(/^v/, "").replace(/\./g, "")}:bridge:strict`;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, requestPath, body) {
  const encoded = body == null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: requestPath,
      headers: {
        "X-PS-Agent-Token": TOKEN,
        ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {})
      },
      timeout: 190000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload;
        try { payload = JSON.parse(text || "{}"); }
        catch (error) { reject(new Error(`bridge returned invalid JSON: ${error.message}\n${text.slice(0, 500)}`)); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`bridge returned HTTP ${response.statusCode}: ${JSON.stringify(payload)}`));
          return;
        }
        resolve(payload);
      });
    });
    request.on("timeout", () => request.destroy(new Error("bridge request timed out")));
    request.on("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function waitForBridge(port, output) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(port, "GET", "/health");
      if (health.ok) return health;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`bridge did not start: ${lastError ? lastError.message : "unknown"}\n${output()}`);
}

function verifyModelsOrSkip() {
  const missing = Object.keys(expectedModels)
    .map((name) => path.join(modelDirectory, name))
    .filter((file) => !fs.existsSync(file));
  if (missing.length) {
    if (process.env.PS_AGENT_REQUIRE_MODELS === "1") {
      throw new Error(`strict bridge test requires MobileSAM models: ${missing.join(", ")}`);
    }
    console.log(`${testVersion} live bridge segmentation: SKIP (MobileSAM models missing). Run npm run ${strictBridgeScript} to fail closed.`);
    return false;
  }
  for (const [name, expected] of Object.entries(expectedModels)) {
    const bytes = fs.readFileSync(path.join(modelDirectory, name));
    assert.strictEqual(bytes.length, expected.size, `${name} size mismatch`);
    assert.strictEqual(crypto.createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name} SHA-256 mismatch`);
  }
  return true;
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  assert(fs.existsSync(imagePath), "public bridge fixture is missing");
  if (!verifyModelsOrSkip()) return;
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PS_AGENT_PORT: String(port), PS_AGENT_BRIDGE_TOKEN: TOKEN },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

  try {
    const health = await waitForBridge(port, () => output);
    assert.strictEqual(health.bridgeVersion, expectedBridgeVersion);
    assert.strictEqual(health.proxy, "photoshop-assistant");
    assert.strictEqual(health.segmentation.available, true, JSON.stringify(health.segmentation.modelIntegrity));

    const body = {
      imageBase64: fs.readFileSync(imagePath).toString("base64"),
      box: [0.53, 0.18, 0.90, 0.84],
      clipBox: [0.48, 0.12, 0.91, 0.87],
      positivePoints: [[0.70, 0.30], [0.56, 0.36], [0.86, 0.36], [0.70, 0.70]],
      negativePoints: [[0.22, 0.31], [0.21, 0.68], [0.92, 0.50]],
      semanticScope: "whole_object",
      targetWidth: width,
      targetHeight: height,
      sourceCrop: { left: 0, top: 0, right: width, bottom: height }
    };
    const first = await requestJson(port, "POST", segmentRoute, body);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.engine, "MobileSAM");
    assert.strictEqual(first.cacheHit, false);
    assert.strictEqual(first.maskEncoding, "rle-cropped-v1");
    assert(first.croppedRle && Array.isArray(first.croppedRle.counts));
    assert.strictEqual(first.croppedRle.canvasWidth, width);
    assert.strictEqual(first.croppedRle.canvasHeight, height);
    assert(first.croppedRle.width * first.croppedRle.height < width * height, "transport mask should be cropped for this fixture");
    assert(first.geometricIntegrity >= 0.90);
    assert(first.targetContainment >= 0.98);
    assert.strictEqual(first.maskPreviewMime, "image/png");

    const second = await requestJson(port, "POST", segmentRoute, body);
    assert.strictEqual(second.cacheHit, true);
    assert.deepStrictEqual(second.croppedRle, first.croppedRle, "cached cropped RLE must be byte-for-byte stable");
    const after = await requestJson(port, "GET", "/health");
    assert(after.segmentation.cacheEntries >= 1);
  } finally {
    await stopChild(child);
  }

  console.log(`${testVersion} authenticated live bridge, model integrity, cropped-RLE, persistent worker, and cache regressions passed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
