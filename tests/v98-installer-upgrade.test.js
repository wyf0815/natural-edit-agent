"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-v98-install-"));
const runtimeRoot = path.join(temporary, "runtime");
const oldRuntime = path.join(runtimeRoot, "v9.7");
const newRuntime = path.join(runtimeRoot, "v9.8");
const target = path.join(temporary, "plugin");
fs.mkdirSync(oldRuntime, { recursive: true });
const previousToken = "ab".repeat(32);
fs.writeFileSync(path.join(oldRuntime, "bridge-token.json"), JSON.stringify({ version: 1, token: previousToken }), "utf8");

const installer = fs.readFileSync(path.join(root, "Install-UxpV98.ps1"), "utf8");
assert(!/\bGet-FileHash\b/.test(installer), "installer hashing must not depend on the optional Get-FileHash cmdlet");

const result = childProcess.spawnSync("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", path.join(root, "Install-UxpV98.ps1"),
  "-Target", target,
  "-RuntimeDirectory", newRuntime
], { cwd: root, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || "v9.8 installer smoke test failed");

assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).version, "0.9.8");
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(newRuntime, "bridge-token.json"), "utf8")).token, previousToken);
assert(
  fs.readFileSync(path.join(target, "bridge-token.js"), "utf8").includes(previousToken),
  "the installed panel and migrated running bridge must share one token"
);

const launcher = fs.readFileSync(path.join(root, "Start-PhotoshopAgentV98.ps1"), "utf8");
assert(!/\bGet-FileHash\b/.test(launcher), "launcher hashing must not depend on the optional Get-FileHash cmdlet");
assert(launcher.includes("$Health.bridgeBuild.serverSha256 -eq $expectedServerHash"));
assert(launcher.includes("$Health.bridgeBuild.providerSha256 -eq $expectedProviderHash"));
assert(launcher.includes('[Environment]::SetEnvironmentVariable("PS_AGENT_BRIDGE_TOKEN", $previousBridgeToken, "Process")'), "the bridge token must not leak into subsequently launched Photoshop");
assert(launcher.includes("$installedToken -cne $tokenScript"), "an unchanged installed token must not require a Program Files rewrite on every launch");

const modelVerifier = fs.readFileSync(path.join(root, "tools", "Verify-MobileSAMModels.ps1"), "utf8");
assert(!/\bGet-FileHash\b/.test(modelVerifier), "model verification must not depend on the optional Get-FileHash cmdlet");

console.log("v9.8 transactional installer, prior-token migration, and launcher identity tests passed");
