"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const python = process.env.PS_AGENT_PYTHON || (process.platform === "win32" ? "python.exe" : "python3");
const matcher = path.join(root, "segmentation", "reference_match.py");
const selfTest = childProcess.spawnSync(python, [matcher, "--self-test"], {
  cwd: root,
  encoding: "utf8",
  timeout: 30000
});
if (selfTest.status !== 0) throw new Error(selfTest.stderr || selfTest.stdout || "reference matcher self-test failed");
const payload = JSON.parse(String(selfTest.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop());
assert.strictEqual(payload.ok, true);
assert.strictEqual(payload.selfTest, true);

const mainSource = fs.readFileSync(path.join(root, "uxp-v9.8", "main.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const analyzeStart = mainSource.indexOf("async function analyzeInstruction");
const analyzeEnd = mainSource.indexOf("\nasync function executePlan", analyzeStart);
const analyzeSource = mainSource.slice(analyzeStart, analyzeEnd);
assert(analyzeSource.indexOf("validateReferenceCorrespondence") >= 0);
assert(analyzeSource.indexOf("validateReferenceCorrespondence") < analyzeSource.indexOf("engine.understand"),
  "a mismatched annotation must be rejected before any planning-model request");
assert(mainSource.includes("本次没有调用模型，也没有修改文档"));
assert(serverSource.includes('req.url === "/reference-match-v9.8"'));
assert(serverSource.includes("referenceMatching"));

function requestJson(port, requestPath, body, token) {
  return new Promise((resolve, reject) => {
    const encoded = body == null ? "" : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: body == null ? "GET" : "POST",
      headers: {
        ...(token ? { "X-PS-Agent-Token": token } : {}),
        ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch (error) { reject(error); return; }
        resolve({ status: response.statusCode, data });
      });
    });
    request.on("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

(async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-v98-reference-"));
  const token = "e".repeat(64);
  process.env.PS_AGENT_RUNTIME_DIR = runtime;
  process.env.PS_AGENT_BRIDGE_TOKEN = token;
  const bridge = require(path.join(root, "server.js"));
  const server = bridge.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const health = await requestJson(port, "/health", null, token);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.referenceMatching.available, true);
    const imageBase64 = fs.readFileSync(path.join(root, "tests", "visual-object-fixture.png")).toString("base64");
    const unauthorized = await requestJson(port, "/reference-match-v9.8", { documentBase64: imageBase64, referenceBase64: imageBase64 }, "");
    assert.strictEqual(unauthorized.status, 401);
    const matched = await requestJson(port, "/reference-match-v9.8", { documentBase64: imageBase64, referenceBase64: imageBase64 }, token);
    assert.strictEqual(matched.status, 200);
    assert.strictEqual(matched.data.match, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtime, { recursive: true, force: true });
  }
  console.log("v9.8 local annotation/document fingerprint gate passed synthetic and authenticated bridge checks");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
