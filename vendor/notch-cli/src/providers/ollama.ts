/**
 * Notch CLI — Ollama HTTP client
 *
 * Talks directly to Ollama's native REST API (not the OpenAI-compat shim)
 * for operations that don't map cleanly to OpenAI: `/api/tags`, `/api/pull`,
 * `/api/show`, `/api/ps`. The OpenAI-compat layer is still used for
 * inference — see byok.ts.
 *
 * Works against both a local daemon (http://localhost:11434) and Ollama
 * Cloud (https://ollama.com), since both expose the same endpoint surface.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { ollamaRoot } from './ollama-url.js';

export const OLLAMA_LOCAL_BASE_URL = 'http://localhost:11434';
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

/** Raw entry from GET /api/tags. Only the fields we actually use are declared. */
export interface OllamaTagEntry {
  name: string;
  model?: string;
  size?: number;
  modified_at?: string;
  digest?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
    format?: string;
  };
}

/** Normalised model row used by the CLI. */
export interface OllamaModelRow {
  name: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  modifiedAt: string | undefined;
}

/** Result of GET /api/show (we only pluck the context window). */
export interface OllamaShowResult {
  template?: string;
  capabilities?: string[];
  contextLength: number | undefined;
  parameterSize: string | undefined;
  family: string | undefined;
  /** Raw model_info map — returned so callers can inspect arch-specific keys. */
  modelInfo: Record<string, unknown>;
}

/** Progress event yielded while streaming a pull. */
export type OllamaPullEvent =
  | { kind: 'status'; message: string }
  | { kind: 'progress'; message: string; completed: number; total: number; percent: number }
  | { kind: 'done' };

const DEFAULT_TIMEOUT_MS = 5_000;

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function joinUrl(baseUrl: string, path: string): string {
  const root = ollamaRoot(baseUrl);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${root}${suffix}`;
}

/**
 * Ping the daemon's `/api/tags` endpoint. Returns true when the daemon
 * answers with HTTP 200 within the timeout. Does NOT distinguish between
 * "no daemon" and "daemon up but returning an error" — callers that care
 * should inspect listModels() directly.
 */
export async function detectDaemon(
  baseUrl: string = OLLAMA_LOCAL_BASE_URL,
  opts: { timeoutMs?: number; apiKey?: string } = {},
): Promise<boolean> {
  try {
    const res = await fetch(joinUrl(baseUrl, '/api/tags'), {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: authHeaders(opts.apiKey),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** List models installed locally (or available on Ollama Cloud). */
export async function listModels(
  baseUrl: string = OLLAMA_LOCAL_BASE_URL,
  opts: { timeoutMs?: number; apiKey?: string } = {},
): Promise<OllamaModelRow[]> {
  const res = await fetch(joinUrl(baseUrl, '/api/tags'), {
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: authHeaders(opts.apiKey),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${baseUrl} returned ${res.status} for /api/tags`);
  }
  const body = (await res.json()) as { models?: OllamaTagEntry[] };
  const models = body.models ?? [];
  return models.map((m) => ({
    name: m.name,
    parameterSize: m.details?.parameter_size ?? '—',
    quantization: m.details?.quantization_level ?? '—',
    sizeBytes: m.size ?? 0,
    modifiedAt: m.modified_at,
  }));
}

/**
 * Fetch `/api/show` for a specific model and extract the context window.
 * Different GGUF architectures store it under different keys
 * (`llama.context_length`, `qwen2.context_length`, ...). We return the
 * first numeric hit so callers don't have to care.
 */
export async function showModel(
  modelName: string,
  baseUrl: string = OLLAMA_LOCAL_BASE_URL,
  opts: { timeoutMs?: number; apiKey?: string } = {},
): Promise<OllamaShowResult> {
  const res = await fetch(joinUrl(baseUrl, '/api/show'), {
    method: 'POST',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName }),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/show(${modelName}) returned ${res.status}`);
  }
  const body = (await res.json()) as {
    template?: string;
    capabilities?: string[];
    model_info?: Record<string, unknown>;
    details?: { parameter_size?: string; family?: string };
  };
  const info = body.model_info ?? {};
  let contextLength: number | undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      contextLength = value;
      break;
    }
  }
  return {
    template: body.template,
    capabilities: body.capabilities,
    contextLength,
    parameterSize: body.details?.parameter_size,
    family: body.details?.family,
    modelInfo: info,
  };
}

/**
 * Stream a `/api/pull` response and translate each NDJSON frame into an
 * OllamaPullEvent. Caller-driven: use a for-await loop to print progress.
 *
 * Emits `done` only when the server sends `{"status":"success"}`.
 * Throws on HTTP errors, malformed frames, or an interrupted download.
 */
export async function* pullModel(
  modelName: string,
  baseUrl: string = OLLAMA_LOCAL_BASE_URL,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): AsyncGenerator<OllamaPullEvent, void, unknown> {
  const res = await fetch(joinUrl(baseUrl, '/api/pull'), {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName, stream: true }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama /api/pull returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
        if (frame.error) throw new Error(`Ollama pull error: ${frame.error}`);
        if (frame.status === 'success') { yield { kind: 'done' }; return; }
        if (typeof frame.total === 'number' && typeof frame.completed === 'number' && frame.total > 0) {
          yield { kind: 'progress', message: frame.status ?? '', completed: frame.completed,
            total: frame.total, percent: Math.min(100, frame.completed / frame.total * 100) };
        } else if (frame.status) yield { kind: 'status', message: frame.status };
      }
      if (done) throw new Error('Ollama download ended before success. Retry the pull to resume.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Delete an installed model via DELETE /api/delete. Used by the bench
 * cleanup path to remove temporary pulls. Returns true on HTTP 200.
 */
export async function deleteModel(
  modelName: string,
  baseUrl: string = OLLAMA_LOCAL_BASE_URL,
  opts: { apiKey?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const res = await fetch(joinUrl(baseUrl, '/api/delete'), {
    method: 'DELETE',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.apiKey) },
    body: JSON.stringify({ name: modelName }),
  });
  return res.ok;
}

/** Does this URL point at Ollama Cloud rather than a local daemon? */
export function isCloudBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'ollama.com' || host.endsWith('.ollama.com');
  } catch {
    return false;
  }
}

/**
 * Does this model name target a cloud-hosted variant (`:cloud` tag)?
 * Ollama Cloud serves both `gpt-oss:120b-cloud` style and plain tagged
 * aliases like `glm-5:cloud` — we accept either.
 */
export function isCloudModel(modelName: string): boolean {
  return /(^|[:\-])cloud$/i.test(modelName) || modelName.endsWith(':cloud');
}

/**
 * Format a byte count for the model picker table. Fixed-width strings
 * keep columns aligned.
 */
export function formatBytes(n: number): string {
  if (!n || n <= 0) return '       —';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`.padStart(8);
}
