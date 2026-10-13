/**
 * Notch CLI agent-v2 compatibility layer.
 *
 * This file is the source-compatible boundary for the future pi-agent-core
 * runtime. Until the native runtime reaches parity, it delegates to the
 * production v1 loop so feature-flag experiments cannot crash user sessions.
 */

import type { ModelMessage, LanguageModel } from 'ai';
import type { ToolContext } from '../tools/index.js';
import { runAgentLoop } from '../agent/loop.js';

/** Same shape as `../agent/loop.ts` AgentConfig so callers are source-compatible. */
export interface AgentV2Config {
  model: LanguageModel;
  systemPrompt: string;
  toolContext: ToolContext;
  maxIterations?: number;
  contextWindow?: number;
  modelId?: string;
  onTextChunk?: (chunk: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, isError: boolean) => void;
  onCompress?: () => void;
  onSteering?: (message: string) => void;
  onFollowUp?: (message: string) => void;
}

export interface AgentV2Response {
  text: string;
  messages: ModelMessage[];
  iterations: number;
  toolCallCount: number;
  compressed: boolean;
  costUsd: number | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Feature flag. Off by default. */
export function isAgentV2Enabled(): boolean {
  const v = process.env.NOTCH_AGENT_V2;
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Run a prompt through the v2 boundary.
 *
 * The native pi-agent-core implementation is not the default yet; this keeps
 * the v2 API non-throwing and production-safe by using the existing loop.
 */
export async function runAgentV2(
  prompt: string,
  config: AgentV2Config,
): Promise<AgentV2Response> {
  const response = await runAgentLoop([{ role: 'user', content: prompt }], {
    model: config.model,
    systemPrompt: config.systemPrompt,
    toolContext: config.toolContext,
    maxIterations: config.maxIterations,
    contextWindow: config.contextWindow,
    modelId: config.modelId,
    onTextChunk: config.onTextChunk,
    onToolCall: config.onToolCall,
    onToolResult: config.onToolResult,
    onCompress: config.onCompress,
  });

  return {
    text: response.text,
    messages: response.messages,
    iterations: response.iterations,
    toolCallCount: response.toolCallCount,
    compressed: response.compressed,
    costUsd: null,
    usage: response.usage,
  };
}
