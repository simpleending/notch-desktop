import {
  ollamaRoot
} from "./chunk-RKXQ4ULC.js";

// vendor/notch-cli/src/providers/ollama.ts
var OLLAMA_LOCAL_BASE_URL = "http://localhost:11434";
var OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
var DEFAULT_TIMEOUT_MS = 5e3;
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
function joinUrl(baseUrl, path) {
  const root = ollamaRoot(baseUrl);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${root}${suffix}`;
}
async function detectDaemon(baseUrl = OLLAMA_LOCAL_BASE_URL, opts = {}) {
  try {
    const res = await fetch(joinUrl(baseUrl, "/api/tags"), {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: authHeaders(opts.apiKey)
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function listModels(baseUrl = OLLAMA_LOCAL_BASE_URL, opts = {}) {
  const res = await fetch(joinUrl(baseUrl, "/api/tags"), {
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: authHeaders(opts.apiKey)
  });
  if (!res.ok) {
    throw new Error(`Ollama ${baseUrl} returned ${res.status} for /api/tags`);
  }
  const body = await res.json();
  const models = body.models ?? [];
  return models.map((m) => ({
    name: m.name,
    parameterSize: m.details?.parameter_size ?? "\u2014",
    quantization: m.details?.quantization_level ?? "\u2014",
    sizeBytes: m.size ?? 0,
    modifiedAt: m.modified_at
  }));
}
async function showModel(modelName, baseUrl = OLLAMA_LOCAL_BASE_URL, opts = {}) {
  const res = await fetch(joinUrl(baseUrl, "/api/show"), {
    method: "POST",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName })
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/show(${modelName}) returned ${res.status}`);
  }
  const body = await res.json();
  const info = body.model_info ?? {};
  let contextLength;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      contextLength = value;
      break;
    }
  }
  return {
    capabilities: body.capabilities,
    contextLength,
    parameterSize: body.details?.parameter_size,
    family: body.details?.family,
    modelInfo: info
  };
}
async function* pullModel(modelName, baseUrl = OLLAMA_LOCAL_BASE_URL, opts = {}) {
  const res = await fetch(joinUrl(baseUrl, "/api/pull"), {
    method: "POST",
    signal: opts.signal,
    headers: { "Content-Type": "application/json", ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName, stream: true })
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama /api/pull returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.error) throw new Error(`Ollama pull error: ${frame.error}`);
        if (frame.status === "success") {
          yield { kind: "done" };
          return;
        }
        if (typeof frame.total === "number" && typeof frame.completed === "number" && frame.total > 0) {
          yield {
            kind: "progress",
            message: frame.status ?? "",
            completed: frame.completed,
            total: frame.total,
            percent: Math.min(100, frame.completed / frame.total * 100)
          };
        } else if (frame.status) yield { kind: "status", message: frame.status };
      }
      if (done) throw new Error("Ollama download ended before success. Retry the pull to resume.");
    }
  } finally {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
async function deleteModel(modelName, baseUrl = OLLAMA_LOCAL_BASE_URL, opts = {}) {
  const res = await fetch(joinUrl(baseUrl, "/api/delete"), {
    method: "DELETE",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName })
  });
  return res.ok;
}
function isCloudBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}
function isCloudModel(modelName) {
  return /(^|[:\-])cloud$/i.test(modelName) || modelName.endsWith(":cloud");
}
function formatBytes(n) {
  if (!n || n <= 0) return "       \u2014";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`.padStart(8);
}

export {
  OLLAMA_LOCAL_BASE_URL,
  OLLAMA_CLOUD_BASE_URL,
  detectDaemon,
  listModels,
  showModel,
  pullModel,
  deleteModel,
  isCloudBaseUrl,
  isCloudModel,
  formatBytes
};
