import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from '../auth.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 7;

export interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  expiration_date?: string | null;
}

export interface OpenRouterCodingModel {
  id: string;
  modelRef: string;
  name: string;
  contextLength: number;
  promptPrice: string | null;
  completionPrice: string | null;
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  description?: string;
}

export interface OpenRouterCodingResult {
  models: OpenRouterCodingModel[];
  source: 'live' | 'cache' | 'fallback';
  fetchedAt?: string;
  warning?: string;
}

const FALLBACK_CODING_MODELS: OpenRouterCodingModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    modelRef: 'openrouter/anthropic/claude-sonnet-4.6',
    name: 'Anthropic: Claude Sonnet 4.6',
    contextLength: 1_000_000,
    promptPrice: '0.000003',
    completionPrice: '0.000015',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'openai/gpt-5.4',
    modelRef: 'openrouter/openai/gpt-5.4',
    name: 'OpenAI: GPT-5.4',
    contextLength: 1_050_000,
    promptPrice: '0.0000025',
    completionPrice: '0.000015',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'google/gemini-3.5-flash',
    modelRef: 'openrouter/google/gemini-3.5-flash',
    name: 'Google: Gemini 3.5 Flash',
    contextLength: 1_048_576,
    promptPrice: '0.0000015',
    completionPrice: '0.000009',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    modelRef: 'openrouter/deepseek/deepseek-v4-flash',
    name: 'DeepSeek: DeepSeek V4 Flash',
    contextLength: 1_048_576,
    promptPrice: '0.0000001',
    completionPrice: '0.0000002',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    modelRef: 'openrouter/moonshotai/kimi-k2.6',
    name: 'MoonshotAI: Kimi K2.6',
    contextLength: 262_144,
    promptPrice: '0.00000073',
    completionPrice: '0.00000349',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'qwen/qwen3.7-max',
    modelRef: 'openrouter/qwen/qwen3.7-max',
    name: 'Qwen: Qwen3.7 Max',
    contextLength: 1_000_000,
    promptPrice: '0.0000025',
    completionPrice: '0.0000075',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'x-ai/grok-build-0.1',
    modelRef: 'openrouter/x-ai/grok-build-0.1',
    name: 'xAI: Grok Build 0.1',
    contextLength: 256_000,
    promptPrice: '0.000001',
    completionPrice: '0.000002',
    supportsTools: true,
    supportsStructuredOutputs: true,
  },
];

function cachePath(): string {
  return path.join(getConfigDir(), 'openrouter-coding-models.json');
}

function toCodingModel(model: OpenRouterModel): OpenRouterCodingModel {
  const supported = model.supported_parameters ?? [];
  return {
    id: model.id,
    modelRef: `openrouter/${model.id}`,
    name: model.name ?? model.id,
    contextLength: model.top_provider?.context_length ?? model.context_length ?? 0,
    promptPrice: model.pricing?.prompt ?? null,
    completionPrice: model.pricing?.completion ?? null,
    supportsTools: supported.includes('tools'),
    supportsStructuredOutputs: supported.includes('structured_outputs'),
    description: model.description,
  };
}

function isUsableCodingModel(model: OpenRouterModel): boolean {
  if (!model.id) return false;
  if (model.expiration_date) return false;

  const output = model.architecture?.output_modalities ?? [];
  if (output.length > 0 && !output.includes('text')) return false;

  const supported = model.supported_parameters ?? [];
  return supported.includes('tools') || supported.includes('tool_choice');
}

export function selectTopOpenRouterCodingModels(
  models: OpenRouterModel[],
  limit = DEFAULT_LIMIT,
): OpenRouterCodingModel[] {
  return models
    .filter(isUsableCodingModel)
    .slice(0, Math.max(1, limit))
    .map(toCodingModel);
}

async function readCache(limit: number): Promise<OpenRouterCodingResult | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { fetchedAt?: string; models?: OpenRouterCodingModel[] };
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return {
      models: parsed.models.slice(0, limit),
      source: 'cache',
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
}

async function writeCache(models: OpenRouterCodingModel[], fetchedAt: string): Promise<void> {
  try {
    await fs.mkdir(getConfigDir(), { recursive: true });
    await fs.writeFile(
      cachePath(),
      JSON.stringify({ fetchedAt, models }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch {
    // Cache writes are an optimization only.
  }
}

function isFreshCache(result: OpenRouterCodingResult): boolean {
  if (!result.fetchedAt) return false;
  const fetched = Date.parse(result.fetchedAt);
  return Number.isFinite(fetched) && Date.now() - fetched < CACHE_TTL_MS;
}

async function fetchOpenRouterProgrammingModels(timeoutMs: number): Promise<OpenRouterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'HTTP-Referer': 'https://driftrail.com/notch',
      'X-Title': 'Notch CLI',
    };
    if (process.env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    }

    const url = `${OPENROUTER_MODELS_URL}?category=programming`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter models request failed (${res.status}): ${body.slice(0, 160) || res.statusText}`);
    }

    const json = await res.json() as { data?: OpenRouterModel[] };
    if (!Array.isArray(json.data)) {
      throw new Error('OpenRouter models response did not include a data array');
    }
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOpenRouterCodingModels(options: {
  limit?: number;
  preferCache?: boolean;
  timeoutMs?: number;
} = {}): Promise<OpenRouterCodingResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cached = await readCache(limit);
  if (options.preferCache && cached && isFreshCache(cached)) return cached;

  try {
    const models = selectTopOpenRouterCodingModels(
      await fetchOpenRouterProgrammingModels(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      limit,
    );
    if (models.length === 0) throw new Error('OpenRouter returned no tool-capable programming models');
    const fetchedAt = new Date().toISOString();
    await writeCache(models, fetchedAt);
    return { models, source: 'live', fetchedAt };
  } catch (err) {
    if (cached) {
      return {
        ...cached,
        warning: (err as Error).message,
      };
    }
    return {
      models: FALLBACK_CODING_MODELS.slice(0, limit),
      source: 'fallback',
      fetchedAt: new Date().toISOString(),
      warning: (err as Error).message,
    };
  }
}

export function formatOpenRouterPricePerMillion(value: string | null): string {
  if (value == null) return '?';
  const perToken = Number(value);
  if (!Number.isFinite(perToken)) return '?';
  const perMillion = perToken * 1_000_000;
  if (perMillion === 0) return '$0';
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(2)}`;
}

export function formatContextLength(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
