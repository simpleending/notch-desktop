/**
 * Notch CLI — Model Provider Types
 *
 * Configuration for connecting to the Notch model API.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { LanguageModel } from 'ai';

/** Notch model tiers */
export type NotchModelId = 'notch-pyre' | 'notch-ignis' | 'notch-solace' | 'notch-solace-lite';

/** Metadata for each Notch model */
export interface NotchModelInfo {
  id: NotchModelId;
  /** Human-readable label */
  label: string;
  /** Parameter count */
  size: string;
  /** GPU used for inference */
  gpu: string;
  /** Max context window in tokens */
  contextWindow: number;
  /** Default max output tokens */
  maxOutputTokens: number;
  /** Direct Modal vLLM endpoint */
  baseUrl: string;
  /**
   * Hardware requirements for running the model *locally*. All values
   * target Q4_K_M quantization via llama.cpp / Ollama. Full-precision
   * weights will be roughly 3-4× larger and require more VRAM.
   */
  hardware: {
    /** Minimum VRAM in GB for Q4 inference. */
    vramGb: number;
    /** Minimum system RAM in GB. */
    ramGb: number;
    /** Disk space for the Q4 merged weights in GB. */
    diskGb: number;
    /** Recommended GPU class (e.g. "L40S", "A100-80GB", "RTX 4090"). */
    recommendedGpu: string;
    /** Tier label for the picker UI ("light" / "standard" / "heavy"). */
    tier: 'light' | 'standard' | 'heavy';
  };
  /**
   * Hugging Face Hub repository for the merged local-inference weights.
   * `huggingface-cli download <repo>` pulls these; null means the model
   * is hosted-only (not yet released for local download).
   */
  hfRepo: string | null;
}

/**
 * Configuration for the active model.
 *
 * `model` accepts either a Notch model id (default) or a BYOK ref of the
 * form `<provider>:<remote-model>` (e.g. `openrouter:anthropic/claude-sonnet-4.6`).
 * The `:` separator is safe because no Notch model id contains one.
 */
export interface ModelConfig {
  /** Notch model id OR a BYOK ref (`<provider>:<model>`). */
  model: NotchModelId | string;
  /** API key for authentication */
  apiKey?: string;
  /** Override base URL (defaults to the model's Modal endpoint) */
  baseUrl?: string;
  /** Max context window in tokens (auto-set from model catalog) */
  contextWindow?: number;
  /** Memory-sensitive native Ollama prompt batch size. */
  ollamaBatch?: number;
  sourceRepo?: string;
  /** Max output tokens (auto-set from model catalog) */
  maxOutputTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Custom headers for API requests */
  headers?: Record<string, string>;
  /** When set, routes through a BYOK provider instead of Notch. */
  byokProvider?: string;
  /** Extra BYOK-only headers (merged after provider defaults). */
  byokHeaders?: Record<string, string>;
  /**
   * Override the BYOK provider's default wire protocol. `openai` (default
   * for most providers) uses the OpenAI Chat Completions API; `anthropic`
   * uses the Anthropic Messages API. Useful with Ollama, whose daemon
   * serves both shapes from port 11434.
   */
  byokApiShape?: 'openai' | 'anthropic';
}

/** Role assignments — different Notch models for different tasks */
export interface ModelRoles {
  /** Primary chat/agent model */
  chat: ModelConfig;
  /** Fast model for autocomplete/suggestions (optional, defaults to chat) */
  fast?: ModelConfig;
  /** Model for generating embeddings (optional) */
  embed?: ModelConfig;
}
