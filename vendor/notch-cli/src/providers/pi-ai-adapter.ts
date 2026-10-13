/**
 * Notch CLI — pi-ai adapter (Phase 1).
 *
 * Feature-flagged shadow probe that resolves BYOK configs through
 * `@earendil-works/pi-ai` alongside the Vercel AI SDK path. Off by
 * default; flip on with:
 *
 *   NOTCH_USE_PI_AI=1                 # enable probe
 *   NOTCH_PI_AI_MODE=shadow|swap      # shadow (default) only logs, swap routes
 *
 * See `pi-mono-integration-plan.md` §4 Phase 1 and `docs/ADOPTING-PI-MONO.md`
 * for the rollout strategy.
 *
 * Design notes:
 *   - pi-ai exports `getModel(provider, modelId)` returning a `Model<Api>`
 *     value. pi-ai does its own stream/complete — it is NOT a Vercel
 *     `LanguageModel`. So `swap` mode is only usable once Phase 2
 *     (pi-agent-core) is in place. For now `swap` throws; `shadow` works.
 *   - pi-ai providers differ from our BYOK list. Unsupported (openrouter,
 *     groq, together) pass through unchanged.
 *   - We dynamic-import pi-ai so the CLI still loads when the dep isn't
 *     installed yet. First call with the flag enabled surfaces a clear
 *     install hint.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { LanguageModel } from 'ai';
import type { ModelConfig } from './types.js';
import { isByokRef, parseByokRef } from './byok.js';

// ---------------------------------------------------------------------------
// Provider mapping
// ---------------------------------------------------------------------------

/**
 * Our BYOK provider id -> pi-ai provider slug. pi-ai's `getModel(provider, id)`
 * uses these exact provider names. Providers not in this map fall through to
 * the AI SDK path (UNSUPPORTED_BY_PI_AI).
 */
const PI_AI_PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'google-vertex': 'google-vertex',
  mistral: 'mistral',
  bedrock: 'amazon-bedrock',
  azure: 'azure-openai-responses',
};

/** Providers we support via AI SDK only (no first-class pi-ai support). */
export const UNSUPPORTED_BY_PI_AI = new Set(['openrouter', 'groq', 'together']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PiAiMode = 'shadow' | 'swap' | 'off';

/** Resolved mode for this process. */
export function piAiMode(): PiAiMode {
  const enabled = process.env.NOTCH_USE_PI_AI;
  if (!enabled || enabled === '0' || enabled.toLowerCase() === 'false') return 'off';
  const mode = (process.env.NOTCH_PI_AI_MODE ?? 'shadow').toLowerCase();
  return mode === 'swap' ? 'swap' : 'shadow';
}

/** Back-compat alias kept so call sites don't all need updating. */
export function isPiAiEnabled(): boolean {
  return piAiMode() !== 'off';
}

/** Can pi-ai handle this config, given the provider and flag state? */
export function shouldRouteViaPiAi(config: ModelConfig): boolean {
  if (piAiMode() === 'off') return false;

  const provider = extractProvider(config);
  if (!provider) return false;
  if (UNSUPPORTED_BY_PI_AI.has(provider)) return false;
  return provider in PI_AI_PROVIDER_MAP;
}

/**
 * Opaque handle for a resolved pi-ai model.
 *
 * We keep the pi-ai types out of our public surface so callers don't have to
 * know anything about pi-ai until Phase 2 migrates the runtime.
 */
export interface PiAiModelHandle {
  /** The pi-ai `Model<Api>` object. Treat as opaque. */
  readonly model: unknown;
  /** The pi-ai provider slug used to resolve the model. */
  readonly piAiProvider: string;
  /** The model id passed to pi-ai. */
  readonly modelId: string;
}

/** Thrown when pi-ai isn't installed but the flag is on. */
export class PiAiNotInstalledError extends Error {
  constructor(originalError: unknown) {
    super(
      `NOTCH_USE_PI_AI is set but @earendil-works/pi-ai could not be loaded. ` +
      `Install with: pnpm --filter @freesyntax/notch-cli add @earendil-works/pi-ai. ` +
      `Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
    );
    this.name = 'PiAiNotInstalledError';
  }
}

/**
 * Resolve a BYOK ModelConfig into a pi-ai Model handle.
 *
 * Throws if the dep isn't installed, the provider isn't mapped, or the
 * model id isn't in pi-ai's registry.
 */
export async function resolveModelViaPiAi(config: ModelConfig): Promise<PiAiModelHandle> {
  const { providerName, modelId } = extractProviderAndModel(config);
  const piAiProvider = PI_AI_PROVIDER_MAP[providerName];
  if (!piAiProvider) {
    throw new Error(
      `pi-ai does not support BYOK provider "${providerName}". ` +
      `Supported: ${Object.keys(PI_AI_PROVIDER_MAP).join(', ')}. ` +
      `Set NOTCH_USE_PI_AI=0 or use a different provider.`,
    );
  }
  if (!modelId) {
    throw new Error(
      `pi-ai resolution requires a non-empty model id. ` +
      `Config: ${JSON.stringify({ byokProvider: config.byokProvider, model: config.model })}`,
    );
  }

  const piAi = await loadPiAi();
  const model = piAi.getBuiltinModel(piAiProvider, modelId);
  if (!model) {
    throw new Error(
      `pi-ai has no registered model "${piAiProvider}/${modelId}". ` +
      `pi-ai only lists tool-calling-capable models; if your model is text-only, ` +
      `keep it on the AI SDK path (UNSUPPORTED_BY_PI_AI) or clear NOTCH_USE_PI_AI.`,
    );
  }

  return { model, piAiProvider, modelId };
}

/**
 * Compute cost in USD for a request using pi-ai's built-in pricing table.
 * Used by the Phase 1 shadow-mode cost comparison.
 *
 * Returns null if pi-ai isn't available or the model isn't known.
 */
export async function computePiAiCostUsd(
  config: ModelConfig,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): Promise<number | null> {
  try {
    const handle = await resolveModelViaPiAi(config);
    const piAi = await loadPiAi();
    // pi-ai's Usage shape: { input, output, cacheRead, cacheWrite, cost: {...} }
    const usageBucket = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    piAi.calculateCost(handle.model as never, usageBucket as never);
    return usageBucket.cost.total;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model-identity registry — lets us correlate a resolved LanguageModel
// back to its BYOK config later, so the loop can record real token counts
// against the original request.
// ---------------------------------------------------------------------------

type ShadowContext = {
  provider: string;
  modelId: string;
  config: ModelConfig;
};

const shadowContexts = new WeakMap<object, ShadowContext>();

/**
 * Attach a shadow context to a resolved model. Called from
 * `registry.ts firePiAiShadowProbe` right after resolving the LanguageModel
 * so the loop can retrieve it later by `model` identity.
 */
export function registerShadowContext(model: object, context: ShadowContext): void {
  if (piAiMode() === 'off') return;
  shadowContexts.set(model, context);
}

/**
 * Record real usage for a shadow request. Called from `loop.ts` after
 * `streamText` finishes and the usage event is available.
 *
 * Fire-and-forget; self-swallows errors so the flag is production-safe.
 */
export async function recordShadowUsage(
  model: object,
  usage: { promptTokens?: number; completionTokens?: number },
  opts?: { stripeChargeUsd?: number | null; requestId?: string },
): Promise<void> {
  if (piAiMode() === 'off') return;
  const ctx = shadowContexts.get(model);
  if (!ctx) return; // not a BYOK request, or resolve-time probe skipped

  const inputTokens = usage.promptTokens ?? 0;
  const outputTokens = usage.completionTokens ?? 0;
  const piAiCostUsd = await computePiAiCostUsd(ctx.config, {
    input: inputTokens,
    output: outputTokens,
  });

  await recordShadowCost({
    requestId: opts?.requestId ?? `usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    provider: ctx.provider,
    modelId: ctx.modelId,
    inputTokens,
    outputTokens,
    piAiCostUsd,
    stripeChargeUsd: opts?.stripeChargeUsd ?? null,
    timestamp: Date.now(),
  });
}

/**
 * Phase 2 placeholder — adapter to LanguageModel. Not implemented; throws
 * so `swap` mode fails fast instead of silently wrong-routing. We'll fill
 * this in if Phase 2 gets delayed and we need pi-ai inside the existing
 * streamText loop.
 */
export function adaptToLanguageModelV1(_handle: PiAiModelHandle): LanguageModel {
  throw new Error(
    'pi-ai -> LanguageModel adapter not implemented. ' +
    'Use NOTCH_PI_AI_MODE=shadow (default) for cost comparison, or wait for ' +
    'Phase 2 (pi-agent-core) which replaces the streamText loop directly.',
  );
}

// ---------------------------------------------------------------------------
// Shadow logging
// ---------------------------------------------------------------------------

export interface ShadowCostEvent {
  requestId: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  piAiCostUsd: number | null;
  stripeChargeUsd: number | null;
  timestamp: number;
  /** Populated when pi-ai resolution failed (dep missing, unknown model, etc). */
  error?: string;
}

/**
 * Record a pi-ai cost estimate for comparison against our Stripe ledger.
 * Defaults to appending a JSON line to ~/.notch/pi-ai-shadow.jsonl so we
 * can diff them out-of-band without a database dependency.
 *
 * A downstream task will wire this into the real billing telemetry stream.
 */
export async function recordShadowCost(event: ShadowCostEvent): Promise<void> {
  if (piAiMode() === 'off') return;
  try {
    const { homedir } = await import('node:os');
    const { mkdir, appendFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(homedir(), '.notch');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'pi-ai-shadow.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Shadow logging must never break a real request. Swallow.
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface PiAiModuleShape {
  getBuiltinModel: (provider: string, modelId: string) => unknown;
  calculateCost: (model: unknown, usage: unknown) => unknown;
}

let piAiModulePromise: Promise<PiAiModuleShape> | null = null;

async function loadPiAi(): Promise<PiAiModuleShape> {
  if (!piAiModulePromise) {
    piAiModulePromise = (async () => {
      try {
        const [catalog, mod] = await Promise.all([
          import('@earendil-works/pi-ai/providers/all'), import('@earendil-works/pi-ai'),
        ]);
        return { getBuiltinModel: catalog.getBuiltinModel, calculateCost: mod.calculateCost } as unknown as PiAiModuleShape;
      } catch (err) {
        piAiModulePromise = null; // allow retry after install
        throw new PiAiNotInstalledError(err);
      }
    })();
  }
  return piAiModulePromise;
}

function extractProvider(config: ModelConfig): string | undefined {
  if (config.byokProvider) return config.byokProvider;
  if (typeof config.model === 'string' && isByokRef(config.model)) {
    return parseByokRef(config.model).provider;
  }
  return undefined;
}

function extractProviderAndModel(config: ModelConfig): { providerName: string; modelId: string } {
  if (config.byokProvider) {
    return {
      providerName: config.byokProvider,
      modelId: typeof config.model === 'string' ? config.model : '',
    };
  }
  if (typeof config.model === 'string' && isByokRef(config.model)) {
    const { provider, model } = parseByokRef(config.model);
    return { providerName: provider, modelId: model };
  }
  throw new Error(
    'resolveModelViaPiAi called on a non-BYOK config. Notch-hosted Modal ' +
    'endpoints still use the AI SDK path.',
  );
}
