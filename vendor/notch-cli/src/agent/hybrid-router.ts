/**
 * Notch CLI — Hybrid Routing
 *
 * Detects when a local (Ollama / LM Studio / vLLM) model has given up on
 * a turn and transparently re-runs the same turn against a stronger
 * model. Triggered opt-in via `.notch.json`:
 *
 *   "hybrid": {
 *     "enabled": true,
 *     "primary":  { "provider": "ollama", "model": "qwen3-coder:30b" },
 *     "fallback": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.6" }
 *   }
 *
 * The detection is signal-driven (not LLM-judge-driven) so there's no
 * extra model spend. Signals:
 *   - Primary returned text containing a "give up" phrase (I can't, I'm
 *     unable to, I don't have access ...).
 *   - Primary produced an empty text response with zero tool calls.
 *   - Primary hit maxIterations with a still-in-progress tool loop.
 *   - Primary repeated the same error signature twice.
 *
 * None of these signals require us to modify `runAgentLoop` — the router
 * wraps it. The existing loop-level repeated-error detection feeds us
 * through the `errorRepeated` boolean we see in the AgentResponse.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { LanguageModel, ModelMessage } from 'ai';
import { toolResultValue } from '../messages.js';
import { runAgentLoop, type AgentConfig, type AgentResponse } from './loop.js';

export interface HybridConfig {
  /** Whether to activate the router at all. */
  enabled: boolean;
  /** Factory that yields the primary LanguageModel (called once per turn). */
  primary: () => LanguageModel;
  /** Factory that yields the fallback LanguageModel (called only on escalation). */
  fallback: () => LanguageModel;
  /**
   * Optional callback fired whenever the router decides to escalate.
   * Used by the TUI to print a dimmed `↑ escalated` indicator.
   */
  onEscalate?: (reason: EscalationReason) => void;
  /**
   * Maximum number of fallback runs per turn (default 1). Guards against
   * a pathological fallback also failing and triggering an infinite loop.
   */
  maxFallbacks?: number;
}

export type EscalationReason =
  | 'empty-response'
  | 'give-up-phrase'
  | 'iteration-exhausted'
  | 'repeated-error';

/**
 * Regex list of give-up phrases. Case-insensitive. Kept conservative —
 * false positives trigger unnecessary fallback spend, false negatives
 * just mean no escalation (safe). Patterns sourced from empirical local
 * model behavior on coding tasks: Llama/Qwen/Gemma "I cannot" variants.
 */
const GIVE_UP_PATTERNS: RegExp[] = [
  /\bi\s+(?:am\s+unable|can(?:not|'t))\s+(?:help|assist|do|complete|execute)\b/i,
  /\bi\s+don'?t\s+have\s+(?:access|permission|the\s+ability)\b/i,
  /\bi'?m\s+unable\s+to\b/i,
  /\bas\s+an\s+ai\s+(?:language\s+)?model\b/i,
  /\bi\s+apologize,?\s+but\s+i\s+cannot\b/i,
];

/** Classify a completed agent response into an escalation reason, or null. */
export function classifyResponse(
  response: AgentResponse,
  opts: { maxIterations: number },
): EscalationReason | null {
  if (!response.text.trim() && response.toolCallCount === 0) {
    return 'empty-response';
  }
  if (response.iterations >= opts.maxIterations && response.toolCallCount > 0) {
    return 'iteration-exhausted';
  }
  for (const pat of GIVE_UP_PATTERNS) {
    if (pat.test(response.text)) return 'give-up-phrase';
  }
  return null;
}

/**
 * Inspect the message history for consecutive identical tool errors.
 * `runAgentLoop` already injects a hint after two repeats; this check
 * triggers a full-escalation on the *third* repeat so we don't thrash.
 */
export function detectRepeatedError(history: readonly ModelMessage[]): boolean {
  const errorSignatures: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'tool') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const record = part as { type?: string; output?: unknown; toolName?: string };
      if (record.type !== 'tool-result') continue;
      const result = toolResultValue(record);
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
      if (/error|failed|denied/i.test(text)) {
        errorSignatures.push(`${record.toolName ?? ''}::${text.slice(0, 80)}`);
      }
    }
  }
  if (errorSignatures.length < 3) return false;
  const tail = errorSignatures.slice(-3);
  return tail[0] === tail[1] && tail[1] === tail[2];
}

/**
 * Drop-in replacement for `runAgentLoop` when hybrid routing is active.
 * Signature matches `runAgentLoop` exactly — the hybrid config is
 * captured once via `bindHybridLoop` and closed over. The caller
 * doesn't need to thread an extra argument through every call-site.
 *
 * When `hybrid.enabled === false`, `config.model` is used directly and
 * the function is a pass-through for `runAgentLoop`.
 */
export function bindHybridLoop(
  hybrid: HybridConfig,
): (messages: ModelMessage[], config: AgentConfig) => Promise<AgentResponse> {
  return async (initialMessages, config) => {
    const maxIterations = config.maxIterations ?? 25;

    // Primary run. When hybrid is off we reuse whatever model the caller
    // already placed in config.model — avoids constructing a second
    // language model for no reason.
    const primaryModel = hybrid.enabled ? hybrid.primary() : config.model;
    const primaryResponse = await runAgentLoop(initialMessages, {
      ...config,
      model: primaryModel,
    });

    if (!hybrid.enabled) return primaryResponse;

    const signal = classifyResponse(primaryResponse, { maxIterations })
      ?? (detectRepeatedError(primaryResponse.messages) ? 'repeated-error' : null);
    if (!signal) return primaryResponse;

    hybrid.onEscalate?.(signal);

    const maxFallbacks = Math.max(1, hybrid.maxFallbacks ?? 1);
    let response = primaryResponse;
    for (let i = 0; i < maxFallbacks; i++) {
      const fallbackResponse = await runAgentLoop([...response.messages, {
        role: 'user', content: 'Continue the original task from the current state. Previous tool actions already ran; use their results and do not repeat completed actions.',
      }], {
        ...config,
        model: hybrid.fallback(),
      });
      const input = (response.usage?.promptTokens ?? 0) + (fallbackResponse.usage?.promptTokens ?? 0);
      const output = (response.usage?.completionTokens ?? 0) + (fallbackResponse.usage?.completionTokens ?? 0);
      response = { ...fallbackResponse,
        iterations: response.iterations + fallbackResponse.iterations,
        toolCallCount: response.toolCallCount + fallbackResponse.toolCallCount,
        compressed: response.compressed || fallbackResponse.compressed,
        correctionAttempts: response.correctionAttempts + fallbackResponse.correctionAttempts,
        usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
      };
      const stillBad = classifyResponse(fallbackResponse, { maxIterations })
        ?? (detectRepeatedError(fallbackResponse.messages) ? 'repeated-error' : null);
      if (!stillBad) break;
    }
    return response;
  };
}
