/**
 * Notch CLI — Bring-Your-Own-Key (BYOK) Providers
 *
 * Passthrough layer for OpenAI-compatible endpoints (Anthropic, OpenRouter,
 * Google, DeepSeek, Together, Fireworks, Groq, local Ollama / LM Studio /
 * vLLM, etc.).
 *
 * Provider references accept both OpenCode-style `<provider>/<model>` and
 * legacy `<provider>:<model>` syntax, e.g.
 * `openrouter/anthropic/claude-sonnet-4.6`.
 *
 * Built-in provider base URLs, API-key env names, and default models are
 * sourced from each provider's official OpenAI-compatibility docs (see
 * README for references). No new runtime deps — @ai-sdk/openai ships with
 * the CLI.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { loadSyncedByokKeysSync } from '../auth.js';
import { ollamaChatUrl, ollamaRoot } from './ollama-url.js';
import { ollamaFetch } from './ollama-transport.js';

/** Which API shape does this provider speak at its base URL? */
export type ApiShape = 'openai' | 'anthropic';

/** Shape of a built-in (or custom) BYOK provider entry. */
export interface ByokProvider {
  /** Stable id used as the `<provider>:` prefix in model refs. */
  id: string;
  /** Human-readable label shown in pickers and help. */
  label: string;
  /** OpenAI-compatible base URL (MUST include `/v1` or equivalent). */
  baseUrl: string;
  /**
   * Env var the CLI checks for an API key. Empty string means no key
   * required (local inference servers).
   */
  apiKeyEnv: string;
  /** Provider page where users can create API keys, when there is one. */
  apiKeyUrl?: string;
  /** Default model id if user doesn't specify one. */
  defaultModel: string;
  /** Optional short list of known models (undefined = too many to list). */
  models?: string[];
  /** `compatible` = OpenAI shim with quirks; `strict` = full OpenAI. */
  compatibility?: 'strict' | 'compatible';
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /**
   * If true, CLI falls back to a hard-coded literal api key when the env
   * var is unset. Used for Ollama (literal `"ollama"`).
   */
  fallbackApiKey?: string;
  /**
   * Which wire protocol the provider speaks. Defaults to `openai` so
   * every existing entry is unaffected. Set to `anthropic` for providers
   * whose `baseUrl` implements the Anthropic Messages API (Ollama
   * v0.14+, Anthropic-native endpoints, LiteLLM in anthropic-mode, etc.).
   * Anthropic base URLs include the API prefix (`/v1`); the SDK appends `/messages`.
   */
  apiShape?: ApiShape;
}

// ---------------------------------------------------------------------------
// Built-in provider catalog
//
// Every baseUrl + apiKeyEnv below was cross-checked against each provider's
// current OpenAI-compatibility documentation:
//   - OpenAI:     https://platform.openai.com/docs/api-reference
//   - Anthropic:  https://platform.claude.com/docs/en/api/openai-sdk
//   - OpenRouter: https://openrouter.ai/docs/quickstart
//   - Google:     https://ai.google.dev/gemini-api/docs/openai
//   - DeepSeek:   https://api-docs.deepseek.com/
//   - Together:   https://docs.together.ai/docs/openai-api-compatibility
//   - Fireworks:  https://docs.fireworks.ai/tools-sdks/openai-compatibility
//   - Groq:       https://console.groq.com/docs/openai
//   - Ollama:     https://github.com/ollama/ollama/blob/main/docs/openai.md
//   - LM Studio:  https://lmstudio.ai/docs/basics/server
//   - vLLM:       https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
// ---------------------------------------------------------------------------

export const BUILTIN_BYOK_PROVIDERS: ByokProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-6.1-sol',
    models: [
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-chat-latest',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o4-mini',
    ],
    compatibility: 'strict',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    // Use the native Messages API for tool calling.
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5-5',
    models: [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    compatibility: 'compatible',
    apiShape: 'anthropic',
    // anthropic-version is optional on the OpenAI compat layer, but we
    // pin it so behaviour is deterministic across CLI releases.
    headers: {
      'anthropic-version': '2023-06-01',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyUrl: 'https://openrouter.ai/settings/keys',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    // OpenRouter exposes hundreds of models — leave undefined and let
    // users discover via openrouter.ai/models.
    compatibility: 'strict',
    headers: {
      'HTTP-Referer': 'https://freesyntax.dev',
      'X-OpenRouter-Title': 'Notch CLI',
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.5-flash',
    models: [
      'gemini-3.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    compatibility: 'compatible',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-v4-flash',
    models: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    compatibility: 'strict',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    defaultModel: 'meta-llama/Llama-4-70B-Instruct',
    models: [
      'meta-llama/Llama-4-70B-Instruct',
      'meta-llama/Llama-4-8B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'Qwen/QwQ-32B-Preview',
      'deepseek-ai/DeepSeek-V3',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
    ],
    compatibility: 'strict',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    apiKeyUrl: 'https://fireworks.ai/account/api-keys',
    defaultModel: 'accounts/fireworks/models/llama-v4-70b-instruct',
    models: [
      'accounts/fireworks/models/llama-v4-70b-instruct',
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/qwen2p5-72b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/mixtral-8x22b-instruct',
    ],
    compatibility: 'strict',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    apiKeyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-4-70b-8192',
    models: [
      'llama-4-70b-8192',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
      'qwen-qwq-32b',
    ],
    compatibility: 'strict',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    defaultModel: 'llama3.2:latest',
    // Ollama ignores the api key but openai-compat clients require a
    // non-empty string. Default to the literal "ollama" per their docs.
    fallbackApiKey: 'ollama',
    compatibility: 'compatible',
    apiShape: 'openai',
  },
  {
    // Same daemon, native Anthropic Messages API shape.
    id: 'ollama-anthropic',
    label: 'Ollama (local, Anthropic-compat)',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    defaultModel: 'qwen3-coder:30b',
    fallbackApiKey: 'ollama',
    apiShape: 'anthropic',
  },
  {
    // Ollama Cloud: same endpoint surface as local, hosted on ollama.com.
    // Requires OLLAMA_API_KEY from https://ollama.com/settings/keys.
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    apiKeyUrl: 'https://ollama.com/settings/keys',
    defaultModel: 'gpt-oss:120b',
    models: [
      'gpt-oss:120b',
      'gpt-oss:20b',
      'kimi-k2.5:cloud',
      'glm-5:cloud',
      'qwen3.5:cloud',
      'deepseek-v3.1:671b',
      'minimax-m2.7:cloud',
    ],
    compatibility: 'compatible',
    apiShape: 'openai',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    apiKeyEnv: '',
    defaultModel: 'local-model',
    fallbackApiKey: 'lm-studio',
    compatibility: 'compatible',
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: '',
    defaultModel: 'local-vllm',
    fallbackApiKey: 'EMPTY',
    compatibility: 'strict',
  },
  {
    id: 'mlx', label: 'MLX (Apple Silicon)', baseUrl: 'http://127.0.0.1:11435/v1',
    apiKeyEnv: '', defaultModel: 'mlx-community/Qwen3.5-4B-4bit', fallbackApiKey: 'not-needed',
  },
  {
    id: '__custom__',
    label: 'Custom (user-supplied)',
    // User MUST supply --base-url. These defaults are placeholders that
    // will fail fast if the user forgets the flag.
    baseUrl: '',
    apiKeyEnv: '',
    defaultModel: '',
    compatibility: 'compatible',
  },
];

const BYOK_BY_ID: Record<string, ByokProvider> = Object.fromEntries(
  BUILTIN_BYOK_PROVIDERS.map((p) => [p.id, p]),
);

/** Look up a BYOK provider by id. Returns undefined for unknown ids. */
export function findByokProvider(id: string): ByokProvider | undefined {
  return BYOK_BY_ID[id];
}

/** All built-in BYOK providers (hidden `__custom__` sentinel excluded). */
export function listByokProviders(): ByokProvider[] {
  return BUILTIN_BYOK_PROVIDERS.filter((p) => p.id !== '__custom__');
}

function normalizeProviderId(id: string): string {
  return id === 'custom' ? '__custom__' : id;
}

function providerExists(id: string): boolean {
  return Boolean(BYOK_BY_ID[normalizeProviderId(id)]);
}

/**
 * Detect whether a model string is a provider reference.
 *
 * Preferred syntax mirrors OpenCode: `<provider>/<model>`. The old
 * `<provider>:<model>` form remains supported so existing configs keep
 * working and Ollama tags like `ollama/llama3.2:latest` are unambiguous.
 */
export function isByokRef(model: string): boolean {
  const slash = model.indexOf('/');
  if (slash > 0 && providerExists(model.slice(0, slash))) return true;

  const colon = model.indexOf(':');
  if (colon > 0 && providerExists(model.slice(0, colon))) return true;

  return false;
}

/** Resolved BYOK model spec from a raw `<provider>:<model>` string. */
export interface ByokSpec {
  contextWindow?: number;
  ollamaBatch?: number;
  /** Provider id (must match a BUILTIN_BYOK_PROVIDERS entry). */
  provider: string;
  /** Remote model id (e.g. `anthropic/claude-sonnet-4.6`). */
  model?: string;
  /** Explicit API key override (CLI flag, .notch.json). */
  apiKey?: string;
  /** Explicit base URL override (required for `__custom__`). */
  baseUrl?: string;
  /** Extra request headers (merged with provider defaults). */
  headers?: Record<string, string>;
  /**
   * Override the provider's default apiShape. Lets `--compat anthropic`
   * flip an openai-shape provider entry to anthropic (useful when the
   * user runs Ollama with a custom port and just wants the Messages
   * API wire protocol).
   */
  apiShape?: ApiShape;
}

/**
 * Parse a provider model ref into its pieces.
 *
 * Examples:
 *   parseByokRef('openrouter/anthropic/claude-sonnet-4.6')
 *     -> { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }
 *   parseByokRef('ollama/llama3.2:latest')
 *     -> { provider: 'ollama', model: 'llama3.2:latest' }
 *   parseByokRef('custom/my-model')
 *     -> { provider: '__custom__', model: 'my-model' }
 */
export function parseByokRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  const colon = ref.indexOf(':');

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
    `Provider model ref "${ref}" must be "<provider>/<model>" or "<provider>:<model>".`,
  );
}

/** Thrown when a BYOK provider needs an API key the user hasn't supplied. */
export class ByokMissingApiKeyError extends Error {
  constructor(public readonly provider: ByokProvider) {
    super(
      provider.apiKeyEnv
        ? `Missing API key for ${provider.label}. Set ${provider.apiKeyEnv} or pass --api-key.`
        : `Missing API key for ${provider.label}. Pass --api-key.`,
    );
    this.name = 'ByokMissingApiKeyError';
  }
}

/** Thrown when --provider custom is used without --base-url. */
export class ByokMissingBaseUrlError extends Error {
  constructor() {
    super(
      'Custom provider requires --base-url (and usually --api-key). ' +
      'Example: notch --provider custom --base-url https://my.endpoint/v1 --model my-model',
    );
    this.name = 'ByokMissingBaseUrlError';
  }
}

/**
 * Resolve a BYOK spec into a ready-to-use LanguageModel.
 *
 * The returned object mirrors `resolveModel`'s shape so the rest of
 * the agent loop doesn't need to care which backend is in use.
 *
 * Branches on `providerInfo.apiShape` (overridable via `spec.apiShape`):
 *   - `openai` (default) -> @ai-sdk/openai createOpenAI
 *   - `anthropic`        -> @ai-sdk/anthropic createAnthropic
 */
export function resolveByokModel(spec: ByokSpec): {
  model: LanguageModel;
  providerInfo: ByokProvider;
  modelId: string;
} {
  const providerInfo = findByokProvider(spec.provider);
  if (!providerInfo) {
    throw new Error(
      `Unknown provider "${spec.provider}". Available: ${listByokProviders().map((p) => p.id).join(', ')}, custom`,
    );
  }

  // Custom provider requires explicit baseUrl.
  if (providerInfo.id === '__custom__' && !spec.baseUrl) {
    throw new ByokMissingBaseUrlError();
  }

  const shape: ApiShape = spec.apiShape ?? providerInfo.apiShape ?? 'openai';
  const isLocalOllama = providerInfo.id === 'ollama' || providerInfo.id === 'ollama-anthropic';
  const baseUrl = isLocalOllama
    ? ollamaChatUrl(spec.baseUrl)
    : spec.baseUrl ?? providerInfo.baseUrl;
  const modelId = spec.model && spec.model.length > 0
    ? spec.model
    : providerInfo.defaultModel;

  if (!modelId) {
    throw new Error(
      `Provider "${providerInfo.id}" has no default model. Pass --model or set byok.model in .notch.json.`,
    );
  }

  // API key resolution order:
  //   1. explicit spec.apiKey
  //   2. provider.apiKeyEnv env var (shell-exported wins — CI + local
  //      overrides must not be silently replaced by a stale sync)
  //   3. synced BYOK stash from `notch login` / `notch sync-keys`
  //   4. provider.fallbackApiKey literal (for local servers)
  let apiKey: string | undefined = spec.apiKey;
  if (!apiKey && providerInfo.apiKeyEnv) {
    apiKey = process.env[providerInfo.apiKeyEnv];
  }
  if (!apiKey) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const synced = loadSyncedByokKeysSync();
    if (synced) {
      const fromSync = synced.keys[providerInfo.id as keyof typeof synced.keys];
      if (typeof fromSync === 'string' && fromSync.length > 0) apiKey = fromSync;
    }
  }
  if (!apiKey && providerInfo.fallbackApiKey) {
    apiKey = providerInfo.fallbackApiKey;
  }

  // Local endpoints (Ollama/LM Studio/vLLM) with no env and no fallback
  // still need *some* string — the OpenAI SDK refuses empty keys.
  if (!apiKey && !providerInfo.apiKeyEnv) {
    apiKey = 'not-needed';
  }

  if (!apiKey) {
    throw new ByokMissingApiKeyError(providerInfo);
  }
  if (providerInfo.id === 'anthropic' && apiKey.startsWith('sk-ant-oat')) {
    throw new Error('Use an Anthropic Console API key, not a Claude subscription token.');
  }

  const headers: Record<string, string> = {
    ...(providerInfo.headers ?? {}),
    ...(providerInfo.id === 'anthropic' && process.env.ANTHROPIC_WORKSPACE_ID
      ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
    ...(spec.headers ?? {}),
  };

  if (shape === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey,
      baseURL: baseUrl,
      headers,
    });
    return {
      model: anthropic(modelId) as LanguageModel,
      providerInfo,
      modelId,
    };
  }

  const provider = createOpenAI({
    ...(providerInfo.id === 'ollama' ? { fetch: ollamaFetch(baseUrl, spec) } : {}),
    apiKey,
    baseURL: baseUrl,
    headers,
  });

  return {
    model: (providerInfo.id === 'openai' ? provider.responses(modelId) : provider.chat(modelId)) as LanguageModel,
    providerInfo,
    modelId,
  };
}

/**
 * Quick reachability probe for a BYOK endpoint. Mirrors the Notch
 * `validateConfig` return shape so callers can branch uniformly.
 *
 * We avoid the `/health` convention (most providers don't expose one)
 * and instead sanity-check that baseUrl + apiKey are usable.
 */
export async function validateByokConfig(spec: ByokSpec): Promise<{ ok: boolean; error?: string }> {
  const providerInfo = findByokProvider(spec.provider);
  if (!providerInfo) {
    return { ok: false, error: `Unknown provider "${spec.provider}"` };
  }
  if (providerInfo.id === '__custom__' && !spec.baseUrl) {
    return { ok: false, error: 'Custom provider requires --base-url' };
  }
  const baseUrl = spec.baseUrl ?? providerInfo.baseUrl;
  if (!baseUrl) {
    return { ok: false, error: `No base URL for ${providerInfo.label}` };
  }
  const apiKey = spec.apiKey
    ?? (providerInfo.apiKeyEnv ? process.env[providerInfo.apiKeyEnv] : undefined)
    ?? loadSyncedByokKeysSync()?.keys[providerInfo.id as keyof import('../auth.js').SyncedByokKeys['keys']]
    ?? providerInfo.fallbackApiKey;
  if (providerInfo.apiKeyEnv && !apiKey) {
    return {
      ok: false,
      error: `${providerInfo.label}: missing API key. Set ${providerInfo.apiKeyEnv} or run notch setup.`,
    };
  }
  if (providerInfo.id === 'anthropic' && apiKey?.startsWith('sk-ant-oat')) {
    return { ok: false, error: 'Use an Anthropic Console API key, not a Claude subscription token.' };
  }
  try {
    if (providerInfo.id === 'ollama' || providerInfo.id === 'ollama-anthropic') {
      const { showModel } = await import('./ollama.js');
      const info = await showModel(spec.model || providerInfo.defaultModel, ollamaRoot(spec.baseUrl), { apiKey });
      if (info.capabilities && !info.capabilities.includes('tools')) {
        return { ok: false, error: 'This Ollama model does not advertise tool calling. Choose a tool-capable model with notch setup.' };
      }
    } else if (providerInfo.id === 'mlx') {
      const root = new URL(baseUrl).origin;
      const response = await fetch(`${root}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false, error: `MLX server is not ready (HTTP ${response.status}). Run notch models install --runner mlx.` };
    } else if (providerInfo.id === 'openai' || providerInfo.id === 'anthropic') {
      const headers = new Headers({ ...providerInfo.headers, ...spec.headers });
      headers.set('Authorization', `Bearer ${apiKey}`);
      if (providerInfo.id === 'anthropic' && !headers.has('anthropic-workspace-id') && process.env.ANTHROPIC_WORKSPACE_ID) {
        headers.set('anthropic-workspace-id', process.env.ANTHROPIC_WORKSPACE_ID);
      }
      const model = spec.model || providerInfo.defaultModel;
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`, {
        headers, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ok: false, error: `${providerInfo.label} key/model check failed (HTTP ${response.status}). Check ${providerInfo.apiKeyEnv}, model access${providerInfo.id === 'anthropic' ? ', and ANTHROPIC_WORKSPACE_ID for a multi-workspace key' : ''}.` };
    } else if (providerInfo.id === 'openrouter') {
      // /models is public, so it cannot validate credentials. /key does.
      const headers = { Authorization: `Bearer ${apiKey}` };
      const root = baseUrl.replace(/\/+$/, '');
      const auth = await fetch(`${root}/key`, { headers, signal: AbortSignal.timeout(5000) });
      if (!auth.ok) return { ok: false, error: `OpenRouter API key check failed (HTTP ${auth.status}). Check OPENROUTER_API_KEY.` };
      const response = await fetch(`${root}/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false, error: `OpenRouter model discovery failed (HTTP ${response.status}).` };
      const catalog = await response.json() as { data?: { id: string; supported_parameters?: string[] }[] };
      const model = catalog.data?.find(row => row.id === (spec.model || providerInfo.defaultModel));
      if (!model) return { ok: false, error: 'Model not found in OpenRouter. Run notch --list-coding-models.' };
      if (model.supported_parameters && !model.supported_parameters.includes('tools')) {
        return { ok: false, error: 'This OpenRouter model does not support tools. Run notch --list-coding-models.' };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Cannot reach ${providerInfo.label}: ${(error as Error).message}` };
  }
}
