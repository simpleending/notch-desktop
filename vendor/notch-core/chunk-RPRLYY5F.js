import {
  queuedLocalFetch
} from "./chunk-LUGHZTHG.js";
import {
  ollamaChatUrl,
  ollamaRoot
} from "./chunk-RKXQ4ULC.js";

// vendor/notch-cli/src/providers/byok.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";

// vendor/notch-cli/src/auth.ts
import os from "os";
import path from "path";
import fs from "fs/promises";
import { readFileSync } from "fs";
function getConfigDir() {
  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? os.homedir(), "notch");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  return path.join(xdg ?? path.join(os.homedir(), ".config"), "notch");
}
function getByokSyncPath() {
  return path.join(getConfigDir(), "byok-sync.json");
}
async function loadSyncedByokKeys() {
  try {
    const raw = await fs.readFile(getByokSyncPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.keys) return parsed;
    return null;
  } catch {
    return null;
  }
}
var syncedKeysCache;
function loadSyncedByokKeysSync() {
  if (syncedKeysCache !== void 0) return syncedKeysCache;
  try {
    const raw = readFileSync(getByokSyncPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.keys) {
      syncedKeysCache = parsed;
    } else {
      syncedKeysCache = null;
    }
  } catch {
    syncedKeysCache = null;
  }
  return syncedKeysCache;
}

// vendor/notch-cli/src/providers/ollama-transport.ts
import { randomUUID } from "crypto";
function ollamaContextLength(fallback, nativeLimit) {
  const value = Number(process.env.NOTCH_OLLAMA_CONTEXT || fallback || 8192);
  if (!Number.isInteger(value) || value < 2048 || value > 262144) {
    throw new Error("NOTCH_OLLAMA_CONTEXT must be an integer between 2048 and 262144.");
  }
  return Number.isSafeInteger(nativeLimit) && nativeLimit >= 2048 ? Math.min(value, nativeLimit) : value;
}
function ollamaBatchSize(fallback) {
  const raw = process.env.NOTCH_OLLAMA_BATCH;
  const value = Number(raw || (fallback ?? 128));
  if (!Number.isInteger(value) || value < 1 || value > 2048) {
    throw new Error("NOTCH_OLLAMA_BATCH must be an integer between 1 and 2048.");
  }
  return value;
}
function ollamaFetch(baseUrl, options = {}) {
  const thoughts = /* @__PURE__ */ new Map();
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    let lastUser = body.messages.length - 1;
    while (lastUser >= 0 && body.messages[lastUser].role !== "user") lastUser--;
    const activeCalls = new Set(body.messages.slice(lastUser + 1).flatMap((message) => (message.tool_calls ?? []).flatMap((call) => call.id ? [call.id] : [])));
    const names = /* @__PURE__ */ new Map();
    const messages = body.messages.map((message) => {
      for (const call of message.tool_calls ?? []) if (call.id) names.set(call.id, call.function.name);
      const images = [];
      const content = Array.isArray(message.content) ? message.content.map((part) => {
        if (part.type === "image_url") {
          const match = /^data:image\/[^;]+;base64,(.+)$/.exec(part.image_url?.url || "");
          if (!match) throw new Error("Ollama images must be local files or base64 data URLs.");
          images.push(match[1]);
        }
        return part.text || "";
      }).join("\n") : message.content || "";
      const toolThought = message.tool_calls?.map((call) => call.id && activeCalls.has(call.id) && thoughts.get(call.id)).find(Boolean);
      return {
        role: message.role,
        content,
        ...toolThought ? { thinking: toolThought } : {},
        ...images.length ? { images } : {},
        ...message.tool_call_id ? { tool_name: names.get(message.tool_call_id) } : {},
        ...message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments
        } })) } : {}
      };
    });
    const response = await fetch(`${ollamaRoot(baseUrl)}/api/chat`, {
      ...init,
      body: JSON.stringify({
        model: body.model,
        messages,
        stream: body.stream === true,
        ...body.tools?.length ? { tools: body.tools } : {},
        ...body.response_format ? { format: body.response_format.json_schema?.schema || "json" } : {},
        ...["0", "1"].includes(process.env.NOTCH_OLLAMA_THINK || "") ? { think: process.env.NOTCH_OLLAMA_THINK === "1" } : {},
        options: {
          num_ctx: ollamaContextLength(options.contextWindow, options.nativeContextWindow),
          ...body.temperature === void 0 ? {} : { temperature: body.temperature },
          ...ollamaBatchSize(options.ollamaBatch) === void 0 ? {} : { num_batch: ollamaBatchSize(options.ollamaBatch) },
          ...body.max_tokens ? { num_predict: body.max_tokens } : {},
          ...body.stop ? { stop: body.stop } : {}
        }
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      return Response.json({ error: { message: `Ollama HTTP ${response.status}: ${detail.slice(0, 600)}`, type: "ollama_error" } }, { status: response.status });
    }
    let toolIndex = 0;
    let sawTools = false;
    let thinking = "";
    const responseCalls = [];
    const convert = (frame) => {
      if (frame.error) throw new Error(`Ollama: ${frame.error}`);
      thinking += frame.message?.thinking || "";
      const calls = frame.message?.tool_calls?.map((call) => ({
        index: toolIndex++,
        id: call.id || `call_${randomUUID()}`,
        type: "function",
        function: { name: call.function.name, arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments) }
      }));
      if (calls?.length) sawTools = true;
      if (calls) responseCalls.push(...calls.map((call) => call.id));
      if (frame.done && thinking) for (const id of responseCalls) thoughts.set(id, thinking);
      while (thoughts.size > 128) thoughts.delete(thoughts.keys().next().value);
      return {
        choices: [{ index: 0, [body.stream ? "delta" : "message"]: {
          role: "assistant",
          content: frame.message?.content || "",
          ...calls?.length ? { tool_calls: calls } : {}
        }, finish_reason: frame.done ? sawTools ? "tool_calls" : frame.done_reason === "length" ? "length" : "stop" : null }],
        ...frame.done ? { usage: { prompt_tokens: frame.prompt_eval_count || 0, completion_tokens: frame.eval_count || 0 } } : {}
      };
    };
    if (!body.stream) return Response.json(convert(await response.json()));
    if (!response.body) throw new Error("Ollama returned an empty response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let finished = false;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          let emitted = false;
          while (!emitted) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = done ? "" : lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              const frame = JSON.parse(line);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(convert(frame))}

`));
              emitted = true;
              if (frame.done) finished = true;
            }
            if (done || finished) {
              if (!finished) throw new Error("Ollama stream ended before completion.");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              await reader.cancel();
              return;
            }
          }
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => {
          });
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };
}

// vendor/notch-cli/src/providers/byok.ts
var BUILTIN_BYOK_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-6.1-sol",
    models: [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-chat-latest",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini"
    ],
    compatibility: "strict"
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    // Use the native Messages API for tool calling.
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5-5",
    models: [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5"
    ],
    compatibility: "compatible",
    apiShape: "anthropic",
    // anthropic-version is optional on the OpenAI compat layer, but we
    // pin it so behaviour is deterministic across CLI releases.
    headers: {
      "anthropic-version": "2023-06-01"
    }
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    defaultModel: "anthropic/claude-sonnet-4.6",
    // OpenRouter exposes hundreds of models — leave undefined and let
    // users discover via openrouter.ai/models.
    compatibility: "strict",
    headers: {
      "HTTP-Referer": "https://github.com/simpleending/FreeSyntax",
      "X-OpenRouter-Title": "Notch CLI"
    }
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3.5-flash",
    models: [
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash"
    ],
    compatibility: "compatible"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-v4-flash",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ],
    compatibility: "strict"
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    apiKeyUrl: "https://api.together.ai/settings/api-keys",
    defaultModel: "meta-llama/Llama-4-70B-Instruct",
    models: [
      "meta-llama/Llama-4-70B-Instruct",
      "meta-llama/Llama-4-8B-Instruct",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
      "Qwen/QwQ-32B-Preview",
      "deepseek-ai/DeepSeek-V3",
      "mistralai/Mixtral-8x22B-Instruct-v0.1"
    ],
    compatibility: "strict"
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    apiKeyUrl: "https://fireworks.ai/account/api-keys",
    defaultModel: "accounts/fireworks/models/llama-v4-70b-instruct",
    models: [
      "accounts/fireworks/models/llama-v4-70b-instruct",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/mixtral-8x22b-instruct"
    ],
    compatibility: "strict"
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    apiKeyUrl: "https://console.groq.com/keys",
    defaultModel: "llama-4-70b-8192",
    models: [
      "llama-4-70b-8192",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
      "qwen-qwq-32b"
    ],
    compatibility: "strict"
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    defaultModel: "llama3.2:latest",
    // Ollama ignores the api key but openai-compat clients require a
    // non-empty string. Default to the literal "ollama" per their docs.
    fallbackApiKey: "ollama",
    compatibility: "compatible",
    apiShape: "openai"
  },
  {
    // Same daemon, native Anthropic Messages API shape.
    id: "ollama-anthropic",
    label: "Ollama (local, Anthropic-compat)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    defaultModel: "qwen3-coder:30b",
    fallbackApiKey: "ollama",
    apiShape: "anthropic"
  },
  {
    // Ollama Cloud: same endpoint surface as local, hosted on ollama.com.
    // Requires OLLAMA_API_KEY from https://ollama.com/settings/keys.
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    apiKeyUrl: "https://ollama.com/settings/keys",
    defaultModel: "gpt-oss:120b",
    models: [
      "gpt-oss:120b",
      "gpt-oss:20b",
      "kimi-k2.5:cloud",
      "glm-5:cloud",
      "qwen3.5:cloud",
      "deepseek-v3.1:671b",
      "minimax-m2.7:cloud"
    ],
    compatibility: "compatible",
    apiShape: "openai"
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: "",
    defaultModel: "local-model",
    fallbackApiKey: "lm-studio",
    compatibility: "compatible"
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: "",
    defaultModel: "local-vllm",
    fallbackApiKey: "EMPTY",
    compatibility: "strict"
  },
  {
    id: "mlx",
    label: "MLX (Apple Silicon)",
    baseUrl: "http://127.0.0.1:11435/v1",
    apiKeyEnv: "",
    defaultModel: "mlx-community/Qwen3.5-4B-4bit",
    fallbackApiKey: "not-needed"
  },
  {
    id: "colibri",
    label: "Colibri (experimental)",
    baseUrl: "http://127.0.0.1:11437/v1",
    apiKeyEnv: "",
    defaultModel: "",
    fallbackApiKey: "not-needed"
  },
  { id: "strata", label: "Strata (experimental)", baseUrl: "http://127.0.0.1:11438/v1", apiKeyEnv: "", defaultModel: "", fallbackApiKey: "not-needed" },
  {
    id: "__custom__",
    label: "Custom (user-supplied)",
    // User MUST supply --base-url. These defaults are placeholders that
    // will fail fast if the user forgets the flag.
    baseUrl: "",
    apiKeyEnv: "",
    defaultModel: "",
    compatibility: "compatible"
  }
];
var BYOK_BY_ID = Object.fromEntries(
  BUILTIN_BYOK_PROVIDERS.map((p) => [p.id, p])
);
function findByokProvider(id) {
  return BYOK_BY_ID[id];
}
function listByokProviders() {
  return BUILTIN_BYOK_PROVIDERS.filter((p) => p.id !== "__custom__");
}
function normalizeProviderId(id) {
  return id === "custom" ? "__custom__" : id;
}
function providerExists(id) {
  return Boolean(BYOK_BY_ID[normalizeProviderId(id)]);
}
function isByokRef(model) {
  const slash = model.indexOf("/");
  if (slash > 0 && providerExists(model.slice(0, slash))) return true;
  const colon = model.indexOf(":");
  if (colon > 0 && providerExists(model.slice(0, colon))) return true;
  return false;
}
var OPENROUTER_FALLBACK_LIMIT = 3;
function openRouterFallbackIds(primary, ids) {
  const primaryId = typeof primary === "string" ? primary.replace(/^openrouter\//, "") : "";
  const seen = new Set(primaryId ? [primaryId] : []);
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.replace(/^openrouter\//, "");
    if (!/^[\w./:~+-]{1,256}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= OPENROUTER_FALLBACK_LIMIT) break;
  }
  return out;
}
function parseByokRef(ref) {
  const slash = ref.indexOf("/");
  const colon = ref.indexOf(":");
  if (slash > 0 && (colon < 0 || slash < colon) && providerExists(ref.slice(0, slash))) {
    const rawProvider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    return { provider: normalizeProviderId(rawProvider), model };
  }
  if (colon > 0 && providerExists(ref.slice(0, colon))) {
    const rawProvider = ref.slice(0, colon);
    const model = ref.slice(colon + 1);
    return { provider: normalizeProviderId(rawProvider), model };
  }
  throw new Error(
    `Provider model ref "${ref}" must be "<provider>/<model>" or "<provider>:<model>".`
  );
}
var ByokMissingApiKeyError = class extends Error {
  constructor(provider) {
    super(
      provider.apiKeyEnv ? `Missing API key for ${provider.label}. Set ${provider.apiKeyEnv} or pass --api-key.` : `Missing API key for ${provider.label}. Pass --api-key.`
    );
    this.provider = provider;
    this.name = "ByokMissingApiKeyError";
  }
  provider;
};
var ByokMissingBaseUrlError = class extends Error {
  constructor() {
    super(
      "Custom provider requires --base-url (and usually --api-key). Example: notch --provider custom --base-url https://my.endpoint/v1 --model my-model"
    );
    this.name = "ByokMissingBaseUrlError";
  }
};
function resolveByokModel(spec) {
  const providerInfo = findByokProvider(spec.provider);
  if (!providerInfo) {
    throw new Error(
      `Unknown provider "${spec.provider}". Available: ${listByokProviders().map((p) => p.id).join(", ")}, custom`
    );
  }
  if (providerInfo.id === "__custom__" && !spec.baseUrl) {
    throw new ByokMissingBaseUrlError();
  }
  const shape = spec.apiShape ?? providerInfo.apiShape ?? "openai";
  const isLocalOllama = providerInfo.id === "ollama" || providerInfo.id === "ollama-anthropic";
  const baseUrl = isLocalOllama ? ollamaChatUrl(spec.baseUrl) : spec.baseUrl ?? providerInfo.baseUrl;
  const modelId = spec.model && spec.model.length > 0 ? spec.model : providerInfo.defaultModel;
  if (!modelId) {
    throw new Error(
      `Provider "${providerInfo.id}" has no default model. Pass --model or set byok.model in .notch.json.`
    );
  }
  let apiKey = spec.apiKey;
  if (!apiKey && providerInfo.apiKeyEnv) {
    apiKey = process.env[providerInfo.apiKeyEnv];
  }
  if (!apiKey) {
    const synced = loadSyncedByokKeysSync();
    if (synced) {
      const fromSync = synced.keys[providerInfo.id];
      if (typeof fromSync === "string" && fromSync.length > 0) apiKey = fromSync;
    }
  }
  if (!apiKey && providerInfo.fallbackApiKey) {
    apiKey = providerInfo.fallbackApiKey;
  }
  if (!apiKey && !providerInfo.apiKeyEnv) {
    apiKey = "not-needed";
  }
  if (!apiKey) {
    throw new ByokMissingApiKeyError(providerInfo);
  }
  if (providerInfo.id === "anthropic" && apiKey.startsWith("sk-ant-oat")) {
    throw new Error("Use an Anthropic Console API key, not a Claude subscription token.");
  }
  const headers = {
    ...providerInfo.headers ?? {},
    ...providerInfo.id === "anthropic" && process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {},
    ...spec.headers ?? {}
  };
  if (shape === "anthropic") {
    const anthropic = createAnthropic({
      ...isLocalOllama ? { fetch: queuedLocalFetch(fetch) } : {},
      apiKey,
      baseURL: baseUrl,
      headers
    });
    return {
      model: anthropic(modelId),
      providerInfo,
      modelId
    };
  }
  if (providerInfo.id === "openrouter") {
    const fallbacks = openRouterFallbackIds(modelId, spec.fallbacks);
    const openrouter = createOpenRouter({ apiKey, baseURL: baseUrl, headers });
    const model = openrouter.chat(modelId, fallbacks.length ? { extraBody: { models: fallbacks } } : {});
    return { model: Number.isSafeInteger(spec.maxOutputTokens) && spec.maxOutputTokens > 0 ? wrapLanguageModel({
      model,
      middleware: { specificationVersion: "v4", transformParams: async ({ params }) => ({
        ...params,
        maxOutputTokens: Math.min(params.maxOutputTokens ?? spec.maxOutputTokens, spec.maxOutputTokens)
      }) }
    }) : model, providerInfo, modelId };
  }
  const provider = createOpenAI({
    ...providerInfo.id === "ollama" ? { fetch: queuedLocalFetch(ollamaFetch(baseUrl, spec)) } : providerInfo.id === "strata" ? { fetch: queuedLocalFetch(async (input, init) => {
      const { startStrata } = await import("./strata-J4RL2VBU.js");
      const ready = await startStrata(modelId, spec.contextWindow, init?.signal ?? void 0);
      const url = new URL(input instanceof Request ? input.url : String(input));
      return fetch(ready.baseUrl + url.pathname.replace(/^\/v1/, "") + url.search, init);
    }) } : providerInfo.id === "colibri" ? { fetch: queuedLocalFetch(async (input, init) => {
      const { startColibri } = await import("./colibri-HJ73IUNT.js");
      const ready = await startColibri(modelId, spec.contextWindow, init?.signal ?? void 0);
      const url = new URL(input instanceof Request ? input.url : String(input));
      return fetch(ready + url.pathname.replace(/^\/v1/, "") + url.search, init);
    }) } : providerInfo.id === "mlx" ? { fetch: queuedLocalFetch(async (input, init) => {
      const { startMlx } = await import("./local-runner-JIFOAN2R.js");
      const ready = await startMlx(modelId, init?.signal ?? void 0);
      const url = new URL(input instanceof Request ? input.url : String(input));
      return fetch(ready + url.pathname.replace(/^\/v1/, "") + url.search, init);
    }) } : {},
    apiKey,
    baseURL: baseUrl,
    headers
  });
  return {
    model: providerInfo.id === "openai" ? provider.responses(modelId) : provider.chat(modelId),
    providerInfo,
    modelId
  };
}
async function validateByokConfig(spec) {
  const providerInfo = findByokProvider(spec.provider);
  if (!providerInfo) {
    return { ok: false, error: `Unknown provider "${spec.provider}"` };
  }
  if (providerInfo.id === "__custom__" && !spec.baseUrl) {
    return { ok: false, error: "Custom provider requires --base-url" };
  }
  const baseUrl = spec.baseUrl ?? providerInfo.baseUrl;
  if (!baseUrl) {
    return { ok: false, error: `No base URL for ${providerInfo.label}` };
  }
  const apiKey = spec.apiKey ?? (providerInfo.apiKeyEnv ? process.env[providerInfo.apiKeyEnv] : void 0) ?? loadSyncedByokKeysSync()?.keys[providerInfo.id] ?? providerInfo.fallbackApiKey;
  if (providerInfo.apiKeyEnv && !apiKey) {
    return {
      ok: false,
      error: `${providerInfo.label}: missing API key. Set ${providerInfo.apiKeyEnv} or run notch setup.`
    };
  }
  if (providerInfo.id === "anthropic" && apiKey?.startsWith("sk-ant-oat")) {
    return { ok: false, error: "Use an Anthropic Console API key, not a Claude subscription token." };
  }
  try {
    if (providerInfo.id === "ollama" || providerInfo.id === "ollama-anthropic") {
      const { showModel } = await import("./ollama-H5HZK5N6.js");
      const info = await showModel(spec.model || providerInfo.defaultModel, ollamaRoot(spec.baseUrl), { apiKey });
      if (info.capabilities && !info.capabilities.includes("tools")) {
        return { ok: false, error: "This Ollama model does not advertise tool calling. Choose a tool-capable model with notch setup." };
      }
    } else if (providerInfo.id === "strata") {
      const { strataStatus } = await import("./strata-J4RL2VBU.js");
      const { selected } = await strataStatus();
      if (!selected || selected.id !== spec.model) return { ok: false, error: "Install this Strata model in Manage models first." };
      return { ok: true, contextWindow: selected.nativeContext, maxOutputTokens: 2048 };
    } else if (providerInfo.id === "colibri") {
      const { colibriStatus } = await import("./colibri-HJ73IUNT.js");
      const status = await colibriStatus();
      if (!status.verified || status.modelId !== spec.model) return { ok: false, error: "Set up and validate a Colibri model with notch models install --runner colibri." };
      return { ok: true, contextWindow: status.nativeContext, maxOutputTokens: 2048 };
    } else if (providerInfo.id === "mlx") {
      const root = new URL(baseUrl).origin;
      const response = await fetch(`${root}/health`, { signal: AbortSignal.timeout(5e3) });
      if (!response.ok) return { ok: false, error: `MLX server is not ready (HTTP ${response.status}). Run notch models install --runner mlx.` };
    } else if (providerInfo.id === "openai" || providerInfo.id === "anthropic") {
      const headers = new Headers({ ...providerInfo.headers, ...spec.headers });
      headers.set("Authorization", `Bearer ${apiKey}`);
      if (providerInfo.id === "anthropic" && !headers.has("anthropic-workspace-id") && process.env.ANTHROPIC_WORKSPACE_ID) {
        headers.set("anthropic-workspace-id", process.env.ANTHROPIC_WORKSPACE_ID);
      }
      const model = spec.model || providerInfo.defaultModel;
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}`, {
        headers,
        signal: AbortSignal.timeout(5e3)
      });
      if (!response.ok) return { ok: false, error: `${providerInfo.label} key/model check failed (HTTP ${response.status}). Check ${providerInfo.apiKeyEnv}, model access${providerInfo.id === "anthropic" ? ", and ANTHROPIC_WORKSPACE_ID for a multi-workspace key" : ""}.` };
    } else if (providerInfo.id === "openrouter") {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const root = baseUrl.replace(/\/+$/, "");
      const auth = await fetch(`${root}/key`, { headers, signal: AbortSignal.timeout(5e3) });
      if (!auth.ok) return { ok: false, error: `OpenRouter API key check failed (HTTP ${auth.status}). Check OPENROUTER_API_KEY.` };
      const response = await fetch(`${root}/models`, { headers, signal: AbortSignal.timeout(5e3) });
      if (!response.ok) return { ok: false, error: `OpenRouter model discovery failed (HTTP ${response.status}).` };
      const catalog = await response.json();
      const model = catalog.data?.find((row) => row.id === (spec.model || providerInfo.defaultModel));
      if (!model) return { ok: false, error: "Model not found in OpenRouter. Run notch --list-coding-models." };
      if (model.supported_parameters && !model.supported_parameters.includes("tools")) {
        return { ok: false, error: "This OpenRouter model does not support tools. Run notch --list-coding-models." };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Cannot reach ${providerInfo.label}: ${error.message}` };
  }
}

export {
  getConfigDir,
  loadSyncedByokKeys,
  ollamaContextLength,
  BUILTIN_BYOK_PROVIDERS,
  findByokProvider,
  listByokProviders,
  isByokRef,
  openRouterFallbackIds,
  parseByokRef,
  ByokMissingApiKeyError,
  ByokMissingBaseUrlError,
  resolveByokModel,
  validateByokConfig
};
