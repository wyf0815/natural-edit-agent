"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PUBLIC_RELEASE_FILES } = require("./audit-public-release.js");

const source = path.resolve(__dirname, "..");
const parent = path.resolve(source, "..");
const targetName = "natural-edit-agent-public";
const target = path.join(parent, targetName);
const temporary = path.join(parent, `.${targetName}-staging-${process.pid}-${Date.now()}`);
const auditOnly = process.argv.slice(2).includes("--audit-only");

if (path.basename(target) !== targetName || path.dirname(target) !== parent || target === source) {
  throw new Error("Unexpected public staging target.");
}
if (path.dirname(temporary) !== parent || !path.basename(temporary).startsWith(`.${targetName}-staging-`)) {
  throw new Error("Unexpected temporary staging target.");
}

function copyReleaseFiles() {
  fs.mkdirSync(temporary, { recursive: false });
  for (const rel of PUBLIC_RELEASE_FILES) {
    const from = path.resolve(source, rel);
    if (!from.startsWith(`${source}${path.sep}`) || !fs.existsSync(from)) {
      throw new Error(`Release source is missing or unsafe: ${rel}`);
    }
    const sourceStat = fs.lstatSync(from);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Release source is not a regular file: ${rel}`);
    const to = path.resolve(temporary, rel);
    if (!to.startsWith(`${temporary}${path.sep}`)) throw new Error(`Release target escaped staging root: ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function writePublicPackage() {
  const packagePath = path.join(temporary, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.version = "0.9.8";
  packageJson.scripts = {
    start: "node server.js",
    check: "npm run check:v98",
    test: "npm run test:v98",
    "check:v98": "node --check uxp-v9.8/model-providers.js && node --check uxp-v9.8/visual-contract.js && node --check uxp-v9.8/protocol.js && node --check uxp-v9.8/state-engine.js && node --check uxp-v9.8/mask-rle.js && node --check uxp-v9.8/confidence-policy.js && node --check uxp-v9.8/selection-session.js && node --check uxp-v9.8/capabilities.js && node --check uxp-v9.8/planner.js && node --check uxp-v9.8/engine.js && node --check uxp-v9.8/main.js && node --check server.js",
    "test:v98": "node tests/run-v98-public.js",
    "test:v98:bridge": "node tests/run-v98-bridge.js",
    "test:v98:bridge:strict": "node tests/run-v98-bridge-strict.js",
    "release:audit": "node tools/audit-public-release.js .",
    "release:stage": "node tools/stage-public-release.js"
  };
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");
}

try {
  copyReleaseFiles();
  writePublicPackage();
  const audit = spawnSync(process.execPath, [path.join(temporary, "tools", "audit-public-release.js"), temporary], {
    cwd: temporary,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (audit.error) throw audit.error;
  if (audit.status !== 0) throw new Error(`Public release audit exited with status ${audit.status || 1}.`);

  if (auditOnly) {
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log("Public v9.8 staging artifact passed audit; audit-only staging was removed.");
  } else {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
    console.log(`Public v9.8 release staged at ${target}`);
  }
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
