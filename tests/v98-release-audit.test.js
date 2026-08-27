"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PUBLIC_RELEASE_FILES,
  auditRelease,
  scanText,
  validateExampleConfig
} = require("../tools/audit-public-release.js");

const root = path.resolve(__dirname, "..");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-v98-release-audit-"));

function copyManifest() {
  for (const rel of PUBLIC_RELEASE_FILES) {
    const source = path.join(root, rel);
    const target = path.join(staging, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

try {
  const discoveredV98Tests = fs.readdirSync(__dirname)
    .filter((name) => /^v98-.*\.test\.js$/.test(name))
    .map((name) => `tests/${name}`)
    .sort();
  const publishedV98Tests = PUBLIC_RELEASE_FILES
    .filter((rel) => /^tests\/v98-.*\.test\.js$/.test(rel))
    .sort();
  assert.deepStrictEqual(publishedV98Tests, discoveredV98Tests, "every v9.8 test must be staged and no stale test path may remain");
  assert(PUBLIC_RELEASE_FILES.includes("uxp-v9.8/main.js"));
  assert(!PUBLIC_RELEASE_FILES.some((rel) => /^uxp-v9\.7\//.test(rel)));

  copyManifest();
  const clean = auditRelease(staging, { quiet: true });
  assert.deepStrictEqual(clean.failures, [], clean.failures.join("\n"));

  const extra = path.join(staging, "nested", "private", "debug.log");
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(extra, "must not ship\n", "utf8");
  const withExtra = auditRelease(staging, { quiet: true });
  assert(withExtra.failures.some((item) => item.includes("nested/private/debug.log: unexpected file")),
    "recursive auditing must reject an unlisted file at any depth");

  const privateAddress = [192, 168, 56, 7].join(".");
  assert(scanText("server.js", `const endpoint = "http://${privateAddress}/v1";`).some((item) => item.includes("private network")));
  const fakeSecret = `sk-${"notARealCredential".repeat(2)}`;
  assert(scanText("server.js", `const leaked = "${fakeSecret}";`).some((item) => item.includes("API key")));
  assert.deepStrictEqual(validateExampleConfig('{"providers":{"qwen":{"apiKey":""}}}'), []);
  assert(validateExampleConfig('{"providers":{"qwen":{"apiKey":"not-empty"}}}').some((item) => item.includes("must be empty")));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

console.log(`v9.8 exact recursive release audit regressions passed (${PUBLIC_RELEASE_FILES.length} staged files)`);
