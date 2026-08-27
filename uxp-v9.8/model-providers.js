"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PhotoshopAssistantV8Models = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function model(id, label, vision, metadata) {
    return Object.freeze({
      id,
      label,
      vision: Boolean(vision),
      capabilityKnown: metadata && metadata.capabilityKnown === false ? false : true,
      capabilitySource: metadata && metadata.source || "curated"
    });
  }

  function provider(value) {
    return Object.freeze({
      transport: "openai",
      verificationModel: null,
      supportsJsonMode: true,
      modelsUrl: null,
      discoversModels: false,
      customModelVision: false,
      timeoutMs: 300000,
      ...value,
      models: Object.freeze(value.models)
    });
  }

  const PROVIDERS = Object.freeze({
    qwen: provider({
      id: "qwen",
      label: "\u5343\u95ee\uff08\u963f\u91cc\u4e91\u767e\u70bc\uff09",
      apiKeyLabel: "\u963f\u91cc\u4e91\u767e\u70bc API Key",
      apiKeyPlaceholder: "sk-...",
      apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      defaultModel: "qwen3.7-plus",
      verificationModel: "qwen3.6-flash",
      models: [
        model("qwen3.7-plus", "Qwen3.7 Plus (\u63a8\u8350\uff0c\u652f\u6301\u56fe\u7247)", true),
        model("qwen3.7-max", "Qwen3.7 Max (\u6587\u672c\u89c4\u5212)", false),
        model("qwen3.6-plus", "Qwen3.6 Plus (\u652f\u6301\u56fe\u7247)", true),
        model("qwen3.6-flash", "Qwen3.6 Flash (\u5feb\u901f\uff0c\u652f\u6301\u56fe\u7247)", true)
      ]
    }),
    kimi: provider({
      id: "kimi",
      label: "Kimi (\u6708\u4e4b\u6697\u9762)",
      apiKeyLabel: "Kimi API Key",
      apiKeyPlaceholder: "Moonshot API Key",
      apiUrl: "https://api.moonshot.cn/v1/chat/completions",
      defaultModel: "kimi-k3",
      verificationModel: "kimi-k2.6",
      timeoutMs: 300000,
      models: [
        model("kimi-k3", "Kimi K3 (\u63a8\u8350\uff0c\u652f\u6301\u56fe\u7247)", true),
        model("kimi-k2.6", "Kimi K2.6 (\u652f\u6301\u56fe\u7247)", true),
        model("kimi-k2.7-code", "Kimi K2.7 Code (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    deepseek: provider({
      id: "deepseek",
      label: "DeepSeek",
      apiKeyLabel: "DeepSeek API Key",
      apiKeyPlaceholder: "sk-...",
      apiUrl: "https://api.deepseek.com/chat/completions",
      defaultModel: "deepseek-chat",
      models: [
        model("deepseek-chat", "DeepSeek Chat (\u6587\u672c\u89c4\u5212)", false),
        model("deepseek-reasoner", "DeepSeek Reasoner (\u6df1\u5ea6\u89c4\u5212)", false)
      ]
    }),
    zhipu: provider({
      id: "zhipu",
      label: "\u667a\u8c31 GLM",
      apiKeyLabel: "\u667a\u8c31 API Key",
      apiKeyPlaceholder: "\u667a\u8c31\u5f00\u653e\u5e73\u53f0 API Key",
      apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      defaultModel: "glm-4.6v",
      verificationModel: "glm-4.6v",
      models: [
        model("glm-4.6v", "GLM-4.6V (\u652f\u6301\u56fe\u7247)", true),
        model("glm-5.2", "GLM-5.2 (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    doubao: provider({
      id: "doubao",
      label: "\u8c46\u5305\uff08\u706b\u5c71\u65b9\u821f\uff09",
      apiKeyLabel: "\u706b\u5c71\u65b9\u821f API Key",
      apiKeyPlaceholder: "\u706b\u5c71\u65b9\u821f API Key",
      apiUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      defaultModel: "doubao-seed-2-0-lite-260215",
      verificationModel: "doubao-seed-2-0-lite-260215",
      models: [
        model("doubao-seed-2-0-lite-260215", "Doubao Seed 2.0 Lite (\u652f\u6301\u56fe\u7247)", true)
      ]
    }),
    minimax: provider({
      id: "minimax",
      label: "MiniMax",
      apiKeyLabel: "MiniMax API Key",
      apiKeyPlaceholder: "MiniMax API Key",
      apiUrl: "https://api.minimaxi.com/v1/chat/completions",
      defaultModel: "MiniMax-M2.7",
      models: [
        model("MiniMax-M2.7", "MiniMax M2.7 (\u6587\u672c\u89c4\u5212)", false),
        model("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed", false),
        model("MiniMax-M2.5", "MiniMax M2.5 (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    siliconflow: provider({
      id: "siliconflow",
      label: "\u7845\u57fa\u6d41\u52a8",
      apiKeyLabel: "\u7845\u57fa\u6d41\u52a8 API Key",
      apiKeyPlaceholder: "sk-...",
      apiUrl: "https://api.siliconflow.cn/v1/chat/completions",
      defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct",
      verificationModel: "Qwen/Qwen2.5-VL-72B-Instruct",
      models: [
        model("Qwen/Qwen2.5-VL-72B-Instruct", "Qwen2.5 VL 72B (\u652f\u6301\u56fe\u7247)", true),
        model("Pro/zai-org/GLM-4.7", "GLM-4.7 Pro (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    baidu: provider({
      id: "baidu",
      label: "\u767e\u5ea6\u5343\u5e06",
      apiKeyLabel: "\u767e\u5ea6\u5343\u5e06 API Key",
      apiKeyPlaceholder: "\u767e\u5ea6\u5343\u5e06 API Key",
      apiUrl: "https://qianfan.baidubce.com/v2/chat/completions",
      defaultModel: "ernie-5.0",
      verificationModel: "ernie-5.0",
      models: [
        model("ernie-5.0", "ERNIE 5.0 (\u652f\u6301\u56fe\u7247)", true),
        model("deepseek-v4-pro", "DeepSeek V4 Pro (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    tencent: provider({
      id: "tencent",
      label: "\u817e\u8baf\u6df7\u5143",
      apiKeyLabel: "\u817e\u8baf\u6df7\u5143 API Key",
      apiKeyPlaceholder: "\u817e\u8baf\u6df7\u5143 API Key",
      apiUrl: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
      defaultModel: "hunyuan-vision",
      verificationModel: "hunyuan-vision",
      supportsJsonMode: false,
      models: [
        model("hunyuan-vision", "\u6df7\u5143 Vision (\u652f\u6301\u56fe\u7247)", true),
        model("hunyuan-turbos-latest", "\u6df7\u5143 TurboS (\u6587\u672c\u89c4\u5212)", false)
      ]
    }),
    gemini: provider({
      id: "gemini",
      label: "Google Gemini",
      apiKeyLabel: "Gemini API Key",
      apiKeyPlaceholder: "Google AI Studio API Key",
      transport: "gemini",
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      defaultModel: "gemini-3.6-flash",
      verificationModel: "gemini-3.6-flash",
      models: [
        model("gemini-3.6-flash", "Gemini 3.6 Flash (\u652f\u6301\u56fe\u7247)", true)
      ]
    }),
    openai: provider({
      id: "openai",
      label: "OpenAI",
      apiKeyLabel: "OpenAI API Key",
      apiKeyPlaceholder: "sk-...",
      apiUrl: "https://api.openai.com/v1/chat/completions",
      defaultModel: "gpt-4.1",
      verificationModel: "gpt-4.1-mini",
      models: [
        model("gpt-4.1", "GPT-4.1 (\u652f\u6301\u56fe\u7247)", true),
        model("gpt-4.1-mini", "GPT-4.1 mini (\u5feb\u901f\uff0c\u652f\u6301\u56fe\u7247)", true)
      ]
    }),
    tokensea: provider({
      id: "tokensea",
      label: "Tokensea",
      apiKeyLabel: "Tokensea API Key",
      apiKeyPlaceholder: "Tokensea API Key",
      apiUrl: "http://127.0.0.1:39210/gateway/v1/chat/completions",
      modelsUrl: "http://127.0.0.1:39210/gateway/v1/models",
      discoversModels: true,
      // A discovered model is not assumed to accept images. The models API
      // must declare it, or the user must explicitly opt in after a probe.
      customModelVision: false,
      defaultModel: "auto",
      models: [
        model("auto", "\u4fdd\u5b58 Key \u540e\u81ea\u52a8\u8bfb\u53d6\u6a21\u578b", false, { capabilityKnown: false, source: "discovery_pending" })
      ]
    })
  });

  function providerIds() {
    return Object.keys(PROVIDERS);
  }

  function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS.qwen;
  }

  function inferProviderId(modelId) {
    const value = String(modelId || "").toLowerCase();
    if (value.startsWith("kimi") || value.startsWith("moonshot")) return "kimi";
    if (value.startsWith("deepseek")) return "deepseek";
    if (value.startsWith("glm-")) return "zhipu";
    if (value.startsWith("doubao-")) return "doubao";
    if (value.startsWith("minimax-")) return "minimax";
    if (value.includes("/") && /qwen|glm/i.test(value)) return "siliconflow";
    if (value.startsWith("ernie-")) return "baidu";
    if (value.startsWith("hunyuan-")) return "tencent";
    if (value.startsWith("gemini-")) return "gemini";
    if (value.startsWith("gpt-")) return "openai";
    if (value.startsWith("tokensea")) return "tokensea";
    return "qwen";
  }

  function findModel(providerId, modelId) {
    return getProvider(providerId).models.find((item) => item.id === modelId) || null;
  }

  function trustedRelayVisionModel(providerId, modelId) {
    if (String(providerId || "").toLowerCase() !== "tokensea") return false;
    const id = String(modelId || "").trim().toLowerCase();
    // The internal relay exposes Kimi K3 as the short id `k3` and does not
    // include standard input-modality metadata in /models.
    return id === "k3" || id === "kimi-k3" || id === "moonshot-k3";
  }

  function resolveModel(providerId, modelId, capabilityOverrides) {
    const selectedProvider = getProvider(providerId);
    const registered = findModel(selectedProvider.id, modelId);
    if (registered) return registered;
    const customId = String(modelId || "").trim();
    if (selectedProvider.discoversModels && customId && customId !== "auto") {
      const override = capabilityOverrides && capabilityOverrides[customId];
      const explicitVision = override === true || override === "vision";
      const explicitlyText = override === false || override === "text";
      const relayCompatibility = !explicitVision && !explicitlyText
        && trustedRelayVisionModel(selectedProvider.id, customId);
      const vision = explicitVision || relayCompatibility;
      return model(customId, customId, vision, {
        capabilityKnown: vision || explicitlyText,
        source: explicitVision || explicitlyText
          ? "models_api_or_user"
          : (relayCompatibility ? "trusted_relay_model" : "unknown")
      });
    }
    return null;
  }

  function normalizeSettings(value) {
    const saved = value && typeof value === "object" ? value : {};
    const inferred = inferProviderId(saved.modelId || saved.model);
    const providerId = PROVIDERS[saved.providerId] ? saved.providerId : inferred;
    const selectedProvider = getProvider(providerId);
    const apiKeys = {};
    for (const id of providerIds()) apiKeys[id] = "";
    if (saved.apiKeys && typeof saved.apiKeys === "object") {
      for (const id of providerIds()) apiKeys[id] = String(saved.apiKeys[id] || "");
    }
    if (saved.apiKey && !apiKeys[providerId]) apiKeys[providerId] = String(saved.apiKey);
    const modelCatalogs = {};
    if (saved.modelCatalogs && typeof saved.modelCatalogs === "object") {
      for (const id of providerIds()) {
        if (!Array.isArray(saved.modelCatalogs[id])) continue;
        modelCatalogs[id] = saved.modelCatalogs[id]
          .map((item) => String(item && item.id ? item.id : item || "").trim())
          .filter(Boolean)
          .slice(0, 100);
      }
    }
    const modelCapabilities = {};
    if (saved.modelCapabilities && typeof saved.modelCapabilities === "object") {
      for (const id of providerIds()) {
        const source = saved.modelCapabilities[id];
        if (!source || typeof source !== "object") continue;
        modelCapabilities[id] = {};
        for (const [modelId, capability] of Object.entries(source)) {
          if (capability === true || capability === false || capability === "vision" || capability === "text") {
            modelCapabilities[id][String(modelId)] = capability;
          }
        }
      }
    }
    const requestedModel = String(saved.modelId || saved.model || "");
    const catalog = modelCatalogs[providerId] || [];
    const modelId = resolveModel(providerId, requestedModel, modelCapabilities[providerId]) || catalog.includes(requestedModel)
      ? requestedModel
      : (catalog[0] || selectedProvider.defaultModel);
    return { providerId, modelId, apiKeys, modelCatalogs, modelCapabilities };
  }

  function normalizeOpenAIContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    }).join("");
  }

  function parseDataUrl(value) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(value || ""));
    if (!match) throw new Error("\u56fe\u7247\u6570\u636e\u4e0d\u662f\u6709\u6548\u7684 Base64 Data URL\u3002");
    return { mimeType: match[1], data: match[2] };
  }

  function geminiParts(userContent) {
    const items = Array.isArray(userContent) ? userContent : [{ type: "text", text: String(userContent || "") }];
    return items.map((item) => {
      if (!item || item.type === "text") return { text: String((item && item.text) || "") };
      if (item.type === "image_url" && item.image_url && item.image_url.url) {
        const image = parseDataUrl(item.image_url.url);
        return { inline_data: { mime_type: image.mimeType, data: image.data } };
      }
      throw new Error(`Gemini \u4e0d\u652f\u6301\u6d88\u606f\u7c7b\u578b\uff1a${String(item && item.type)}`);
    });
  }

  function buildRequest(input) {
    const selectedProvider = getProvider(input.providerId);
    const selectedModel = resolveModel(selectedProvider.id, input.modelId)
      || resolveModel(selectedProvider.id, selectedProvider.defaultModel);
    if (!selectedModel) throw new Error(`\u6a21\u578b\u914d\u7f6e\u65e0\u6548\uff1a${selectedProvider.id}/${input.modelId}`);
    if (selectedProvider.discoversModels && selectedModel.id === "auto") {
      throw new Error("Tokensea \u5c1a\u672a\u83b7\u53d6\u53ef\u7528\u6a21\u578b\uff0c\u8bf7\u4fdd\u5b58 Key \u81ea\u52a8\u8bfb\u53d6\uff0c\u6216\u5728\u9ad8\u7ea7\u8bbe\u7f6e\u4e2d\u624b\u52a8\u586b\u5199\u6a21\u578b ID\u3002");
    }
    const apiKey = String(input.apiKey || "").trim();
    if (!apiKey) throw new Error(`\u8bf7\u586b\u5199 ${selectedProvider.apiKeyLabel}\u3002`);
    const maxTokens = Number(input.maxTokens) > 0 ? Math.round(Number(input.maxTokens)) : null;

    if (selectedProvider.transport === "gemini") {
      return {
        providerId: selectedProvider.id,
        modelId: selectedModel.id,
        url: `${String(input.apiUrl || selectedProvider.apiUrl).replace(/\/$/, "")}/${encodeURIComponent(selectedModel.id)}:generateContent`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: {
          system_instruction: { parts: [{ text: String(input.system || "") }] },
          contents: [{ role: "user", parts: geminiParts(input.userContent) }],
          generationConfig: {
            responseMimeType: "application/json",
            ...(maxTokens ? { maxOutputTokens: maxTokens } : {})
          }
        },
        timeoutMs: selectedProvider.timeoutMs
      };
    }

    const body = {
      model: selectedModel.id,
      messages: [
        { role: "system", content: String(input.system || "") },
        { role: "user", content: input.userContent }
      ],
      ...(selectedProvider.supportsJsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    };
    if (selectedProvider.id === "kimi") {
      if (selectedModel.id === "kimi-k2.6") body.thinking = { type: "disabled" };
      else body.temperature = 1;
    } else if (selectedProvider.id === "tokensea") {
      // Tokensea may route to models that reject any value except 1.
      body.temperature = 1;
    } else {
      body.temperature = 0;
    }
    return {
      providerId: selectedProvider.id,
      modelId: selectedModel.id,
      url: String(input.apiUrl || selectedProvider.apiUrl),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body,
      timeoutMs: selectedProvider.timeoutMs
    };
  }

  function parseResponse(providerId, data) {
    const selectedProvider = getProvider(providerId);
    if (!data || typeof data !== "object") throw new Error(`${selectedProvider.label} \u8fd4\u56de\u4e86\u7a7a\u54cd\u5e94\u3002`);
    if (data.error) {
      const detail = typeof data.error === "string"
        ? data.error
        : data.error.message || JSON.stringify(data.error);
      throw new Error(detail || `${selectedProvider.label} \u8bf7\u6c42\u5931\u8d25\u3002`);
    }
    let content = "";
    if (selectedProvider.transport === "gemini") {
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts
        : [];
      content = (parts || []).map((item) => String((item && item.text) || "")).join("");
    } else {
      const message = data.choices && data.choices[0] ? data.choices[0].message : null;
      content = normalizeOpenAIContent(message && message.content);
    }
    if (!content.trim()) throw new Error(`${selectedProvider.label} \u8fd4\u56de\u4e3a\u7a7a\u3002`);
    return {
      content,
      requestId: data.id || data.request_id || data.requestId || ""
    };
  }

  function proxyEnvelope(input) {
    return {
      __providerId: String(input.providerId || ""),
      __modelId: String(input.modelId || ""),
      __apiKey: String(input.apiKey || ""),
      __requestStage: String(input.stage || "planning"),
      system: String(input.system || ""),
      userContent: input.userContent,
      ...(Number(input.maxTokens) > 0 ? { maxTokens: Math.round(Number(input.maxTokens)) } : {})
    };
  }

  function buildModelsRequest(providerId, apiKey, options) {
    const selectedProvider = getProvider(providerId);
    if (!selectedProvider.modelsUrl) throw new Error(`${selectedProvider.label} \u4e0d\u652f\u6301\u81ea\u52a8\u8bfb\u53d6\u6a21\u578b\u5217\u8868\u3002`);
    const key = String(apiKey || "").trim();
    if (!key) throw new Error(`\u8bf7\u586b\u5199 ${selectedProvider.apiKeyLabel}\u3002`);
    return {
      providerId: selectedProvider.id,
      url: String((options && options.modelsUrl) || selectedProvider.modelsUrl),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      timeoutMs: 15000
    };
  }

  function parseModelsResponse(providerId, data) {
    const selectedProvider = getProvider(providerId);
    if (!data || typeof data !== "object") throw new Error(`${selectedProvider.label} \u6ca1\u6709\u8fd4\u56de\u6a21\u578b\u5217\u8868\u3002`);
    if (data.error) {
      const detail = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error);
      throw new Error(detail || `${selectedProvider.label} \u8bfb\u53d6\u6a21\u578b\u5931\u8d25\u3002`);
    }
    const source = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    const ids = source
      .map((item) => String(item && item.id ? item.id : item || "").trim())
      .filter((id, index, values) => id && values.indexOf(id) === index)
      .slice(0, 100);
    if (!ids.length) throw new Error(`${selectedProvider.label} \u8fd4\u56de\u7684\u6a21\u578b\u5217\u8868\u4e3a\u7a7a\u3002`);
    return ids;
  }

  function parseModelsCatalog(providerId, data) {
    const selectedProvider = getProvider(providerId);
    const ids = parseModelsResponse(providerId, data);
    const source = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    const byId = new Map(source.map((item) => [String(item && item.id ? item.id : item || "").trim(), item]));
    return ids.map((id) => {
      const item = byId.get(id);
      const capabilities = item && Array.isArray(item.capabilities) ? item.capabilities.map((value) => String(value).toLowerCase()) : [];
      const modalities = item && Array.isArray(item.modalities) ? item.modalities.map((value) => String(value).toLowerCase()) : [];
      const inputModalitiesSource = item && (item.input_modalities || item.inputModalities);
      const inputModalities = Array.isArray(inputModalitiesSource)
        ? inputModalitiesSource.map((value) => String(value).toLowerCase())
        : [];
      const explicit = item && typeof item.vision === "boolean" ? item.vision : null;
      const imageInputNames = new Set(["image", "image_url", "image-input", "image_input", "vision", "multimodal", "image_understanding"]);
      const textOnlyNames = new Set(["text", "text_only", "text-only"]);
      const capabilityVision = capabilities.some((value) => imageInputNames.has(value));
      const modalityVision = modalities.some((value) => imageInputNames.has(value));
      const inputVision = inputModalities.some((value) => imageInputNames.has(value));
      const declaredVision = explicit === true
        || (explicit !== false && (inputVision
          || (inputModalities.length === 0 && (capabilityVision || modalityVision))));
      const declaredTextOnly = explicit === false
        || (inputModalities.length > 0 && !inputVision)
        || (inputModalities.length === 0
          && capabilities.length > 0 && capabilities.every((value) => textOnlyNames.has(value)))
        || (inputModalities.length === 0 && capabilities.length === 0
          && modalities.length > 0 && modalities.every((value) => textOnlyNames.has(value)));
      const relayCompatibility = !declaredVision && !declaredTextOnly
        && trustedRelayVisionModel(selectedProvider.id, id);
      return {
        id,
        vision: declaredVision || relayCompatibility ? true : (declaredTextOnly ? false : null),
        capabilityKnown: declaredVision || declaredTextOnly || relayCompatibility
      };
    });
  }

  return Object.freeze({
    PROVIDERS,
    providerIds,
    getProvider,
    findModel,
    resolveModel,
    inferProviderId,
    normalizeSettings,
    buildRequest,
    parseResponse,
    proxyEnvelope,
    buildModelsRequest,
    parseModelsResponse,
    parseModelsCatalog
  });
});
