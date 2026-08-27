"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const historicalScripts = [
  "v95-model-providers.test.js",
  "v95-protocol.test.js",
  "v9-planner.test.js",
  "v9-engine.test.js",
  "v9-planning-integration.test.js",
  "v9-state.test.js",
  "v95-capability-parity.test.js",
  "v95-text-units.test.js",
  "v97-cropped-rle.test.js",
  "v97-selection-contract.test.js",
  "v97-visual-heldout.test.js",
  "v97-selection-rebase-execution.test.js",
  "v97-audit-contract.test.js",
  "v97-outcome-messaging.test.js",
  "v97-static.test.js",
  "v95-public-segmentation.test.js"
];
const v98Scripts = fs.readdirSync(__dirname)
  .filter((name) => /^v98-.*\.test\.js$/.test(name))
  .sort();
const scripts = [...historicalScripts, ...v98Scripts];

if (!v98Scripts.length) throw new Error("No v9.8 regression tests were discovered.");

for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: root,
    env: { ...process.env, PS_AGENT_TEST_VERSION: "v9.8" },
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`v9.8 public/offline regression suite passed (${historicalScripts.length} historical groups + ${v98Scripts.length} v9.8 groups; Photoshop host checks are separate)`);
