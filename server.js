"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const modelProviders = require("./uxp-v9.8/model-providers.js");

const PORT = Number(process.env.PS_AGENT_PORT || 17861);
const BRIDGE_VERSION = "0.9.8";
const PROJECT_DIR = __dirname;
const RUNTIME_DIR = path.resolve(String(process.env.PS_AGENT_RUNTIME_DIR || path.join(PROJECT_DIR, "runtime", "v9.8")));
const SEGMENT_SCRIPT = path.join(PROJECT_DIR, "segmentation", "mobilesam_segment.py");
const SEGMENT_WORKER_SCRIPT = path.join(PROJECT_DIR, "segmentation", "mobilesam_worker.py");
const REFERENCE_MATCH_SCRIPT = path.join(PROJECT_DIR, "segmentation", "reference_match.py");
const MODEL_MANIFEST_PATH = path.join(PROJECT_DIR, "segmentation", "mobilesam-model-manifest.json");
const MODEL_DIR = path.join(PROJECT_DIR, "models", "mobilesam");
const REQUEST_LOG = path.join(RUNTIME_DIR, "requests.log");
const BRIDGE_TOKEN_PATH = path.join(RUNTIME_DIR, "bridge-token.json");
const LOCAL_CONFIG_PATH = path.join(PROJECT_DIR, "config.local.json");
const PLAN_TIMEOUT_MS = boundedNumber(process.env.PS_AGENT_PLAN_TIMEOUT_MS, 300000, 10000, 600000);
const REQUEST_BODY_LIMIT = 12 * 1024 * 1024;
const UPSTREAM_BODY_LIMIT = 4 * 1024 * 1024;
const BRIDGE_RESPONSE_LIMIT = 48 * 1024 * 1024;
const SEGMENT_CACHE_LIMIT = 8;
const SEGMENT_CACHE_MAX_COUNTS = 750000;
const SEGMENT_CACHE_TTL_MS = boundedNumber(process.env.PS_AGENT_SEGMENT_CACHE_TTL_MS, 5 * 60 * 1000, 10000, 60 * 60 * 1000);
const SEGMENT_QUEUE_LIMIT = 4;
const BRIDGE_RATE_LIMIT = 180;
const SEGMENT_IMAGE_PIXEL_LIMIT = 12 * 1024 * 1024;
const SEGMENT_IMAGE_EDGE_LIMIT = 4096;
const segmentCache = new Map();
const inFlightSegmentations = new Map();
const requestRate = [];
const MODEL_MANIFEST = Object.freeze(JSON.parse(fs.readFileSync(MODEL_MANIFEST_PATH, "utf8").replace(/^\uFEFF/, "")).files);
const BRIDGE_BUILD = Object.freeze({
  serverSha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
  providerSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(PROJECT_DIR, "uxp-v9.8", "model-providers.js"))).digest("hex")
});
let modelIntegrityCache = null;

const PROVIDER_KEY_ENV = Object.freeze({
  qwen: ["PS_AGENT_QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  kimi: ["PS_AGENT_KIMI_API_KEY", "MOONSHOT_API_KEY"],
  deepseek: ["PS_AGENT_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
  zhipu: ["PS_AGENT_ZHIPU_API_KEY", "ZHIPU_API_KEY"],
  doubao: ["PS_AGENT_DOUBAO_API_KEY", "ARK_API_KEY"],
  minimax: ["PS_AGENT_MINIMAX_API_KEY", "MINIMAX_API_KEY"],
  siliconflow: ["PS_AGENT_SILICONFLOW_API_KEY", "SILICONFLOW_API_KEY"],
  baidu: ["PS_AGENT_BAIDU_API_KEY", "QIANFAN_API_KEY"],
  tencent: ["PS_AGENT_TENCENT_API_KEY", "HUNYUAN_API_KEY"],
  gemini: ["PS_AGENT_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["PS_AGENT_OPENAI_API_KEY", "OPENAI_API_KEY"],
  tokensea: ["PS_AGENT_TOKENSEA_API_KEY", "TOKENSEA_API_KEY"]
});

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || "BRIDGE_ERROR";
  return error;
}

function loadLocalConfig() {
  if (!fs.existsSync(LOCAL_CONFIG_PATH)) return { value: {}, error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The root value must be an object.");
    }
    if (parsed.providers != null && (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers))) {
      throw new Error("providers must be an object.");
    }
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `config.local.json is invalid: ${error.message}` };
  }
}

let localConfigState = loadLocalConfig();

function requireValidConfig() {
  if (localConfigState.error) throw httpError(503, localConfigState.error, "LOCAL_CONFIG_INVALID");
  return localConfigState.value || {};
}

function providerConfig(providerId) {
  const config = requireValidConfig();
  const value = config.providers && config.providers[providerId];
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(503, `Provider configuration for ${providerId} must be an object.`, "LOCAL_CONFIG_INVALID");
  }
  return value;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isPrivateIpv4Hostname(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function validateEndpoint(rawUrl, label, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (_) {
    throw httpError(503, `${label} is not a valid URL.`, "PROVIDER_ENDPOINT_INVALID");
  }
  if (url.username || url.password) {
    throw httpError(503, `${label} must not contain credentials.`, "PROVIDER_ENDPOINT_INVALID");
  }
  const safeHttp = url.protocol === "http:" && (
    isLoopbackHostname(url.hostname)
    || (options.allowPrivateHttp === true && isPrivateIpv4Hostname(url.hostname))
  );
  if (url.protocol !== "https:" && !safeHttp) {
    throw httpError(503, `${label} must use HTTPS, except for an approved local or private-network service.`, "PROVIDER_ENDPOINT_UNSAFE");
  }
  return url.toString();
}

function providerEndpoint(providerId, resource) {
  const provider = modelProviders.getProvider(providerId);
  const config = providerConfig(providerId);
  const endpointOptions = { allowPrivateHttp: providerId === "tokensea" };
  const envPrefix = `PS_AGENT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const direct = resource === "models"
    ? (process.env[`${envPrefix}_MODELS_URL`] || config.modelsUrl)
    : (process.env[`${envPrefix}_API_URL`] || config.apiUrl);
  if (direct) return validateEndpoint(direct, `${providerId} ${resource} endpoint`, endpointOptions);

  const base = process.env[`${envPrefix}_BASE_URL`] || config.baseUrl;
  if (base) {
    const safeBase = validateEndpoint(base, `${providerId} base URL`, endpointOptions).replace(/\/$/, "");
    return `${safeBase}/${resource === "models" ? "models" : "chat/completions"}`;
  }

  const builtIn = resource === "models" ? provider.modelsUrl : provider.apiUrl;
  if (!builtIn) throw httpError(400, `${provider.label} does not expose a models endpoint.`, "PROVIDER_MODELS_UNAVAILABLE");
  return validateEndpoint(builtIn, `${providerId} built-in endpoint`, endpointOptions);
}

function configuredApiKey(providerId) {
  const names = PROVIDER_KEY_ENV[providerId] || [];
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  const value = providerConfig(providerId).apiKey;
  return String(value || "").trim();
}

function appendRequestLog(event) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    if (fs.existsSync(REQUEST_LOG) && fs.statSync(REQUEST_LOG).size > 2 * 1024 * 1024) {
      fs.renameSync(REQUEST_LOG, `${REQUEST_LOG}.old`);
    }
    fs.appendFileSync(REQUEST_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch (_) {}
}

function ensureBridgeToken() {
  const fromEnvironment = String(process.env.PS_AGENT_BRIDGE_TOKEN || "").trim();
  if (fromEnvironment) {
    if (fromEnvironment.length < 32) throw new Error("PS_AGENT_BRIDGE_TOKEN must contain at least 32 characters.");
    return fromEnvironment;
  }

  try {
    if (fs.existsSync(BRIDGE_TOKEN_PATH)) {
      const text = fs.readFileSync(BRIDGE_TOKEN_PATH, "utf8").replace(/^\uFEFF/, "").trim();
      let value = text;
      try { value = String(JSON.parse(text).token || "").trim(); } catch (_) {}
      if (value.length >= 32) return value;
      throw new Error("The persisted bridge token is too short.");
    }
  } catch (error) {
    throw new Error(`Cannot read the bridge token: ${error.message}`);
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(BRIDGE_TOKEN_PATH, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(BRIDGE_TOKEN_PATH, 0o600); } catch (_) {}
  return token;
}

const BRIDGE_TOKEN = ensureBridgeToken();

function tokenMatches(candidate) {
  const supplied = Buffer.from(String(candidate || ""), "utf8");
  const expected = Buffer.from(BRIDGE_TOKEN, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isAuthenticated(req) {
  return tokenMatches(req.headers["x-ps-agent-token"]);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const value = String(origin).trim();
  if (/^https?:\/\//i.test(value)) return false;
  return value === "null" || /^(?:uxp|plugin|photoshop|file):\/\//i.test(value);
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type, x-ps-agent-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

function sendJson(req, res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > BRIDGE_RESPONSE_LIMIT) {
    status = 507;
    body = JSON.stringify({ error: "Bridge response exceeded the safe size limit.", code: "BRIDGE_RESPONSE_TOO_LARGE" });
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(req)
  });
  res.end(body);
}

function readBody(req, limit = REQUEST_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
        reject(httpError(413, "Request body too large.", "REQUEST_BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(httpError(499, "Client closed the request.", "CLIENT_ABORTED"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJsonBody(req, limit = REQUEST_BODY_LIMIT) {
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw httpError(400, "Request body must be valid JSON.", "REQUEST_JSON_INVALID");
  }
}

async function readUpstreamText(response, limit = UPSTREAM_BODY_LIMIT) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch (_) {}
      throw httpError(502, "The provider response exceeded the safe size limit.", "UPSTREAM_BODY_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pythonExecutable() {
  const configured = String(process.env.PS_AGENT_PYTHON || "").trim();
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(`PS_AGENT_PYTHON does not exist: ${configured}`);
    return configured;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function modelIntegrity() {
  const signature = Object.keys(MODEL_MANIFEST).map((name) => {
    const file = path.join(MODEL_DIR, name);
    if (!fs.existsSync(file)) return `${name}:missing`;
    const stat = fs.statSync(file);
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
  if (modelIntegrityCache && modelIntegrityCache.signature === signature) return modelIntegrityCache.value;

  const files = {};
  let valid = true;
  for (const [name, expected] of Object.entries(MODEL_MANIFEST)) {
    const file = path.join(MODEL_DIR, name);
    if (!fs.existsSync(file)) {
      files[name] = { valid: false, reason: "missing" };
      valid = false;
      continue;
    }
    const stat = fs.statSync(file);
    if (stat.size !== expected.size) {
      files[name] = { valid: false, reason: "size_mismatch" };
      valid = false;
      continue;
    }
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const fileValid = sha256 === expected.sha256;
    files[name] = { valid: fileValid, reason: fileValid ? null : "sha256_mismatch" };
    valid = valid && fileValid;
  }
  const value = { valid, files };
  modelIntegrityCache = { signature, value };
  return value;
}

function requireValidSegmentationModels() {
  const integrity = modelIntegrity();
  if (!integrity.valid) {
    throw httpError(503, "MobileSAM model files are missing or failed integrity verification.", "SEGMENTATION_MODEL_INVALID");
  }
  return integrity;
}

class SerialQueue {
  constructor(limit) {
    this.limit = limit;
    this.active = false;
    this.items = [];
  }

  get size() {
    return this.items.length + (this.active ? 1 : 0);
  }

  run(task, signal) {
    if (this.size >= this.limit) {
      return Promise.reject(httpError(429, "Segmentation is busy. Please retry after the current correction finishes.", "SEGMENTATION_BUSY"));
    }
    return new Promise((resolve, reject) => {
      const item = { task, signal, resolve, reject, started: false, abortHandler: null };
      if (signal && signal.aborted) {
        reject(httpError(499, "Segmentation was cancelled.", "SEGMENTATION_CANCELLED"));
        return;
      }
      if (signal) {
        item.abortHandler = () => {
          if (item.started) return;
          const index = this.items.indexOf(item);
          if (index >= 0) this.items.splice(index, 1);
          reject(httpError(499, "Segmentation was cancelled.", "SEGMENTATION_CANCELLED"));
        };
        signal.addEventListener("abort", item.abortHandler, { once: true });
      }
      this.items.push(item);
      this.pump();
    });
  }

  async pump() {
    if (this.active) return;
    const item = this.items.shift();
    if (!item) return;
    this.active = true;
    item.started = true;
    if (item.signal && item.abortHandler) item.signal.removeEventListener("abort", item.abortHandler);
    try {
      item.resolve(await item.task(item.signal));
    } catch (error) {
      item.reject(error);
    } finally {
      this.active = false;
      this.pump();
    }
  }
}

class PersistentSegmentationWorker {
  constructor() {
    this.child = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
    this.sequence = 0;
    this.startedAt = 0;
  }

  get ready() {
    return Boolean(this.child && !this.child.killed);
  }

  ensureStarted() {
    if (this.ready) return;
    if (!fs.existsSync(SEGMENT_WORKER_SCRIPT)) throw new Error("Persistent segmentation worker is missing.");
    const child = spawn(pythonExecutable(), ["-u", SEGMENT_WORKER_SCRIPT, "--models", MODEL_DIR], {
      cwd: PROJECT_DIR,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.startedAt = Date.now();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8192);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      const detail = this.stderrBuffer.trim();
      this.failAll(new Error(`Segmentation worker stopped (${signal || code}).${detail ? ` ${detail}` : ""}`));
      if (this.child === child) this.child = null;
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes("\n")) {
      const newline = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      const pending = this.pending.get(String(message.id || ""));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      pending.cleanup();
      if (message.ok && message.result && message.result.ok) pending.resolve(message.result);
      else {
        const error = new Error(String(message.error || message.result?.error || "Segmentation worker failed."));
        error.workerResult = true;
        pending.reject(error);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop(reason) {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try { child.kill(); } catch (_) {}
    }
    if (reason) this.failAll(reason);
  }

  run(args, signal) {
    this.ensureStarted();
    const child = this.child;
    const id = `segment_${Date.now()}_${this.sequence += 1}`;
    return new Promise((resolve, reject) => {
      let timeout;
      let abortHandler;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      };
      abortHandler = () => {
        const error = httpError(499, "Segmentation was cancelled.", "SEGMENTATION_CANCELLED");
        this.pending.delete(id);
        cleanup();
        reject(error);
        this.stop(error);
      };
      if (signal && signal.aborted) {
        abortHandler();
        return;
      }
      if (signal) signal.addEventListener("abort", abortHandler, { once: true });
      timeout = setTimeout(() => {
        const error = httpError(504, "Segmentation timed out.", "SEGMENTATION_TIMEOUT");
        this.pending.delete(id);
        cleanup();
        reject(error);
        this.stop(error);
      }, 180000);
      this.pending.set(id, { resolve, reject, cleanup });
      child.stdin.write(`${JSON.stringify({ id, command: "segment", args })}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        cleanup();
        reject(error);
        this.stop(error);
      });
    });
  }
}

const segmentQueue = new SerialQueue(SEGMENT_QUEUE_LIMIT);
const segmentationWorker = new PersistentSegmentationWorker();

function segmentationCliArgs(args) {
  const values = [
    "--image", args.image,
    "--box", args.box.join(","),
    "--clip-box", args.clipBox.join(","),
    "--positive-points", JSON.stringify(args.positivePoints),
    "--negative-points", JSON.stringify(args.negativePoints),
    "--color-refine", args.colorRefine,
    "--color-families", JSON.stringify(args.colorFamilies),
    "--color-hints", JSON.stringify(args.colorHints),
    "--color-tolerance", String(args.colorTolerance),
    "--semantic-scope", args.semanticScope,
    "--output", args.output,
    "--models", args.models,
    "--target-width", String(args.targetWidth),
    "--target-height", String(args.targetHeight),
    "--source-crop", args.sourceCrop.join(","),
    "--image-key", args.imageKey,
    "--rle",
    "--preview"
  ];
  return values;
}

function runSegmentationOneShot(args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(pythonExecutable(), [SEGMENT_SCRIPT, ...segmentationCliArgs(args)], {
      cwd: PROJECT_DIR,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 48 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
      let payload;
      try { payload = JSON.parse(lines[lines.length - 1] || "{}"); }
      catch (parseError) {
        reject(new Error(`Cannot parse segmentation result: ${parseError.message}. ${stderr || stdout}`));
        return;
      }
      if (error || !payload.ok) {
        reject(new Error(payload.error || stderr || error.message));
        return;
      }
      resolve(payload);
    });
    const abortHandler = () => {
      try { child.kill(); } catch (_) {}
      reject(httpError(499, "Segmentation was cancelled.", "SEGMENTATION_CANCELLED"));
    };
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
  });
}

async function runSegmentation(args, signal) {
  try {
    return await segmentationWorker.run(args, signal);
  } catch (error) {
    if (error.code === "SEGMENTATION_CANCELLED" || error.code === "SEGMENTATION_TIMEOUT" || error.workerResult) throw error;
    appendRequestLog({ type: "segmentation-worker-fallback", error: String(error.message || error) });
    return runSegmentationOneShot(args, signal);
  }
}

function runReferenceMatch(documentPath, referencePath) {
  return new Promise((resolve, reject) => {
    execFile(pythonExecutable(), [REFERENCE_MATCH_SCRIPT, "--document", documentPath, "--reference", referencePath], {
      cwd: PROJECT_DIR,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
      let payload;
      try { payload = JSON.parse(lines[lines.length - 1] || "{}"); }
      catch (parseError) {
        reject(httpError(503, `Reference matcher returned invalid JSON: ${parseError.message}.`, "REFERENCE_MATCH_UNAVAILABLE"));
        return;
      }
      if (error || !payload.ok) {
        reject(httpError(503, payload.error || String(stderr || error && error.message || "Reference matcher failed."), "REFERENCE_MATCH_UNAVAILABLE"));
        return;
      }
      resolve(payload);
    });
  });
}

function normalizedPoints(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) throw httpError(400, `${label} must contain at most 16 points.`, "SEGMENTATION_INPUT_INVALID");
  return value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw httpError(400, `${label} points must be [x,y].`, "SEGMENTATION_INPUT_INVALID");
    const point = item.map(Number);
    if (point.some((number) => !Number.isFinite(number) || number < 0 || number > 1)) {
      throw httpError(400, `${label} points must use normalized 0..1 coordinates.`, "SEGMENTATION_INPUT_INVALID");
    }
    return point;
  });
}

function normalizedBox(value, label) {
  const box = Array.isArray(value) ? value.map(Number) : [];
  if (box.length !== 4 || box.some((number) => !Number.isFinite(number))
    || !(0 <= box[0] && box[0] < box[2] && box[2] <= 1 && 0 <= box[1] && box[1] < box[3] && box[3] <= 1)) {
    throw httpError(400, `${label} must be normalized left,top,right,bottom.`, "SEGMENTATION_INPUT_INVALID");
  }
  return box;
}

function documentSourceCrop(value, canvasWidth, canvasHeight) {
  if (value == null) return [0, 0, canvasWidth, canvasHeight];
  const raw = Array.isArray(value)
    ? value
    : [value.left, value.top, value.right, value.bottom];
  const crop = raw.map((number) => Math.round(Number(number)));
  if (crop.length !== 4 || crop.some((number) => !Number.isFinite(number))
    || !(0 <= crop[0] && crop[0] < crop[2] && crop[2] <= canvasWidth
      && 0 <= crop[1] && crop[1] < crop[3] && crop[3] <= canvasHeight)) {
    throw httpError(400, "sourceCrop must be a pixel-space left,top,right,bottom rectangle inside the target canvas.", "SEGMENTATION_INPUT_INVALID");
  }
  if (!Array.isArray(value)) {
    if (value.canvasWidth != null && Math.round(Number(value.canvasWidth)) !== canvasWidth) {
      throw httpError(400, "sourceCrop.canvasWidth does not match targetWidth.", "SEGMENTATION_INPUT_INVALID");
    }
    if (value.canvasHeight != null && Math.round(Number(value.canvasHeight)) !== canvasHeight) {
      throw httpError(400, "sourceCrop.canvasHeight does not match targetHeight.", "SEGMENTATION_INPUT_INVALID");
    }
  }
  return crop;
}

function validateSegmentPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "Segmentation payload must be an object.", "SEGMENTATION_INPUT_INVALID");
  }
  const box = normalizedBox(payload.box, "Box");
  const clipBox = payload.clipBox == null ? box : normalizedBox(payload.clipBox, "Clip box");
  if (box[0] < clipBox[0] || box[1] < clipBox[1] || box[2] > clipBox[2] || box[3] > clipBox[3]) {
    throw httpError(400, "Target box must be completely inside the clip box.", "SEGMENTATION_INPUT_INVALID");
  }
  const positivePoints = normalizedPoints(payload.positivePoints, "Positive points");
  const negativePoints = normalizedPoints(payload.negativePoints, "Negative points");
  const colorRefine = String(payload.colorRefine || "none").toLowerCase();
  if (!new Set(["none", "source"]).has(colorRefine)) throw httpError(400, "Color refinement mode is invalid.", "SEGMENTATION_INPUT_INVALID");
  const allowedColorFamilies = new Set(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "black", "white", "gray", "brown"]);
  const colorFamilies = Array.isArray(payload.colorFamilies)
    ? [...new Set(payload.colorFamilies.slice(0, 4).map((value) => String(value || "").toLowerCase()))]
    : [];
  if (colorFamilies.some((value) => !allowedColorFamilies.has(value))) throw httpError(400, "Color family is invalid.", "SEGMENTATION_INPUT_INVALID");
  const colorHints = Array.isArray(payload.colorHints)
    ? [...new Set(payload.colorHints.slice(0, 6).map((value) => String(value || "").toUpperCase()))]
    : [];
  if (colorHints.some((value) => !/^#[0-9A-F]{6}$/.test(value))) throw httpError(400, "Color hints must use #RRGGBB.", "SEGMENTATION_INPUT_INVALID");
  const colorTolerance = Math.max(8, Math.min(128, Number(payload.colorTolerance == null ? 52 : payload.colorTolerance)));
  if (!Number.isFinite(colorTolerance)) throw httpError(400, "Color tolerance is invalid.", "SEGMENTATION_INPUT_INVALID");
  const requestedSemanticScope = String(payload.semanticScope || "unknown").toLowerCase();
  const semanticScope = requestedSemanticScope === "part" ? "subpart" : requestedSemanticScope;
  if (!["unknown", "whole_object", "subpart"].includes(semanticScope)) throw httpError(400, "Semantic scope is invalid.", "SEGMENTATION_INPUT_INVALID");
  const targetWidth = Math.round(Number(payload.targetWidth));
  const targetHeight = Math.round(Number(payload.targetHeight));
  if (!payload.imageBase64 || typeof payload.imageBase64 !== "string") throw httpError(400, "Missing imageBase64.", "SEGMENTATION_INPUT_INVALID");
  if (payload.imageBase64.length > 10 * 1024 * 1024) throw httpError(413, "Preview image is too large.", "SEGMENTATION_INPUT_INVALID");
  if (targetWidth < 1 || targetHeight < 1 || targetWidth * targetHeight > 80_000_000) {
    throw httpError(400, "Target document size is invalid or too large.", "SEGMENTATION_INPUT_INVALID");
  }
  const sourceCrop = documentSourceCrop(payload.sourceCrop == null ? payload.sourceBounds : payload.sourceCrop, targetWidth, targetHeight);
  return { box, clipBox, positivePoints, negativePoints, colorRefine, colorFamilies, colorHints, colorTolerance, semanticScope, targetWidth, targetHeight, sourceCrop };
}

function encodedImageDimensions(buffer) {
  if (buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { format: "jpeg", width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return null;
}

function decodeSegmentImage(imageBase64) {
  const text = String(imageBase64 || "").replace(/\s+/g, "");
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw httpError(400, "Preview image is not valid base64.", "SEGMENTATION_INPUT_INVALID");
  }
  const buffer = Buffer.from(text, "base64");
  if (!buffer.length) throw httpError(400, "Preview image is empty.", "SEGMENTATION_INPUT_INVALID");
  const dimensions = encodedImageDimensions(buffer);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw httpError(400, "Preview image must be a valid PNG or JPEG.", "SEGMENTATION_INPUT_INVALID");
  }
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > SEGMENT_IMAGE_PIXEL_LIMIT
    || dimensions.width > SEGMENT_IMAGE_EDGE_LIMIT || dimensions.height > SEGMENT_IMAGE_EDGE_LIMIT) {
    throw httpError(413, "Decoded preview dimensions exceed the segmentation safety limit.", "SEGMENTATION_IMAGE_TOO_LARGE");
  }
  return { buffer, dimensions };
}

function segmentCacheKey(imageBuffer, valid) {
  return crypto.createHash("sha256").update(imageBuffer).update(JSON.stringify(valid)).digest("hex");
}

function purgeSegmentCache() {
  const now = Date.now();
  for (const [key, entry] of segmentCache) {
    if (entry.expiresAt <= now) segmentCache.delete(key);
  }
}

function cachedSegmentation(key) {
  purgeSegmentCache();
  const entry = segmentCache.get(key);
  if (!entry) return null;
  segmentCache.delete(key);
  segmentCache.set(key, entry);
  return { ...entry.value };
}

function cacheableSegmentation(result) {
  const value = { ...result };
  delete value.previewBase64;
  delete value.maskPath;
  if (Array.isArray(value.rle) && value.rle.length > 100000) delete value.rle;
  return value;
}

function rememberSegmentation(key, result) {
  const countLength = Number(result && result.croppedRle && Array.isArray(result.croppedRle.counts)
    ? result.croppedRle.counts.length
    : 0);
  if (countLength > SEGMENT_CACHE_MAX_COUNTS) return;
  purgeSegmentCache();
  if (segmentCache.has(key)) segmentCache.delete(key);
  segmentCache.set(key, { expiresAt: Date.now() + SEGMENT_CACHE_TTL_MS, value: cacheableSegmentation(result) });
  while (segmentCache.size > SEGMENT_CACHE_LIMIT) segmentCache.delete(segmentCache.keys().next().value);
}

function requestAbortController(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    controller,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  };
}

function consumeSharedSegmentation(job, signal) {
  job.consumers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      job.consumers = Math.max(0, job.consumers - 1);
      if (signal) signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      release();
      if (job.consumers === 0 && !job.settled) job.controller.abort();
      reject(httpError(499, "Segmentation was cancelled.", "SEGMENTATION_CANCELLED"));
    };
    if (signal && signal.aborted) {
      abort();
      return;
    }
    if (signal) signal.addEventListener("abort", abort, { once: true });
    job.promise.then((value) => {
      if (settled) return;
      release();
      resolve(value);
    }, (error) => {
      if (settled) return;
      release();
      reject(error);
    });
  });
}

function startSharedSegmentation(cacheKey, task) {
  let job = inFlightSegmentations.get(cacheKey);
  if (job) return job;
  const controller = new AbortController();
  job = { controller, consumers: 0, settled: false, promise: null };
  job.promise = segmentQueue.run(task, controller.signal).finally(() => {
    job.settled = true;
    inFlightSegmentations.delete(cacheKey);
  });
  inFlightSegmentations.set(cacheKey, job);
  return job;
}

async function handleSegmentation(req, res) {
  const startedAt = Date.now();
  requireValidSegmentationModels();
  const payload = await readJsonBody(req);
  const valid = validateSegmentPayload(payload);
  const decodedImage = decodeSegmentImage(payload.imageBase64);
  const imageBuffer = decodedImage.buffer;
  const imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");
  const cacheKey = segmentCacheKey(imageBuffer, valid);
  const cached = cachedSegmentation(cacheKey);
  if (cached) {
    appendRequestLog({ type: "segmentation", requestId: "cache", cacheHit: true, elapsedMs: Date.now() - startedAt, selectedPixels: Number(cached.selectedPixels || 0) });
    sendJson(req, res, 200, { ...cached, cacheHit: true, previewCached: false });
    return;
  }

  const requestCancellation = requestAbortController(req, res);
  const requestId = crypto.randomBytes(8).toString("hex");
  const task = async (signal) => {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const imagePath = path.join(RUNTIME_DIR, `${requestId}.image`);
    const maskPath = path.join(RUNTIME_DIR, `${requestId}-mask.png`);
    try {
      fs.writeFileSync(imagePath, imageBuffer);
      const result = await runSegmentation({
        image: imagePath,
        imageKey: imageHash,
        box: valid.box,
        clipBox: valid.clipBox,
        positivePoints: valid.positivePoints,
        negativePoints: valid.negativePoints,
        colorRefine: valid.colorRefine,
        colorFamilies: valid.colorFamilies,
        colorHints: valid.colorHints,
        colorTolerance: valid.colorTolerance,
        semanticScope: valid.semanticScope,
        output: maskPath,
        models: MODEL_DIR,
        targetWidth: valid.targetWidth,
        targetHeight: valid.targetHeight,
        sourceCrop: valid.sourceCrop,
        includeRle: true,
        includePreview: true
      }, signal);
      delete result.maskPath;
      rememberSegmentation(cacheKey, result);
      return result;
    } finally {
      for (const file of [imagePath, maskPath]) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
      }
    }
  };

  try {
    const job = startSharedSegmentation(cacheKey, task);
    const result = await consumeSharedSegmentation(job, requestCancellation.controller.signal);
    appendRequestLog({
      type: "segmentation",
      requestId,
      cacheHit: false,
      elapsedMs: Date.now() - startedAt,
      positivePointCount: valid.positivePoints.length,
      negativePointCount: valid.negativePoints.length,
      selectedPixels: Number(result.selectedPixels || 0),
      iouScore: Number(result.iouScore || 0)
    });
    sendJson(req, res, 200, { ...result, cacheHit: false });
  } catch (error) {
    appendRequestLog({ type: "segmentation-error", requestId, elapsedMs: Date.now() - startedAt, error: String(error.message || error) });
    throw error;
  } finally {
    requestCancellation.cleanup();
  }
}

async function handleReferenceMatch(req, res) {
  if (!fs.existsSync(REFERENCE_MATCH_SCRIPT)) {
    throw httpError(503, "Local reference matcher is missing.", "REFERENCE_MATCH_UNAVAILABLE");
  }
  const payload = await readJsonBody(req);
  for (const field of ["documentBase64", "referenceBase64"]) {
    if (typeof payload[field] !== "string" || !payload[field]) {
      throw httpError(400, `${field} is required.`, "REFERENCE_MATCH_INPUT_INVALID");
    }
    if (payload[field].length > 6 * 1024 * 1024) {
      throw httpError(413, `${field} is too large.`, "REFERENCE_MATCH_INPUT_INVALID");
    }
  }
  const documentImage = decodeSegmentImage(payload.documentBase64);
  const referenceImage = decodeSegmentImage(payload.referenceBase64);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const requestId = `reference-${crypto.randomBytes(8).toString("hex")}`;
  const documentPath = path.join(RUNTIME_DIR, `${requestId}-document.image`);
  const referencePath = path.join(RUNTIME_DIR, `${requestId}-annotation.image`);
  try {
    fs.writeFileSync(documentPath, documentImage.buffer);
    fs.writeFileSync(referencePath, referenceImage.buffer);
    const result = await runReferenceMatch(documentPath, referencePath);
    appendRequestLog({
      type: "reference-match",
      requestId,
      match: result.match === true,
      method: String(result.method || "none"),
      confidence: Number(result.confidence || 0)
    });
    sendJson(req, res, 200, result);
  } finally {
    for (const file of [documentPath, referencePath]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    }
  }
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      cwd: PROJECT_DIR,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve(String(stdout || "").trim());
    });
  });
}

async function readWindowsClipboardImage() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const imagePath = path.join(RUNTIME_DIR, `${crypto.randomBytes(8).toString("hex")}-clipboard.png`);
  const escapedPath = imagePath.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$image = $null",
    "for ($i = 0; $i -lt 5 -and $null -eq $image; $i++) {",
    "  try { $image = [System.Windows.Forms.Clipboard]::GetImage() } catch {}",
    "  if ($null -eq $image) { Start-Sleep -Milliseconds 120 }",
    "}",
    "if ($null -eq $image) { throw 'Clipboard does not contain an image.' }",
    "$bitmap = New-Object System.Drawing.Bitmap $image",
    `try { $bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose(); $image.Dispose() }`
  ].join("\n");
  try {
    await runPowerShell(script);
    if (!fs.existsSync(imagePath)) throw new Error("Clipboard image capture did not create a PNG.");
    const data = fs.readFileSync(imagePath);
    if (!data.length) throw new Error("Clipboard image is empty.");
    return { ok: true, name: `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, mime: "image/png", base64: data.toString("base64") };
  } finally {
    try { if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } catch (_) {}
  }
}

function enforceRateLimit() {
  const cutoff = Date.now() - 60000;
  while (requestRate.length && requestRate[0] < cutoff) requestRate.shift();
  if (requestRate.length >= BRIDGE_RATE_LIMIT) throw httpError(429, "Bridge request rate limit exceeded.", "BRIDGE_RATE_LIMIT");
  requestRate.push(Date.now());
}

async function fetchWithTimeout(url, options, timeoutMs, clientSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const clientAbort = () => controller.abort();
  if (clientSignal) clientSignal.addEventListener("abort", clientAbort, { once: true });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (clientSignal) clientSignal.removeEventListener("abort", clientAbort);
  };
  try {
    const response = await fetch(url, { redirect: "error", ...options, signal: controller.signal });
    return { response, finish };
  } catch (error) {
    finish();
    throw error;
  }
}

async function handleProviderModels(req, res) {
  const payload = await readJsonBody(req);
  const providerId = String(payload.__providerId || "");
  if (!modelProviders.providerIds().includes(providerId)) throw httpError(400, `Unsupported provider: ${providerId || "missing"}.`, "PROVIDER_UNSUPPORTED");
  const apiKey = String(payload.__apiKey || configuredApiKey(providerId)).trim();
  const request = modelProviders.buildModelsRequest(providerId, apiKey, { modelsUrl: providerEndpoint(providerId, "models") });
  const cancellation = requestAbortController(req, res);
  try {
    const operation = await fetchWithTimeout(request.url, { method: "GET", headers: request.headers }, request.timeoutMs, cancellation.controller.signal);
    const upstream = operation.response;
    let text;
    try { text = await readUpstreamText(upstream); } finally { operation.finish(); }
    let data;
    try { data = JSON.parse(text || "{}"); } catch (_) { throw httpError(502, "The models response was not valid JSON.", "UPSTREAM_RESPONSE_INVALID"); }
    if (!upstream.ok) {
      sendJson(req, res, upstream.status, { error: data.error || data });
      return;
    }
    const models = typeof modelProviders.parseModelsCatalog === "function"
      ? modelProviders.parseModelsCatalog(providerId, data)
      : modelProviders.parseModelsResponse(providerId, data).map((id) => ({ id, vision: null, capabilityKnown: false }));
    sendJson(req, res, 200, { models });
  } finally {
    cancellation.cleanup();
  }
}

async function handlePlan(req, res) {
  const payload = await readJsonBody(req);
  const requestId = crypto.randomBytes(6).toString("hex");
  const startedAt = Date.now();
  const providerId = String(payload.__providerId || "");
  if (!modelProviders.providerIds().includes(providerId)) {
    appendRequestLog({ requestId, stage: "rejected", reason: "unsupported_provider", providerId });
    throw httpError(400, `Unsupported provider: ${providerId || "missing"}.`, "PROVIDER_UNSUPPORTED");
  }
  const provider = modelProviders.getProvider(providerId);
  const apiKey = String(payload.__apiKey || configuredApiKey(providerId)).trim();
  const requestStage = String(payload.__requestStage || "planning");
  if (!apiKey) throw httpError(400, `Missing API key for ${provider.label}.`, "PROVIDER_KEY_MISSING");

  const upstreamRequest = modelProviders.buildRequest({
    providerId,
    modelId: payload.__modelId,
    apiKey,
    apiUrl: providerEndpoint(providerId, "chat"),
    system: payload.system,
    userContent: payload.userContent,
    maxTokens: payload.maxTokens
  });
  const apiHost = new URL(upstreamRequest.url).host;
  appendRequestLog({ requestId, stage: "started", requestStage, provider: provider.label, apiHost, model: upstreamRequest.modelId });
  const timeoutMs = Math.min(PLAN_TIMEOUT_MS, Number(upstreamRequest.timeoutMs) || PLAN_TIMEOUT_MS);
  const cancellation = requestAbortController(req, res);
  let upstream;
  let upstreamOperation;
  try {
    upstreamOperation = await fetchWithTimeout(upstreamRequest.url, {
      method: "POST",
      headers: upstreamRequest.headers,
      body: JSON.stringify(upstreamRequest.body)
    }, timeoutMs, cancellation.controller.signal);
    upstream = upstreamOperation.response;
  } catch (error) {
    const timedOut = error && (error.name === "AbortError" || /aborted/i.test(error.message || ""));
    appendRequestLog({ requestId, stage: timedOut ? "timeout" : "network_error", requestStage, elapsedMs: Date.now() - startedAt, error: String(error.message || error) });
    cancellation.cleanup();
    if (timedOut) throw httpError(504, `${provider.label} did not respond within ${Math.round(timeoutMs / 1000)} seconds. Request: ${requestId}`, "UPSTREAM_TIMEOUT");
    throw httpError(502, `${provider.label} at ${apiHost} is unreachable. No Photoshop changes were executed. Request: ${requestId}`, "UPSTREAM_UNREACHABLE");
  }

  let text;
  try { text = await readUpstreamText(upstream); }
  finally {
    upstreamOperation.finish();
    cancellation.cleanup();
  }
  if (!upstream.ok) {
    appendRequestLog({ requestId, stage: "upstream_error", requestStage, status: upstream.status, elapsedMs: Date.now() - startedAt });
    sendJson(req, res, upstream.status, { error: text });
    return;
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw httpError(502, `${provider.label} returned invalid JSON. Request: ${requestId}`, "UPSTREAM_RESPONSE_INVALID"); }
  const parsed = modelProviders.parseResponse(providerId, data);
  const choice = data.choices?.[0] || {};
  appendRequestLog({ requestId, stage: "completed", requestStage, status: upstream.status, elapsedMs: Date.now() - startedAt, finishReason: choice.finish_reason || "", contentLength: parsed.content.length, completionTokens: Number(data.usage?.completion_tokens || 0) });
  sendJson(req, res, 200, { content: parsed.content, requestId });
}

function fullHealth() {
  purgeSegmentCache();
  const integrity = modelIntegrity();
  let configuredProviders = 0;
  if (!localConfigState.error) {
    for (const id of modelProviders.providerIds()) {
      try { if (configuredApiKey(id)) configuredProviders += 1; } catch (_) {}
    }
  }
  return {
    ok: true,
    bridgeVersion: BRIDGE_VERSION,
    bridgeBuild: BRIDGE_BUILD,
    authRequired: true,
    proxy: "photoshop-assistant",
    provider: "multi-provider",
    providers: modelProviders.providerIds(),
    config: { valid: !localConfigState.error, error: localConfigState.error, configuredProviderCount: configuredProviders },
    segmentation: {
      available: fs.existsSync(SEGMENT_SCRIPT) && fs.existsSync(SEGMENT_WORKER_SCRIPT) && integrity.valid,
      engine: "MobileSAM",
      modelIntegrity: integrity,
      persistentWorkerReady: segmentationWorker.ready,
      cacheEntries: segmentCache.size,
      queueDepth: segmentQueue.size
    },
    referenceMatching: {
      available: fs.existsSync(REFERENCE_MATCH_SCRIPT),
      engine: "OpenCV"
    },
    // Authenticated compatibility view for existing v9.x launcher checks.
    v7: {
      segmentation: fs.existsSync(SEGMENT_SCRIPT) && fs.existsSync(SEGMENT_WORKER_SCRIPT) && integrity.valid,
      segmentationEngine: "MobileSAM",
      segmentationCacheEntries: segmentCache.size
    }
  };
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedOrigin(req.headers.origin)) {
        sendJson(req, res, 403, { error: "Browser origins are not allowed to call the local Photoshop bridge." });
        return;
      }

      if (req.method === "OPTIONS") {
        const requestedHeaders = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
        if (requestedHeaders.some((name) => !["content-type", "x-ps-agent-token"].includes(name))) {
          sendJson(req, res, 403, { error: "CORS preflight requested unsupported headers." });
          return;
        }
        res.writeHead(204, { "Cache-Control": "no-store", ...corsHeaders(req) });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        sendJson(req, res, 200, isAuthenticated(req)
          ? fullHealth()
          : { ok: true, bridgeVersion: BRIDGE_VERSION, authRequired: true });
        return;
      }

      if (!isAuthenticated(req)) {
        sendJson(req, res, 401, { error: "Bridge authentication required.", code: "BRIDGE_AUTH_REQUIRED" });
        return;
      }
      enforceRateLimit();
      if (req.method === "POST" && (req.url === "/segment-v9.8" || req.url === "/segment-v9.7" || req.url === "/segment-v7")) {
        await handleSegmentation(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/reference-match-v9.8") {
        await handleReferenceMatch(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/clipboard-image") {
        try { sendJson(req, res, 200, await readWindowsClipboardImage()); }
        catch (error) { sendJson(req, res, 422, { error: error.message || String(error) }); }
        return;
      }
      if (req.method === "POST" && req.url === "/provider-models") {
        await handleProviderModels(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/plan") {
        await handlePlan(req, res);
        return;
      }
      sendJson(req, res, 404, { error: "Not found" });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      sendJson(req, res, status, { error: error.message || String(error), code: error.code || "BRIDGE_ERROR" });
    }
  });
  server.once("close", () => {
    segmentationWorker.stop(new Error("Bridge server closed."));
  });
  return server;
}

function startServer() {
  const integrity = modelIntegrity();
  if (!integrity.valid) {
    console.error("MobileSAM is disabled because its model files failed integrity verification.");
  }
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Photoshop Assistant v${BRIDGE_VERSION} bridge listening on http://127.0.0.1:${PORT}`);
    console.log(`Bridge token file: ${BRIDGE_TOKEN_PATH}`);
  });
  const shutdown = () => {
    segmentationWorker.stop(new Error("Bridge is shutting down."));
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (require.main === module) startServer();

module.exports = {
  BRIDGE_VERSION,
  BRIDGE_BUILD,
  BRIDGE_TOKEN_PATH,
  createServer,
  startServer,
  isAllowedOrigin,
  validateEndpoint,
  validateSegmentPayload,
  encodedImageDimensions,
  decodeSegmentImage,
  cacheableSegmentation,
  providerEndpoint,
  SerialQueue,
  consumeSharedSegmentation
};
