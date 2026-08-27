"use strict";

const fs = require("fs");
const path = require("path");

const PUBLIC_RELEASE_FILES = Object.freeze([
  ".gitignore",
  ".github/workflows/ci.yml",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "package.json",
  "server.js",
  "config.example.json",
  "requirements-segmentation.txt",
  "Install-UxpV98.ps1",
  "Start-PhotoshopAgentV98.ps1",
  "Install-GlobalExtension.ps1",
  "Start-PhotoshopAgent.ps1",
  "Register-StartupShortcut.ps1",
  "Build-Ccx.ps1",
  "Install-Ccx.ps1",
  "docs/ARCHITECTURE.md",
  "docs/MODELS.md",
  "docs/PRIVACY.md",
  "docs/LIMITATIONS.md",
  "segmentation/mobilesam_segment.py",
  "segmentation/mobilesam_worker.py",
  "segmentation/mobilesam-model-manifest.json",
  "segmentation/reference_match.py",
  "tools/Verify-MobileSAMModels.ps1",
  "tools/audit-public-release.js",
  "tools/stage-public-release.js",
  "tests/run-v98-public.js",
  "tests/run-v98-bridge.js",
  "tests/run-v98-bridge-strict.js",
  "tests/v97-live-bridge-segmentation.test.js",
  "tests/visual-object-fixture.png",
  "tests/v98-bridge-regression.test.js",
  "tests/v98-capability-local-effects.test.js",
  "tests/v98-capability-selection-guard.test.js",
  "tests/v98-confidence-flow.test.js",
  "tests/v98-installer-upgrade.test.js",
  "tests/v98-main-concurrency.test.js",
  "tests/v98-multitarget-failure.test.js",
  "tests/v98-planning-regression.test.js",
  "tests/v98-reference-match.test.js",
  "tests/v98-release-audit.test.js",
  "tests/v98-release-entrypoints.test.js",
  "tests/v98-selection-session.test.js",
  "tests/v98-state-descriptor-resilience.test.js",
  "tests/v98-state-evidence.test.js",
  "tests/v95-model-providers.test.js",
  "tests/v95-protocol.test.js",
  "tests/v9-planner.test.js",
  "tests/v9-engine.test.js",
  "tests/v95-text-units.test.js",
  "tests/v95-capability-parity.test.js",
  "tests/v9-planning-integration.test.js",
  "tests/v9-state.test.js",
  "tests/v97-cropped-rle.test.js",
  "tests/v97-selection-contract.test.js",
  "tests/v97-visual-heldout.test.js",
  "tests/fixtures/v97-visual-heldout.json",
  "tests/v97-selection-rebase-execution.test.js",
  "tests/v97-audit-contract.test.js",
  "tests/v97-outcome-messaging.test.js",
  "tests/v97-static.test.js",
  "tests/v95-public-segmentation.test.js",
  "tests/v95-protection-unit.py",
  "uxp-v9.8/manifest.json",
  "uxp-v9.8/index.html",
  "uxp-v9.8/styles.css",
  "uxp-v9.8/model-providers.js",
  "uxp-v9.8/visual-contract.js",
  "uxp-v9.8/protocol.js",
  "uxp-v9.8/state-engine.js",
  "uxp-v9.8/mask-rle.js",
  "uxp-v9.8/confidence-policy.js",
  "uxp-v9.8/selection-session.js",
  "uxp-v9.8/capabilities.js",
  "uxp-v9.8/planner.js",
  "uxp-v9.8/engine.js",
  "uxp-v9.8/main.js"
]);

const TEXT_EXTENSIONS = new Set([".js", ".json", ".md", ".ps1", ".py", ".txt", ".html", ".css", ".svg", ".yml", ".yaml"]);
const FORBIDDEN_BASENAMES = new Set(["config.local.json", ".env", "bridge-token.js", "bridge-token.json"]);
const FORBIDDEN_EXTENSIONS = new Set([".psd", ".psb", ".onnx", ".pt", ".pth", ".key", ".pem", ".p12"]);
const PRIVATE_NETWORK_FIXTURES = new Set([
  "tests/v98-release-audit.test.js"
]);
const PRIVATE_NETWORK_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
const SECRET_PATTERNS = Object.freeze([
  [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/, "resembles an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "resembles an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, "resembles a Google API key"],
  [/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/, "resembles a GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "resembles a Slack token"],
  [/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, "contains a private key"],
  [/PS_AGENT_BRIDGE_TOKEN\s*=\s*["'][A-Za-z0-9_-]{32,}["']/, "contains a hard-coded bridge token"]
]);

function slash(value) {
  return String(value || "").split(path.sep).join("/");
}

function safeReleasePath(root, rel) {
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error(`Release path escaped root: ${rel}`);
  return file;
}

function unique(values) {
  return [...new Set(values)];
}

function hasAllowedGenericInstallPath(rel, line) {
  if (!new Set(["Install-UxpV98.ps1", "Start-PhotoshopAgentV98.ps1"]).has(rel)) return false;
  const normalized = line.replace(/\\\\/g, "\\").replace(/\//g, "\\");
  const publicInstallPath = [
    "C:", "Program Files", "Common Files", "Adobe", "UXP", "extensions",
    "com.local.photoshop.assistant.v8-0.8.0"
  ].join("\\");
  return normalized.includes(publicInstallPath);
}

function absolutePathFailures(rel, source) {
  const failures = [];
  const windows = /\b[A-Za-z]:[\\/]{1,2}/g;
  for (const match of source.matchAll(windows)) {
    const start = source.lastIndexOf("\n", match.index) + 1;
    const endIndex = source.indexOf("\n", match.index);
    const line = source.slice(start, endIndex < 0 ? source.length : endIndex);
    if (!hasAllowedGenericInstallPath(rel, line)) {
      failures.push(`${rel}: contains an absolute local filesystem path`);
      break;
    }
  }
  if (/(?:^|[\s"'`(])\/(?:Users|home|mnt|Volumes|tmp)\/[A-Za-z0-9_.-]+/m.test(source)) {
    failures.push(`${rel}: contains an absolute local filesystem path`);
  }
  return failures;
}

function scanText(rel, source) {
  const normalizedRel = slash(rel);
  const failures = [];
  if (source.includes("\uFFFD")) failures.push(`${normalizedRel}: contains Unicode replacement characters`);
  if (PRIVATE_NETWORK_PATTERN.test(source) && !PRIVATE_NETWORK_FIXTURES.has(normalizedRel)) {
    failures.push(`${normalizedRel}: contains a private network address`);
  }
  for (const [pattern, reason] of SECRET_PATTERNS) {
    if (pattern.test(source)) failures.push(`${normalizedRel}: ${reason}`);
  }
  failures.push(...absolutePathFailures(normalizedRel, source));
  return unique(failures);
}

function validateExampleConfig(source, rel = "config.example.json") {
  const failures = [];
  let parsed;
  try {
    parsed = JSON.parse(String(source || "").replace(/^\uFEFF/, ""));
  } catch (error) {
    return [`${rel}: invalid JSON (${error.message})`];
  }
  function visit(value, trail) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...trail, key];
      if (/(?:api.?key|access.?token|password|secret)/i.test(key)
        && typeof child === "string" && child.trim()) {
        failures.push(`${rel}: ${next.join(".")} must be empty in public configuration`);
      }
      visit(child, next);
    }
  }
  visit(parsed, []);
  return failures;
}

function inspectReleaseFile(root, rel) {
  const normalizedRel = slash(rel);
  const file = safeReleasePath(root, normalizedRel);
  const failures = [];
  const basename = path.basename(file);
  const extension = path.extname(file).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(basename)) failures.push(`${normalizedRel}: private configuration must not be published`);
  if (FORBIDDEN_EXTENSIONS.has(extension)) failures.push(`${normalizedRel}: binary, credential, or user document is forbidden`);
  if (!fs.existsSync(file)) {
    failures.push(`${normalizedRel}: required public file is missing`);
    return failures;
  }
  const fileStat = fs.lstatSync(file);
  if (fileStat.isSymbolicLink()) {
    failures.push(`${normalizedRel}: symbolic links are forbidden in a public release`);
    return failures;
  }
  if (!fileStat.isFile()) {
    failures.push(`${normalizedRel}: required public path is not a file`);
    return failures;
  }
  if (!TEXT_EXTENSIONS.has(extension)) return failures;
  const source = fs.readFileSync(file, "utf8");
  failures.push(...scanText(normalizedRel, source));
  if (normalizedRel === "config.example.json") failures.push(...validateExampleConfig(source, normalizedRel));
  return failures;
}

function listReleaseEntries(root) {
  const entries = [];
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // A GitHub checkout necessarily contains repository metadata. It is not
      // part of the published source tree and must never be scanned as a
      // release payload.
      if (!prefix && entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, rel);
      else entries.push({ rel: slash(rel), symbolicLink: entry.isSymbolicLink() });
    }
  }
  visit(root, "");
  return entries;
}

function auditRelease(rootValue, options = {}) {
  const root = path.resolve(rootValue || ".");
  const failures = [];
  if (new Set(PUBLIC_RELEASE_FILES).size !== PUBLIC_RELEASE_FILES.length) failures.push("public release manifest contains duplicate entries");
  try {
    const allowed = new Set(PUBLIC_RELEASE_FILES);
    for (const entry of listReleaseEntries(root)) {
      if (entry.symbolicLink) failures.push(`${entry.rel}: symbolic links are forbidden in a public release`);
      if (!allowed.has(entry.rel)) failures.push(`${entry.rel}: unexpected file is not in the public release manifest`);
    }
  } catch (error) {
    failures.push(`release tree enumeration failed (${error.message})`);
  }
  for (const rel of PUBLIC_RELEASE_FILES) failures.push(...inspectReleaseFile(root, rel));

  try {
    const manifest = JSON.parse(fs.readFileSync(safeReleasePath(root, "uxp-v9.8/manifest.json"), "utf8"));
    if (manifest.version !== "0.9.8") failures.push("uxp-v9.8/manifest.json: expected version 0.9.8");
    if (manifest.main !== "index.html") failures.push("uxp-v9.8/manifest.json: expected index.html entrypoint");
  } catch (error) {
    failures.push(`uxp-v9.8/manifest.json: JSON validation failed (${error.message})`);
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(safeReleasePath(root, "package.json"), "utf8"));
    if (packageJson.version !== "0.9.8") failures.push("package.json: expected version 0.9.8");
    const scripts = packageJson.scripts || {};
    if (scripts.test !== "npm run test:v98") failures.push("package.json: default test must target v9.8");
    if (scripts.check !== "npm run check:v98") failures.push("package.json: default check must target v9.8");
    for (const name of ["check:v98", "test:v98", "release:audit"]) {
      if (!scripts[name]) failures.push(`package.json: missing public script ${name}`);
    }
    if (Object.keys(scripts).some((name) => /private/i.test(name))) failures.push("package.json: private test command must not be published");
  } catch (error) {
    failures.push(`package.json: JSON validation failed (${error.message})`);
  }

  try {
    const runner = fs.readFileSync(safeReleasePath(root, "tests/run-v98-public.js"), "utf8");
    const referencedTests = [...runner.matchAll(/["']([^"']+\.(?:test\.js|py))["']/g)]
      .map((match) => `tests/${match[1]}`);
    for (const rel of referencedTests) {
      if (!PUBLIC_RELEASE_FILES.includes(rel)) failures.push(`release manifest is missing runner dependency: ${rel}`);
    }
    for (const rel of PUBLIC_RELEASE_FILES.filter((item) => /^tests\/v98-.*\.test\.js$/.test(item))) {
      if (!fs.existsSync(safeReleasePath(root, rel))) failures.push(`v9.8 runner discovery target is missing: ${rel}`);
    }
  } catch (error) {
    failures.push(`tests/run-v98-public.js: dependency validation failed (${error.message})`);
  }

  const result = { root, files: [...PUBLIC_RELEASE_FILES], failures: unique(failures) };
  if (!options.quiet) {
    if (result.failures.length) console.error("Public release audit failed:\n- " + result.failures.join("\n- "));
    else console.log(`Public v9.8 release audit passed (${result.files.length} files): ${root}`);
  }
  return result;
}

if (require.main === module) {
  const result = auditRelease(process.argv[2] || ".");
  if (result.failures.length) process.exit(1);
}

module.exports = {
  PUBLIC_RELEASE_FILES,
  auditRelease,
  scanText,
  validateExampleConfig
};
