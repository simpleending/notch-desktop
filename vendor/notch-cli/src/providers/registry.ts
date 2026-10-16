/**
 * Notch CLI — Model Provider
 *
 * Connects to Notch model endpoints (served via vLLM on Modal) by default,
 * with transparent passthrough to any OpenAI-compatible BYOK endpoint when
 * the model field looks like `<provider>:<model>` (or `config.byokProvider`
 * is set).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelConfig, NotchModelId, NotchModelInfo } from './types.js';
import {
  isByokRef,
  parseByokRef,
  resolveByokModel,
  validateByokConfig,
} from './byok.js';
import {
  shouldRouteViaPiAi,
  resolveModelViaPiAi,
  piAiMode,
  recordShadowCost,
  registerShadowContext,
  type PiAiModelHandle,
} from './pi-ai-adapter.js';

/** Thrown when the configured backend has no API key (Notch or BYOK). */
export class MissingApiKeyError extends Error {
  /** Which flow caused this error (informs the onboarding message). */
  public readonly flow: 'notch' | 'byok';
  /** Env var name the user can set to fix it. */
  public readonly envVar: string;
  /** Human-friendly provider label (e.g. "OpenRouter"). */
  public readonly providerLabel: string;

  constructor(opts?: { flow?: 'notch' | 'byok'; envVar?: string; providerLabel?: string }) {
    const flow = opts?.flow ?? 'notch';
    const envVar = opts?.envVar ?? 'NOTCH_API_KEY';
    const providerLabel = opts?.providerLabel ?? 'Notch';
    super(`${envVar} is not set (${providerLabel})`);
    this.name = 'MissingApiKeyError';
    this.flow = flow;
    this.envVar = envVar;
    this.providerLabel = providerLabel;
  }
}

// ---------------------------------------------------------------------------
// Notch Model Catalog
// ---------------------------------------------------------------------------

export const MODEL_CATALOG: Record<NotchModelId, NotchModelInfo> = {
  'notch-pyre': {
    id: 'notch-pyre',
    label: 'Pyre',
    size: '9B',
    gpu: 'L40S',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    baseUrl: 'https://acemagnifique--notch-serve-pyre-notchpyreserver-serve.modal.run/v1',
    hardware: {
      vramGb: 10,
      ramGb: 16,
      diskGb: 6,
      recommendedGpu: 'RTX 3090 / 4070 Ti+ · 12GB+ VRAM',
      tier: 'light',
    },
    // null until we push Q4 merged weights to the public Hub. The CLI
    // surfaces this as "hosted-only" in the /model picker so users know
    // local download isn't wired yet — no fake error, no mock repo.
    hfRepo: null,
  },
  'notch-ignis': {
    id: 'notch-ignis',
    label: 'Ignis',
    size: '27B',
    gpu: 'A100-80GB',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    baseUrl: 'https://acemagnifique--notch-serve-ignis-notchignisserver-serve.modal.run/v1',
    hardware: {
      vramGb: 20,
      ramGb: 32,
      diskGb: 18,
      recommendedGpu: 'RTX 4090 / A6000+ · 24GB+ VRAM',
      tier: 'standard',
    },
    hfRepo: null,
  },
  'notch-solace': {
    id: 'notch-solace',
    label: 'Solace',
    size: '31B',
    gpu: 'A100-80GB',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    baseUrl: 'https://acemagnifique--notch-serve-solace-notchsolaceserver-serve.modal.run/v1',
    hardware: {
      vramGb: 24,
      ramGb: 64,
      diskGb: 22,
      recommendedGpu: 'RTX 4090 + offload / A100-40GB+',
      tier: 'heavy',
    },
    hfRepo: null,
  },
  'notch-solace-lite': {
    id: 'notch-solace-lite',
    label: 'Solace Lite',
    size: 'E4B',
    gpu: 'L4',
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    baseUrl: 'https://acemagnifique--notch-serve-solace-lite-notchsolacelitese-0e4da6.modal.run/v1',
    hardware: {
      vramGb: 6,
      ramGb: 8,
      diskGb: 3,
      recommendedGpu: 'RTX 3060 / M2 Pro+ · 8GB+ VRAM',
      tier: 'light',
    },
    hfRepo: null,
  },
};

/** All valid Notch model IDs (BYOK refs are NOT in this list). */
export const MODEL_IDS = Object.keys(MODEL_CATALOG) as NotchModelId[];

/** Check if a string is a valid Notch model ID */
export function isValidModel(id: string): id is NotchModelId {
  return id in MODEL_CATALOG;
}

/**
 * Heuristic: does this model accept image content blocks?
 *
 * - `notch-*`: all four are image-text-to-text (Gemma 3/4 vision pipeline-tag).
 * - `openai:*` (gpt-4o family), `anthropic:*` (Claude 4+), `google:*`
 *   (Gemini 2/3+), `together:*` (Llama 4-class) accept images.
 * - `openrouter:*` routes to arbitrary models, so only known multimodal
 *   OpenRouter model ids are treated as image-capable.
 * - `groq:*` currently serves text-only models — return false.
 *
 * This check is used to gate image attachments before we send a request.
 */
export function modelSupportsImages(modelId: string): boolean {
  if (!modelId) return false;
  const lowerModelId = modelId.toLowerCase();
  // Notch catalog — all entries are vision-capable per the deploy notes.
  if (modelId in MODEL_CATALOG) return true;
  if (lowerModelId.startsWith('notch-')) return true;
  // Provider-prefixed IDs (openai/gpt-4o, anthropic/claude-4.7, etc.)
  const ref = isByokRef(lowerModelId) ? parseByokRef(lowerModelId) : null;
  const prefix = ref?.provider ?? '';
  switch (prefix) {
    case 'openai':
    case 'anthropic':
    case 'google':
    case 'together':
      return true;
    case 'openrouter':
      return openRouterModelSupportsImages(ref?.model ?? '');
    case 'groq':
      return false;
    default:
      return false;
  }
}

function openRouterModelSupportsImages(upstreamModelId: string): boolean {
  return [
    'openai/gpt-5.3-codex',
    'openai/gpt-5.2-codex',
    'openai/gpt-5.1-codex',
    'openai/gpt-5-codex',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-4',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.5',
    '~anthropic/claude-sonnet-latest',
    '~moonshotai/kimi-latest',
  ].some((id) => upstreamModelId === id || upstreamModelId.startsWith(`${id}:`));
}

/**
 * Resolve a ModelConfig into a ready-to-use LanguageModel instance.
 *
 * Routing:
 *   - `config.byokProvider` set     -> BYOK
 *   - `config.model` has a `:`      -> BYOK (parsed from ref)
 *   - `config.model` is a Notch id  -> Modal endpoint
 *
 * Resolution order for Notch base URL:
 *   1. Explicit config.baseUrl
 *   2. NOTCH_BASE_URL env var
 *   3. Model's default Modal endpoint from catalog
 */
export function resolveModel(config: ModelConfig): LanguageModel {
  // BYOK path — explicit provider field wins.
  if (config.byokProvider) {
    const resolved = resolveByokModel({
      provider: config.byokProvider,
      model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
      contextWindow: config.contextWindow,
      nativeContextWindow: config.nativeContextWindow,
      maxOutputTokens: config.maxOutputTokens,
      ollamaBatch: config.ollamaBatch,
    });
    firePiAiShadowProbe(config, resolved.model);
    return resolved.model;
  }

  // BYOK path — `<provider>:<model>` ref in config.model.
  if (typeof config.model === 'string' && isByokRef(config.model)) {
    const { provider, model } = parseByokRef(config.model);
    const resolved = resolveByokModel({
      provider,
      model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
      contextWindow: config.contextWindow,
      nativeContextWindow: config.nativeContextWindow,
      maxOutputTokens: config.maxOutputTokens,
      ollamaBatch: config.ollamaBatch,
    });
    firePiAiShadowProbe(config, resolved.model);
    return resolved.model;
  }

  // Notch path.
  const info = MODEL_CATALOG[config.model as NotchModelId];
  if (!info) {
    throw new Error(
      `Unknown model "${config.model}". Use provider/model, ` +
      'for example openrouter/anthropic/claude-sonnet-4.6.',
    );
  }

  const baseUrl = config.baseUrl
    ?? process.env.NOTCH_BASE_URL
    ?? info.baseUrl;

  const apiKey = config.apiKey ?? process.env.NOTCH_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError({ flow: 'notch', envVar: 'NOTCH_API_KEY', providerLabel: 'Notch' });
  }

  // Modal proxy auth — every Notch endpoint is deployed with
  // requires_proxy_auth=True. Without these headers Modal's edge 401s
  // before the request reaches vLLM. Tokens come from env so they can
  // be rotated without a CLI release.
  const proxyKey = process.env.MODAL_PROXY_KEY;
  const proxySecret = process.env.MODAL_PROXY_SECRET;
  const modalProxyHeaders: Record<string, string> = (proxyKey && proxySecret)
    ? { 'Modal-Key': proxyKey, 'Modal-Secret': proxySecret }
    : {};

  const provider = createOpenAI({
    apiKey,
    baseURL: baseUrl,
    headers: { ...modalProxyHeaders, ...config.headers },
  });

  return provider.chat(config.model as string) as LanguageModel;
}

/**
 * Validate that the configured backend (Notch or BYOK) is reachable.
 *
 * Notch: probes the `/health` endpoint exposed by our Modal serve apps.
 * BYOK:  just sanity-checks base URL + API key presence (most providers
 *        don't expose a consistent health endpoint, and hitting
 *        `/models` would burn rate limit on every `/status` call).
 */
export async function validateConfig(config: ModelConfig): Promise<{ ok: boolean; error?: string }> {
  // BYOK branch.
  if (config.byokProvider) {
    return validateByokConfig({
      provider: config.byokProvider,
      model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
    });
  }
  if (typeof config.model === 'string' && isByokRef(config.model)) {
    const { provider, model } = parseByokRef(config.model);
    return validateByokConfig({
      provider,
      model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      headers: { ...config.headers, ...config.byokHeaders },
      apiShape: config.byokApiShape,
    });
  }

  // Notch branch.
  const info = MODEL_CATALOG[config.model as NotchModelId];
  if (!info) {
    return { ok: false, error: `Unknown model "${config.model}". Available: ${MODEL_IDS.join(', ')}` };
  }

  const baseUrl = config.baseUrl ?? process.env.NOTCH_BASE_URL ?? info.baseUrl;
  const proxyKey = process.env.MODAL_PROXY_KEY;
  const proxySecret = process.env.MODAL_PROXY_SECRET;
  const proxyHeaders: HeadersInit = (proxyKey && proxySecret)
    ? { 'Modal-Key': proxyKey, 'Modal-Secret': proxySecret }
    : {};
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
      headers: proxyHeaders,
    });
    if (!res.ok) {
      return { ok: false, error: `Notch ${info.label} returned ${res.status} at ${baseUrl}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `Cannot reach Notch ${info.label} at ${baseUrl}` };
  }
}

// ---------------------------------------------------------------------------
// pi-ai Phase 1 shadow probe (see pi-mono-integration-plan.md §4 Phase 1)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget probe. When NOTCH_USE_PI_AI=1, attempts to resolve the
 * same BYOK config through pi-ai and logs the outcome to ~/.notch/pi-ai-shadow.jsonl.
 * MUST NOT throw, MUST NOT block the real request, MUST NOT affect the
 * returned LanguageModel. Any failure is swallowed so the flag is safe
 * to enable in production for shadow-mode cost validation.
 */
function firePiAiShadowProbe(config: ModelConfig, resolvedModel: LanguageModel): void {
  if (piAiMode() === 'off') return;
  if (!shouldRouteViaPiAi(config)) return;

  // Register the shadow context synchronously so loop.ts can look up usage
  // later even if the async resolve probe below is still in flight.
  const provider = extractByokProvider(config);
  const modelId = typeof config.model === 'string' ? config.model : 'unknown';
  if (provider) {
    registerShadowContext(resolvedModel as unknown as object, {
      provider,
      modelId,
      config,
    });
  }

  // Run the resolve probe async; do not await. Errors self-swallow.
  void (async () => {
    let handle: PiAiModelHandle | null = null;
    let error: string | null = null;
    try {
      handle = await resolveModelViaPiAi(config);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await recordShadowCost({
      requestId: `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      provider: handle?.piAiProvider ?? provider ?? 'unknown',
      modelId: handle?.modelId ?? modelId,
      inputTokens: 0, // real counts come from loop.ts via recordShadowUsage
      outputTokens: 0,
      piAiCostUsd: null,
      stripeChargeUsd: null,
      timestamp: Date.now(),
      ...(error ? { error } : {}),
    });
  })();
}

function extractByokProvider(config: ModelConfig): string | undefined {
  if (config.byokProvider) return config.byokProvider;
  if (typeof config.model === 'string' && isByokRef(config.model)) {
    return parseByokRef(config.model).provider;
  }
  return undefined;
}

// Re-export BYOK helpers so callers can pull from a single surface.
export {
  findByokProvider,
  listByokProviders,
  isByokRef,
  parseByokRef,
  resolveByokModel,
  validateByokConfig,
  ByokMissingApiKeyError,
  ByokMissingBaseUrlError,
  BUILTIN_BYOK_PROVIDERS,
} from './byok.js';
export type { ByokProvider, ByokSpec, ApiShape } from './byok.js';
