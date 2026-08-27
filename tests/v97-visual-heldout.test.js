"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.7";
const sourceRoot = path.join(root, `uxp-${testVersion}`);
const fixturePath = path.join(__dirname, "fixtures", "v97-visual-heldout.json");
const protocol = require(path.join(sourceRoot, "protocol.js"));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const productionPromptSource = fs.readFileSync(path.join(sourceRoot, "engine.js"), "utf8");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function includesText(values, expected) {
  return (values || []).some((value) => String(value).includes(expected));
}

assert.strictEqual(fixture.frozen, true, "held-out suite must be explicitly frozen");
assert.strictEqual(fixture.schemaVersion, 1, "held-out fixture schema changed without an explicit migration");
assert(Array.isArray(fixture.cases) && fixture.cases.length >= 30, "held-out suite must contain at least 30 cases");

const ids = new Set();
const instructions = new Set();
const coveredAxes = new Set();
let accepted = 0;
let rejected = 0;

for (const item of fixture.cases) {
  assert(item && typeof item === "object", "every held-out case must be an object");
  assert(item.id && !ids.has(item.id), `held-out case id must be unique: ${item.id}`);
  ids.add(item.id);
  assert(item.instruction && !instructions.has(item.instruction), `held-out instruction must be unique: ${item.id}`);
  instructions.add(item.instruction);
  assert(!/[奖杯玉米]/.test(item.instruction), `${item.id} must not reuse the trophy/corn incidents`);
  assert(!productionPromptSource.includes(item.instruction), `${item.id} leaked into the production prompt`);
  assert(Array.isArray(item.axes) && item.axes.length, `${item.id} must declare evaluation axes`);
  for (const axis of item.axes) coveredAxes.add(axis);
  assert(item.planned && typeof item.planned === "object", `${item.id} must provide model-planned visual params`);
  assert(item.expect && typeof item.expect === "object", `${item.id} must provide expected behavior`);

  const expected = protocol.buildUserVisualContract(item.instruction, item.planned.description);
  const actual = protocol.buildPlannedVisualContract(item.planned);
  const audit = protocol.auditVisualContract(expected, actual);

  if (item.kind === "accept") {
    accepted += 1;
    assert.strictEqual(audit.complete, true, `${item.id} should pass: ${audit.errors.join(" | ")}`);
    const target = item.expect;
    assert.strictEqual(expected.target.scope, target.scope, `${item.id} user scope`);
    assert.strictEqual(expected.target.entity, target.entity, `${item.id} user entity`);
    assert.strictEqual(expected.target.part, target.part, `${item.id} user part`);
    assert.deepStrictEqual(expected.target.positions, target.positions, `${item.id} user positions`);
    assert.deepStrictEqual(expected.target.sourceColorFamilies, target.sourceColorFamilies, `${item.id} source colors must exclude destination colors`);
    assert.deepStrictEqual(expected.protectedRegions, target.protectedRegions, `${item.id} spatial protection roles`);
    assert.deepStrictEqual(expected.preserveAppearance, target.preserveAppearance, `${item.id} appearance-preservation roles`);
    assert.deepStrictEqual(audit.sanitizedRoles.protectedRegions, expected.protectedRegions, `${item.id} authoritative protected regions`);
    assert.deepStrictEqual(audit.sanitizedRoles.preserveAppearance, expected.preserveAppearance, `${item.id} authoritative appearance constraints`);
    if (target.warningIncludes) {
      assert(includesText(audit.warnings, target.warningIncludes), `${item.id} should warn about ${target.warningIncludes}: ${audit.warnings.join(" | ")}`);
    } else {
      assert.deepStrictEqual(audit.warnings, [], `${item.id} should not need role sanitization warnings`);
    }

    const authoritativeParams = protocol.applyAuthoritativeVisualContract(
      clone(item.planned),
      item.instruction,
      { sanitizeModelExclusions: true }
    );
    const authoritative = protocol.buildPlannedVisualContract(authoritativeParams);
    const authoritativeAudit = protocol.auditVisualContract(expected, authoritative);
    assert.strictEqual(authoritativeAudit.complete, true, `${item.id} authoritative contract must remain valid`);
    assert.deepStrictEqual(authoritative.protectedRegions, expected.protectedRegions, `${item.id} must restore user spatial protection`);
    assert.deepStrictEqual(authoritative.preserveAppearance, expected.preserveAppearance, `${item.id} must restore user appearance constraints`);
    if (target.authoritativeExcludePointCount != null) {
      assert.strictEqual((authoritativeParams.excludePoints || []).length, target.authoritativeExcludePointCount, `${item.id} exclusion-point sanitization`);
    }
  } else if (item.kind === "reject") {
    rejected += 1;
    assert.strictEqual(audit.complete, false, `${item.id} must reject an unauthorized target change`);
    assert(
      includesText(audit.errors, item.expect.errorIncludes),
      `${item.id} should report ${item.expect.errorIncludes}: ${audit.errors.join(" | ")}`
    );
  } else {
    assert.fail(`${item.id} has unsupported kind ${item.kind}`);
  }
}

for (const requiredAxis of [
  "whole_object",
  "subpart",
  "multiple_instances",
  "source_color_locator",
  "destination_color_leak",
  "spatial_protection",
  "appearance",
  "negation",
  "description_addition",
  "description_omission",
  "wrong_object",
  "wrong_part",
  "wrong_position",
  "wrong_scope"
]) {
  assert(coveredAxes.has(requiredAxis), `held-out suite is missing required axis ${requiredAxis}`);
}

assert(accepted >= 15, "held-out suite needs a substantial positive set");
assert(rejected >= 15, "held-out suite needs a substantial adversarial set");
console.log(`${testVersion} frozen visual held-out suite passed (${fixture.cases.length} cases: ${accepted} accept, ${rejected} reject)`);
