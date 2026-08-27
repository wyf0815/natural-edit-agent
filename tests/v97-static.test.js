"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const semanticVersion = testVersion.replace(/^v/, "");
const manifestVersion = `0.${semanticVersion}`;
const sourceRoot = path.join(root, `uxp-${testVersion}`);
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const readRoot = (file) => fs.readFileSync(path.join(root, file), "utf8");

const pluginFiles = [
  "model-providers.js", "visual-contract.js", "protocol.js", "state-engine.js", "mask-rle.js",
  "confidence-policy.js", "selection-session.js", "capabilities.js", "planner.js",
  "engine.js", "main.js", "index.html", "styles.css", "manifest.json"
];
for (const file of pluginFiles) {
  assert(!read(file).includes("\uFFFD"), `${file} contains a Unicode replacement character`);
}

const manifest = JSON.parse(read("manifest.json"));
assert.strictEqual(manifest.version, manifestVersion);
assert.strictEqual(manifest.main, "index.html");

const html = read("index.html");
for (const script of ["visual-contract.js", "mask-rle.js", "confidence-policy.js", "selection-session.js", "capabilities.js", "main.js"]) {
  assert(html.includes(`<script src="${script}"></script>`), `index.html must load ${script}`);
}
assert(html.indexOf('<script src="confidence-policy.js"></script>') < html.indexOf('<script src="main.js"></script>'));
assert(html.indexOf('<script src="selection-session.js"></script>') < html.indexOf('<script src="capabilities.js"></script>'));
assert(html.indexOf('<script src="visual-contract.js"></script>') < html.indexOf('<script src="protocol.js"></script>'));
for (const id of [
  "targetPreviewCanvas", "confirmCandidate", "adoptCurrentSelection", "nativeSelectionHelp",
  "lassoReplace", "lassoAdd", "lassoSubtract", "lassoIntersect", "acceptLowConfidence",
  "confirmHighRisk"
]) {
  assert(html.includes(`id="${id}"`), `index.html is missing #${id}`);
}

const protocol = read("protocol.js");
assert(protocol.includes(`version: "${semanticVersion}"`));
assert(protocol.includes("percent固定0..100，normalized固定0..1"), "coordinate units must be explicit");
assert(protocol.includes('new Set(["pixels", "percent", "normalized"])'));
assert(protocol.includes("buildUserVisualContract"), "protocol must expose the structured visual contract");

const visualContract = read("visual-contract.js");
for (const role of ["target", "protectedRegions", "preserveAppearance"]) {
  assert(visualContract.includes(role), `visual contract must separate ${role}`);
}

const engine = read("engine.js");
assert(!engine.includes("示例：用户说"), "production prompts must not contain copied acceptance-test sentences");

const main = read("main.js");
assert(main.includes(`const REQUIRED_BRIDGE_VERSION = "${manifestVersion}"`));
assert(main.includes('localStorage.getItem("bridgeToken")'));
assert(main.includes('requestOptions.headers["X-PS-Agent-Token"] = token'), "every plugin bridge request must carry the private token");
assert(main.includes("SELECTION_PROVIDER_ACTIONS"));
for (const action of [
  "selection.select_all", "selection.rectangle", "selection.ellipse", "selection.polygon",
  "selection.subject", "selection.subject_region", "selection.color_range",
  "selection.visual_object", "selection.load_layer"
]) {
  assert(main.includes(`"${action}"`), `${action} must enter the confirmation/session workflow`);
}
assert(main.includes("const target = params.targetBox || null"), "subject_region preview must not dereference a missing targetBox");
assert(main.includes("selectionSessions.setLowConfidenceAccepted"));
assert(main.includes("selectionSessions.applyPolygon"));
assert(main.includes("selectionSessions.restore"));
assert(main.includes("!step.params.selectionSessionToken"), "execution must require a locked authoritative selection");
assert(main.includes("sanitizeModelExclusions: true"), "initial model and verifier exclusions must be sanitized before segmentation");
assert(main.includes("protocol.hasExplicitVisualSpatialProtection"), "appearance preservation must not be mistaken for a spatial exclusion");
assert(main.includes("青色虚线框和红点只是模型定位参考，不是 Photoshop 选区"), "location hints must not be presented as an executable selection");
assert(main.includes('confirmButton.textContent = session ? "这个选区正确" : "尚未生成选区"'), "confirmation must visibly distinguish a real selection from location-only hints");
assert(main.includes("abortController.abort()") || main.includes("controller.abort()"), "the UI must expose cancellation to bridge requests");

const server = readRoot("server.js");
const packageJson = JSON.parse(readRoot("package.json"));
const currentSemanticVersion = packageJson.version.replace(/^0\./, "");
assert(server.includes(`const BRIDGE_VERSION = "${packageJson.version}"`));
assert(server.includes(`require("./uxp-v${currentSemanticVersion}/model-providers.js")`));
assert(server.includes("PS_AGENT_BRIDGE_TOKEN"));
assert(server.includes('req.headers["x-ps-agent-token"]'));
assert(server.includes("timingSafeEqual"));
assert(server.includes("LOCAL_CONFIG_INVALID"));
assert(server.includes("PROVIDER_ENDPOINT_UNSAFE"));
assert(server.includes("SEGMENTATION_CANCELLED"));
assert(server.includes("rle-cropped-v1") || readRoot("segmentation/mobilesam_segment.py").includes("rle-cropped-v1"));
assert(!server.includes('"Access-Control-Allow-Origin": "*"'));

const releaseSuffix = semanticVersion.replace(/\./g, "");
const scriptVersion = `v${releaseSuffix}`;
const installer = readRoot(`Install-UxpV${releaseSuffix}.ps1`);
assert(installer.includes(`Join-Path $pluginRoot "uxp-${testVersion}"`));
assert(installer.includes(`$manifest.version -ne "${manifestVersion}"`));
assert(installer.includes('"confidence-policy.js"'));
assert(installer.includes('"selection-session.js"'));
assert(installer.includes('"visual-contract.js"'));
assert(installer.includes("RandomNumberGenerator"));
assert(installer.includes('"bridge-token.js"'));
assert(!/PS_AGENT_BRIDGE_TOKEN\s*=\s*["'][0-9a-f]{64}["']/i.test(installer), "installer must not contain a real token");

const launcher = readRoot(`Start-PhotoshopAgentV${releaseSuffix}.ps1`);
assert(launcher.includes(`$requiredBridgeVersion = "${manifestVersion}"`));
assert(launcher.includes("PS_AGENT_BRIDGE_TOKEN"));
assert(launcher.includes("X-PS-Agent-Token"));
assert(launcher.includes("RandomNumberGenerator"));
assert(launcher.includes("-WindowStyle Hidden"));
assert(launcher.includes("Start-Process -FilePath $Node"));
assert(launcher.includes(`Refusing to inject a ${testVersion} bridge token`));

const verifier = readRoot("tools/Verify-MobileSAMModels.ps1");
for (const value of [
  "28157093", "580F5FB648EA1062C0AABC26217AED56921985F03F0CBBD852BBA81D760CC749",
  "16501323", "93915FC7C993AB9D59AB8C9CCD3BCE37F7509C81AB4150A74ABD4D2ABBD8570D"
]) {
  assert(verifier.includes(value));
}
assert(verifier.includes("AllowUnverifiedModels"));
assert(verifier.includes("test:v98:bridge:strict"));
const modelManifest = JSON.parse(readRoot("segmentation/mobilesam-model-manifest.json"));
assert.deepStrictEqual(modelManifest.files, {
  "mobile_sam_image_encoder.onnx": {
    size: 28157093,
    sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
  },
  "sam_mask_decoder_single.onnx": {
    size: 16501323,
    sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d"
  }
});

assert.strictEqual(packageJson.version, "0.9.8");
assert.strictEqual(packageJson.scripts.test, "npm run test:v98");
assert(packageJson.scripts.check.includes("check:v98"));
assert(packageJson.scripts[`check:${scriptVersion}`].includes("visual-contract.js"));
assert(packageJson.scripts[`test:${scriptVersion}:bridge`]);
assert(packageJson.scripts[`test:${scriptVersion}:bridge:strict`]);
if (testVersion === "v9.7") assert(packageJson.scripts["test:v97:photoshop:manual"]);

const gitignore = readRoot(".gitignore");
for (const pattern of ["bridge-token.js", "bridge-token.json"]) {
  assert(gitignore.includes(pattern), `.gitignore must exclude ${pattern}`);
}

console.log(`${testVersion} static plugin wiring, confirmation gate, bridge security, installer, model baseline, and release-entrypoint checks passed`);
