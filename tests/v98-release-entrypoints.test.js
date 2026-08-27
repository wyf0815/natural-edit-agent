"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));

assert.strictEqual(packageJson.version, "0.9.8");
assert.strictEqual(packageJson.scripts.test, "npm run test:v98");
assert.strictEqual(packageJson.scripts.check, "npm run check:v98");
assert(packageJson.scripts["test:v98"], "the v9.8 public test entrypoint must be available");
assert(packageJson.scripts["check:v98"], "the v9.8 public syntax entrypoint must be available");
assert(packageJson.scripts["test:v98:bridge"], "the v9.8 bridge entrypoint must be available");
assert(packageJson.scripts["test:v98:bridge:strict"], "the strict v9.8 bridge entrypoint must be available");
const releaseAudit = packageJson.scripts["release:audit"] || "";
assert(
  releaseAudit.includes("stage-public-release.js --audit-only")
    || releaseAudit.includes("audit-public-release.js ."),
  "the release audit command must validate either an isolated source staging artifact or the exact public tree"
);

const runner = fs.readFileSync(path.join(root, "tests", "run-v98-public.js"), "utf8");
assert(runner.includes('PS_AGENT_TEST_VERSION: "v9.8"'));
assert(runner.includes('/^v98-.*\\.test\\.js$/'), "the runner must discover every v9.8 test instead of maintaining a partial list");

const genericLauncher = fs.readFileSync(path.join(root, "Start-PhotoshopAgent.ps1"), "utf8");
const genericInstaller = fs.readFileSync(path.join(root, "Install-GlobalExtension.ps1"), "utf8");
const packageBuilder = fs.readFileSync(path.join(root, "Build-Ccx.ps1"), "utf8");
const shortcutRegistrar = fs.readFileSync(path.join(root, "Register-StartupShortcut.ps1"), "utf8");
assert(genericLauncher.includes("Start-PhotoshopAgentV98.ps1"));
assert(!genericLauncher.includes('requiredBridgeVersion = "0.9.5"'));
assert(genericInstaller.includes("Install-UxpV98.ps1"));
assert(!genericInstaller.includes("0.1.0"));
assert(packageBuilder.includes('"uxp-v9.8"'));
assert(packageBuilder.includes("Natural-Edit-Agent-v0.9.8-beta.ccx"));
assert(shortcutRegistrar.includes("Start-PhotoshopAgentV98.ps1"));

const stageTool = fs.readFileSync(path.join(root, "tools", "stage-public-release.js"), "utf8");
const auditTool = fs.readFileSync(path.join(root, "tools", "audit-public-release.js"), "utf8");
assert(stageTool.includes('natural-edit-agent-public'));
assert(stageTool.includes('process.argv.slice(2).includes("--audit-only")'));
assert(auditTool.includes("unexpected file is not in the public release manifest"));

console.log("v9.8 default, public bridge, generic Windows, and staged-release entrypoints passed");
