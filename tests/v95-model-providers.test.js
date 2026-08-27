"use strict";

const assert = require("assert");
const testVersion = process.env.PS_AGENT_TEST_VERSION || "v9.5";
const providers = require(`../uxp-${testVersion}/model-providers.js`);

const expectedIds = [
  "qwen", "kimi", "deepseek", "zhipu", "doubao", "minimax",
  "siliconflow", "baidu", "tencent", "gemini", "openai", "tokensea"
];
assert.deepStrictEqual(providers.providerIds(), expectedIds);

for (const providerId of expectedIds) {
  const provider = providers.getProvider(providerId);
  const requestedModel = providerId === "tokensea" ? "test-model" : provider.defaultModel;
  const request = providers.buildRequest({
    providerId,
    modelId: requestedModel,
    apiKey: "test-key",
    system: "Return JSON.",
    userContent: "test",
    maxTokens: 400
  });
  assert.strictEqual(request.providerId, providerId);
  assert.strictEqual(request.modelId, requestedModel);
  assert.ok(request.url.startsWith(providerId === "tokensea" ? "http://127.0.0.1:39210/gateway/v1/" : "https://"));
  assert.strictEqual(request.timeoutMs, 300000);
  if (providerId === "gemini") {
    assert.strictEqual(request.headers["x-goog-api-key"], "test-key");
    assert.ok(request.url.includes(":generateContent"));
    assert.ok(Array.isArray(request.body.contents));
  } else {
    assert.strictEqual(request.headers.Authorization, "Bearer test-key");
    assert.strictEqual(request.body.model, requestedModel);
    assert.ok(Array.isArray(request.body.messages));
  }

  const response = providerId === "gemini"
    ? { candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }], request_id: "gemini-1" }
    : { choices: [{ message: { content: "{\"ok\":true}" } }], id: `${providerId}-1` };
  const parsed = providers.parseResponse(providerId, response);
  assert.strictEqual(parsed.content, "{\"ok\":true}");
}

const tokenseaModelsRequest = providers.buildModelsRequest("tokensea", "tokensea-key");
assert.strictEqual(tokenseaModelsRequest.url, "http://127.0.0.1:39210/gateway/v1/models");
assert.strictEqual(tokenseaModelsRequest.headers.Authorization, "Bearer tokensea-key");
assert.deepStrictEqual(
  providers.parseModelsResponse("tokensea", { data: [{ id: "vision-model" }, { id: "text-model" }] }),
  ["vision-model", "text-model"]
);
const tokenseaRequest = providers.buildRequest({
  providerId: "tokensea",
  modelId: "vision-model",
  apiKey: "tokensea-key",
  system: "Return JSON.",
  userContent: "test"
});
assert.strictEqual(tokenseaRequest.modelId, "vision-model");
assert.strictEqual(tokenseaRequest.url, "http://127.0.0.1:39210/gateway/v1/chat/completions");
assert.strictEqual(tokenseaRequest.body.temperature, 1, "Tokensea-compatible models require temperature=1");
assert.throws(() => providers.buildRequest({
  providerId: "tokensea",
  modelId: "auto",
  apiKey: "tokensea-key",
  system: "Return JSON.",
  userContent: "test"
}), /Tokensea/);

const customTokenseaRequest = providers.buildRequest({
  providerId: "tokensea",
  modelId: "vision-model",
  apiKey: "tokensea-key",
  apiUrl: "http://custom.test/v1/chat/completions",
  system: "Return JSON.",
  userContent: "test"
});
assert.strictEqual(customTokenseaRequest.url, "http://custom.test/v1/chat/completions");
const customTokenseaModelsRequest = providers.buildModelsRequest("tokensea", "tokensea-key", {
  modelsUrl: "http://custom.test/v1/models"
});
assert.strictEqual(customTokenseaModelsRequest.url, "http://custom.test/v1/models");

if (typeof providers.parseModelsCatalog === "function") {
  const internalK3 = providers.parseModelsCatalog("tokensea", { data: [{ id: "k3" }] });
  assert.deepStrictEqual(internalK3, [{ id: "k3", vision: true, capabilityKnown: true }],
    "the internal Kimi K3 relay must remain image-capable even when /models omits modality metadata");
  const resolvedInternalK3 = providers.resolveModel("tokensea", "k3", { k3: null });
  assert.strictEqual(resolvedInternalK3.vision, true);
  assert.strictEqual(resolvedInternalK3.capabilityKnown, true);
  assert.strictEqual(resolvedInternalK3.capabilitySource, "trusted_relay_model");

  const explicitlyTextOnlyK3 = providers.parseModelsCatalog("tokensea", {
    data: [{ id: "k3", vision: false }]
  });
  assert.deepStrictEqual(explicitlyTextOnlyK3, [{ id: "k3", vision: false, capabilityKnown: true }],
    "an explicit server text-only declaration must override the relay compatibility rule");
  assert.strictEqual(providers.resolveModel("tokensea", "k3", { k3: false }).vision, false);

  const unrelatedUnknown = providers.parseModelsCatalog("tokensea", { data: [{ id: "unknown-model" }] });
  assert.deepStrictEqual(unrelatedUnknown, [{ id: "unknown-model", vision: null, capabilityKnown: false }],
    "unrelated undeclared models must remain fail-closed");
  const generationOnly = providers.parseModelsCatalog("qwen", {
    data: [{ id: "generation-only", capabilities: ["image_generation"] }]
  });
  assert.deepStrictEqual(generationOnly, [{ id: "generation-only", vision: null, capabilityKnown: false }],
    "image generation metadata must not be mistaken for image input support");
}

const geminiVision = providers.buildRequest({
  providerId: "gemini",
  modelId: providers.getProvider("gemini").defaultModel,
  apiKey: "test-key",
  system: "Inspect.",
  userContent: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ]
});
assert.strictEqual(geminiVision.body.contents[0].parts[1].inline_data.mime_type, "image/png");

const envelope = providers.proxyEnvelope({
  providerId: "kimi",
  modelId: "kimi-k3",
  apiKey: "secret",
  stage: "planning",
  system: "system",
  userContent: "user"
});
assert.strictEqual(envelope.__providerId, "kimi");
assert.ok(!("__apiUrl" in envelope));

const kimiK26Request = providers.buildRequest({
  providerId: "kimi",
  modelId: "kimi-k2.6",
  apiKey: "test-key",
  system: "Return JSON.",
  userContent: "test"
});
assert.deepStrictEqual(kimiK26Request.body.thinking, { type: "disabled" });
assert.ok(!("temperature" in kimiK26Request.body), "Kimi K2.6 rejects explicit temperature");

const kimiK3Request = providers.buildRequest({
  providerId: "kimi",
  modelId: "kimi-k3",
  apiKey: "test-key",
  system: "Return JSON.",
  userContent: "test"
});
assert.strictEqual(kimiK3Request.body.temperature, 1, "Kimi K3 requires temperature=1");

const qwenRequest = providers.buildRequest({
  providerId: "qwen",
  modelId: providers.getProvider("qwen").defaultModel,
  apiKey: "test-key",
  system: "Return JSON.",
  userContent: "test"
});
assert.strictEqual(qwenRequest.body.temperature, 0, "Qwen planning should stay deterministic");

assert.strictEqual(providers.normalizeSettings({ apiKey: "old", model: "kimi-k2.6" }).providerId, "kimi");
assert.strictEqual(providers.normalizeSettings({ apiKey: "old", model: "kimi-k2.6" }).apiKeys.kimi, "old");
assert.throws(() => providers.buildRequest({
  providerId: "qwen",
  modelId: providers.getProvider("qwen").defaultModel,
  apiKey: ""
}), /\u8bf7\u586b\u5199/);

console.log(`${testVersion} provider contract tests passed: ${expectedIds.length} providers`);
