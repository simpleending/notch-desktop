/**
 * Notch CLI — Configuration
 *
 * Loads and validates configuration from .notch.json, environment
 * variables, and CLI flags. Priority: CLI flags > env vars > config file > defaults.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelConfig, ModelRoles } from './providers/types.js';
import { isValidModel, findByokProvider, isByokRef, listByokProviders, parseByokRef } from './providers/registry.js';
import type { ThemeId } from './ui/themes.js';
import { loadCredentials, loadSyncedByokKeys } from './auth.js';
import { readOllamaCreds } from './providers/ollama-credentials.js';
import { listModels, showModel } from './providers/ollama.js';
import { ollamaRoot, ollamaChatUrl } from './providers/ollama-url.js';
import { parseAccessMode, type AccessMode } from './permissions/access.js';
import { parseWorkspaceMode } from './concurrency/task-workspace.js';

/**
 * Optional provider block. When `provider` is set the CLI talks to the
 * configured OpenAI-compatible endpoint. Selecting a provider here is equivalent
 * to passing `--provider <id>` on every invocation.
 */
export interface ByokConfigBlock {
  contextWindow?: number;
  ollamaBatch?: number;
  sourceRepo?: string;
  /** Provider id (openai, anthropic, openrouter, together, ...). */
  provider?: string;
  /** Model id at the remote provider (falls back to provider.defaultModel). */
  model?: string;
  /** Override base URL (required for `provider: "custom"`). */
  baseUrl?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Override the provider's default wire protocol. `openai` (default)
   * uses `/v1/chat/completions`; `anthropic` uses `/v1/messages` via the
   * Anthropic SDK. Required only when talking to Ollama's Anthropic-compat
   * endpoint without using the `ollama-anthropic` provider id.
   */
  apiShape?: 'openai' | 'anthropic';
}

export interface NotchConfig {
  workspaceMode?: 'shared' | 'isolated';
  /** Model role assignments */
  models: ModelRoles;
  /** Project root (auto-detected or specified) */
  projectRoot: string;
  /** Whether to auto-confirm destructive actions */
  autoConfirm: boolean;
  /** Max agent iterations per turn */
  maxIterations: number;
  /** Whether to include repo map in system prompt */
  useRepoMap: boolean;
  /** Whether to render markdown in output */
  renderMarkdown: boolean;
  /** Whether to enable the memory system */
  enableMemory: boolean;
  /** Whether to enable hooks */
  enableHooks: boolean;
  /** Permission mode: 'auto' (auto-allow read-only), 'prompt' (confirm all), 'trust' (allow all) */
  permissionMode: 'auto' | 'prompt' | 'trust';
  /** Explicit access profile. Legacy permissionMode remains supported. */
  accessMode?: AccessMode;
  /** Max shell command timeout in ms (default 600_000 = 10 min) */
  shellTimeout?: number;
  /** UI theme */
  theme: ThemeId;
  /** Optional provider passthrough block (mirrors .notch.json "provider"/"byok"). */
  byok?: ByokConfigBlock;
  /**
   * Optional hybrid-routing block. When `enabled: true`, the CLI runs
   * every agent turn against `primary` first and automatically escalates
   * to `fallback` when give-up signals fire (empty response, "I can't"
   * phrasing, iteration cap hit with unfinished tools, or repeated
   * tool errors). Each side is a standard provider spec.
   */
  hybrid?: HybridConfigBlock;
}

/** Mirror of `.notch.json`'s `hybrid` block. */
export interface HybridConfigBlock {
  /** If false (or missing), hybrid routing is off and `primary` is used alone. */
  enabled?: boolean;
  /** Provider spec for the default (cheap/local) model. */
  primary?: ByokConfigBlock;
  /** Provider spec for the fallback (strong/expensive) model. */
  fallback?: ByokConfigBlock;
  /** Cap on fallback runs per turn (default 1). */
  maxFallbacks?: number;
}

const DEFAULT_MODEL: ModelConfig = {
  model: 'openrouter/anthropic/claude-sonnet-4.6',
  temperature: 0.3,
};

const DEFAULTS: NotchConfig = {
  workspaceMode: 'shared',
  models: { chat: DEFAULT_MODEL },
  projectRoot: process.cwd(),
  autoConfirm: false,
  maxIterations: 25,
  useRepoMap: true,
  renderMarkdown: true,
  enableMemory: true,
  enableHooks: true,
  permissionMode: 'auto',
  theme: 'default' as ThemeId,
};

/**
 * Load configuration by merging sources in priority order.
 */
export interface ModelSelection { provider?: string; model?: string; baseUrl?: string; apiKey?: string }

/** A provider change must not inherit another provider's endpoint, protocol or credentials. */
export function selectModel(current: ModelConfig, selection: ModelSelection): ModelConfig {
  const next = { ...current };
  if (selection.provider || selection.model) {
    if (selection.model && selection.model !== current.model) { delete next.sourceRepo; delete next.nativeContextWindow; delete next.maxOutputTokens; }
    const oldProvider = current.byokProvider ?? (isByokRef(current.model) ? parseByokRef(current.model).provider : undefined);
    const provider = selection.provider === 'custom' ? '__custom__' : selection.provider;
    const newProvider = provider ?? (selection.model && isByokRef(selection.model) ? parseByokRef(selection.model).provider : undefined);
    if (newProvider !== oldProvider) {
      delete next.baseUrl;
      delete next.apiKey;
      delete next.byokHeaders;
      delete next.headers;
      delete next.byokApiShape;
      delete next.contextWindow;
      delete next.nativeContextWindow;
      delete next.maxOutputTokens;
      delete next.ollamaBatch;
      delete next.sourceRepo;
    }
    if (provider) {
      const info = findByokProvider(provider);
      if (!info) throw new Error(`Unknown provider: ${selection.provider}. Run notch --list-providers.`);
      next.byokProvider = provider;
      next.model = selection.model || info.defaultModel;
      if (isByokRef(next.model)) {
        const ref = parseByokRef(next.model);
        if (ref.provider !== provider) throw new Error('The --provider and --model provider must match.');
        next.model = ref.model;
      }
    } else if (selection.model) {
      if (!isValidModel(selection.model) && !isByokRef(selection.model)) {
        throw new Error(`Unknown model: ${selection.model}. Use provider/model or pass --provider.`);
      }
      next.model = selection.model;
      delete next.byokProvider;
    }
  }
  if (selection.baseUrl) next.baseUrl = selection.baseUrl;
  if (selection.apiKey) next.apiKey = selection.apiKey;
  return next;
}

export async function loadConfig(overrides: Partial<NotchConfig> = {}, selection: ModelSelection = {}): Promise<NotchConfig> {
  const config = { ...DEFAULTS, projectRoot: path.resolve(overrides.projectRoot ?? process.cwd()), models: { chat: { ...DEFAULT_MODEL } } };
  let explicitModelConfig = false;

  // Try to load .notch.json from project root
  const configPath = path.resolve(config.projectRoot, '.notch.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(raw);
    if (fileConfig.model && (isValidModel(fileConfig.model) || isByokRef(fileConfig.model))) {
      config.models.chat.model = fileConfig.model;
      explicitModelConfig = true;
    }
    if (fileConfig.baseUrl) config.models.chat.baseUrl = fileConfig.baseUrl;
    if (fileConfig.apiKey) config.models.chat.apiKey = fileConfig.apiKey;

    // Optional provider passthrough block.
    //   "provider": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.6" }
    //   "byok":     { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.6" }
    // When set, this overrides the built-in default unless --model was passed.
    const providerBlock = fileConfig.provider && typeof fileConfig.provider === 'object'
      ? fileConfig.provider
      : fileConfig.byok;
    if (providerBlock && typeof providerBlock === 'object') {
      const byok = providerBlock as ByokConfigBlock;
      config.byok = { ...byok };
      if (byok.provider && findByokProvider(byok.provider === 'custom' ? '__custom__' : byok.provider)) {
        config.models.chat.byokProvider = byok.provider === 'custom' ? '__custom__' : byok.provider;
        config.models.chat.model = byok.model || findByokProvider(config.models.chat.byokProvider)!.defaultModel;
        if (byok.baseUrl) config.models.chat.baseUrl = byok.baseUrl;
        if (typeof byok.sourceRepo === 'string') config.models.chat.sourceRepo = byok.sourceRepo;
        if (byok.contextWindow !== undefined) {
          const maximum = ['ollama', 'ollama-anthropic', 'mlx'].includes(byok.provider || '') ? 262144 : 16777216;
          if (!Number.isInteger(byok.contextWindow) || byok.contextWindow < 2048 || byok.contextWindow > maximum) throw new Error(`provider.contextWindow must be an integer between 2048 and ${maximum}.`);
          config.models.chat.contextWindow = byok.contextWindow;
        }
        if (byok.ollamaBatch !== undefined) {
          if (!Number.isInteger(byok.ollamaBatch) || byok.ollamaBatch < 1 || byok.ollamaBatch > 2048) throw new Error('provider.ollamaBatch must be an integer between 1 and 2048.');
          config.models.chat.ollamaBatch = byok.ollamaBatch;
        }
        if (byok.headers) {
          config.models.chat.byokHeaders = { ...config.models.chat.byokHeaders, ...byok.headers };
        }
        if (byok.apiShape === 'openai' || byok.apiShape === 'anthropic') {
          config.models.chat.byokApiShape = byok.apiShape;
        }
        explicitModelConfig = true;
      }
    }
    if (fileConfig.hybrid && typeof fileConfig.hybrid === 'object') {
      const hybrid = fileConfig.hybrid as HybridConfigBlock;
      config.hybrid = hybrid;
    }
    if (fileConfig.maxIterations) config.maxIterations = fileConfig.maxIterations;
    if (fileConfig.useRepoMap !== undefined) config.useRepoMap = fileConfig.useRepoMap;
    if (fileConfig.temperature !== undefined) config.models.chat.temperature = fileConfig.temperature;
    if (fileConfig.renderMarkdown !== undefined) config.renderMarkdown = fileConfig.renderMarkdown;
    if (fileConfig.enableMemory !== undefined) config.enableMemory = fileConfig.enableMemory;
    if (fileConfig.enableHooks !== undefined) config.enableHooks = fileConfig.enableHooks;
    if (fileConfig.permissionMode) config.permissionMode = fileConfig.permissionMode;
    if (fileConfig.accessMode !== undefined) config.accessMode = parseAccessMode(fileConfig.accessMode);
    if (fileConfig.workspaceMode !== undefined) config.workspaceMode = parseWorkspaceMode(fileConfig.workspaceMode);
    if (fileConfig.shellTimeout) config.shellTimeout = fileConfig.shellTimeout;
    if (fileConfig.theme) config.theme = fileConfig.theme;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read ${configPath}: ${(error as Error).message}`);
    }
  }

  // Environment variable model/provider overrides. These run before
  if (process.env.NOTCH_ACCESS_MODE) config.accessMode = parseAccessMode(process.env.NOTCH_ACCESS_MODE);
  // credential loading so a provider default never inherits a Notch token.
  if (process.env.NOTCH_PROVIDER || process.env.NOTCH_MODEL) {
    config.models.chat = selectModel(config.models.chat, { provider: process.env.NOTCH_PROVIDER, model: process.env.NOTCH_MODEL });
    explicitModelConfig = true;
  }
  if (selection.provider || selection.model) {
    config.models.chat = selectModel(config.models.chat, selection);
    explicitModelConfig = true;
  }

  if (!explicitModelConfig) {
    const inferred = await inferDefaultProviderConfig();
    config.models.chat.model = inferred.modelRef;
    config.models.chat.byokProvider = undefined;
    if (inferred.baseUrl) config.models.chat.baseUrl = inferred.baseUrl;
    if (inferred.apiShape) config.models.chat.byokApiShape = inferred.apiShape;
  }

  // Stored credentials. Provider-routed calls resolve their own API key
  // from provider env vars or synced provider keys in providers/byok.ts.
  // A Notch login token is only valid for the legacy hosted Notch path and
  // must never be sent to arbitrary model providers.
  const activeProviderId = config.models.chat.byokProvider
    ?? (typeof config.models.chat.model === 'string' && isByokRef(config.models.chat.model)
      ? parseByokRef(config.models.chat.model).provider
      : undefined);
  const isOllamaProvider =
    activeProviderId === 'ollama' ||
    activeProviderId === 'ollama-cloud' ||
    activeProviderId === 'ollama-anthropic';

  if (isOllamaProvider) {
    // Prefer the Ollama-specific credential file over the Notch token.
    if (!config.models.chat.apiKey && !process.env.OLLAMA_API_KEY) {
      const ollamaCreds = await readOllamaCreds();
      if (ollamaCreds?.apiKey) {
        config.models.chat.apiKey = ollamaCreds.apiKey;
      }
    }
  } else if (!activeProviderId) {
    // Legacy Notch-hosted path only.
    const creds = await loadCredentials();
    if (creds?.token) {
      config.models.chat.apiKey = creds.token;
    }
  }

  // Environment variable overrides
  if (process.env.NOTCH_BASE_URL) {
    config.models.chat.baseUrl = process.env.NOTCH_BASE_URL;
  }
  if (process.env.NOTCH_API_KEY && !activeProviderId) {
    // Env var takes precedence over stored credentials for the legacy path.
    // Provider-routed calls must use provider-specific env vars or --api-key.
    config.models.chat.apiKey = process.env.NOTCH_API_KEY;
  }

  // Temperature validation
  if (config.models.chat.temperature !== undefined) {
    config.models.chat.temperature = Math.max(0, Math.min(2, config.models.chat.temperature));
  }

  // Max iterations validation
  config.maxIterations = Math.max(1, Math.min(100, config.maxIterations));

  // Explicit overrides from CLI flags
  config.models.chat = selectModel(config.models.chat, { baseUrl: selection.baseUrl, apiKey: selection.apiKey });
  return { ...config, ...overrides, workspaceMode: parseWorkspaceMode(overrides.workspaceMode ?? config.workspaceMode), projectRoot: config.projectRoot };
}

async function inferDefaultProviderConfig(): Promise<{
  modelRef: string;
  baseUrl?: string;
  apiShape?: 'openai' | 'anthropic';
}> {
  const providers = listByokProviders();

  const envMatch = providers.find((p) => p.apiKeyEnv && process.env[p.apiKeyEnv]);
  if (envMatch) return { modelRef: `${envMatch.id}/${envMatch.defaultModel}` };

  const synced = await loadSyncedByokKeys();
  if (synced) {
    const syncedMatch = providers.find((p) => {
      const key = synced.keys[p.id as keyof typeof synced.keys];
      return typeof key === 'string' && key.length > 0;
    });
    if (syncedMatch) return { modelRef: `${syncedMatch.id}/${syncedMatch.defaultModel}` };

    if (synced.localEndpoint) {
      return {
        modelRef: 'custom/local-model',
        baseUrl: synced.localEndpoint,
        apiShape: 'openai',
      };
    }
  }

  const localOllama = await inferLocalOllamaModel();
  if (localOllama) return localOllama;

  const openrouter = findByokProvider('openrouter');
  if (openrouter) return { modelRef: `${openrouter.id}/${openrouter.defaultModel}` };

  const first = providers[0];
  return { modelRef: first ? `${first.id}/${first.defaultModel}` : DEFAULT_MODEL.model };
}

async function inferLocalOllamaModel(): Promise<{ modelRef: string; baseUrl?: string } | null> {
  try {
    const baseUrl = ollamaRoot();
    const rows = await listModels(baseUrl, { timeoutMs: 300 });
    const capabilities = await Promise.all(rows.map(row => showModel(row.name, baseUrl, { timeoutMs: 500 }).catch(() => null)));
    const modelName = rows.find((_, index) => capabilities[index]?.capabilities?.includes('tools'))?.name;
    if (!modelName) return null;
    return {
      modelRef: `ollama/${modelName}`,
      baseUrl: ollamaChatUrl(baseUrl),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically merge a partial patch into the project's `.notch.json`.
 *
 * Unlike `loadConfig`, which normalises into the runtime `NotchConfig`
 * shape, this operates on the *on-disk* JSON so each call writes exactly
 * what a human would have hand-edited — no DEFAULT fields added, no
 * stored credentials leaked into the file. Used by persistent-setting
 * slash commands like `/yolo` and by the `notch config set` subcommand.
 *
 * Semantics:
 *   - Reads existing `.notch.json` (missing is `{}`; malformed config is rejected).
 *   - Shallow-merges the patch onto it (undefined values are removed).
 *   - Writes atomically: write to a `.tmp` then rename, so a process
 *     crash mid-write can never leave a truncated file.
 *
 * Returns the merged object so callers can log or re-render from it.
 */
export async function persistConfigPatch(
  projectRoot: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const configPath = path.resolve(projectRoot, '.notch.json');
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    } else {
      throw new Error('.notch.json must contain a JSON object.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  // An explicit provider choice must not silently route through a previous cloud fallback.
  if (patch.provider && !Object.hasOwn(patch, 'hybrid') && current.hybrid && typeof current.hybrid === 'object' && !Array.isArray(current.hybrid)) {
    merged.hybrid = { ...current.hybrid, enabled: false };
  }

  const serialised = JSON.stringify(merged, null, 2) + '\n';
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, serialised, 'utf-8');
  await fs.rename(tmpPath, configPath);
  return merged;
}
