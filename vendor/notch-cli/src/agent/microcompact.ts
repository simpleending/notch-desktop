/**
 * Notch CLI — Microcompact
 *
 * Selective clearing of OLD tool-result payloads for a safe allowlist of
 * tools. Microcompact is the CHEAP first-line defense against context bloat:
 * zero model cost, pure-function, preserves the assistant -> tool-call ->
 * tool-result triplet structure the AI SDK requires.
 *
 * For each tool-result message OLDER than the last N (default 6) whose
 * tool name is in MICROCOMPACT_ALLOWLIST, we replace the tool result's
 * `result` field with the literal string:
 *
 *     [Old tool result content cleared]
 *
 * toolCallId and toolName are preserved so the message structure stays
 * valid. Assistant and user messages are NEVER touched. Tool results whose
 * tool is NOT on the allowlist (e.g. sub-agent spawns that carry forward
 * context) are left untouched.
 *
 * This is intentionally a no-op until the conversation grows past a small
 * threshold; for short chats the savings wouldn't cover the overhead.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { ModelMessage } from 'ai';
import { toolOutput, toolResultValue } from '../messages.js';

/** Literal placeholder inserted in place of cleared tool results. */
export const MICROCOMPACT_CLEARED_MESSAGE = '[Old tool result content cleared]';

/**
 * Tools whose results are safe to clear once they're out of the recent
 * window. These are all *observational* tools — the model sees the result,
 * acts on it in the next turn or two, and after that the raw payload
 * generally doesn't help. Tools that produce *continuation context*
 * (task/agent spawns, long-running processes with state) are deliberately
 * omitted.
 */
export const MICROCOMPACT_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'read',
  'bash',
  'shell',
  'grep',
  'glob',
  'web_fetch',
  'webfetch',
  'web_search',
  'websearch',
  'edit',
  'write',
  'apply_patch',
  'applypatch',
  'notebook',
]);

export interface MicrocompactOptions {
  /**
   * Preserve the last N tool-result messages verbatim. Default 6.
   * Anything older than this window is eligible for clearing.
   */
  keepLastN?: number;
  /**
   * Don't run at all unless total message count exceeds this threshold.
   * Default 50. Small conversations don't benefit from clearing.
   */
  threshold?: number;
}

export interface MicrocompactStats {
  messages: ModelMessage[];
  /** Number of tool-result blocks whose `result` was replaced. */
  cleared: number;
  /**
   * Rough byte savings (JSON-stringified length before minus after).
   * Not a token count — callers can feed it to estimateTokens if needed.
   */
  savedChars: number;
}

/**
 * Length of a value in characters when JSON-serialized. Used for savings
 * accounting; kept inline so microcompact has zero runtime deps.
 */
function serializedLength(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

/**
 * Normalize a tool name for allowlist lookup. The AI SDK surfaces tool
 * names the way they're registered (e.g. `shell`, `web_fetch`, `Bash`);
 * we lowercase and strip common separators so the allowlist is forgiving.
 */
function normalizeToolName(name: string | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[-\s]+/g, '_');
}

/**
 * Pure function: produce a new messages array with old tool results
 * cleared. Preserves ordering, toolCallId, toolName; mutates nothing.
 */
export function microcompact(
  messages: ModelMessage[],
  opts: MicrocompactOptions = {},
): MicrocompactStats {
  const keepLastN = opts.keepLastN ?? 6;
  const threshold = opts.threshold ?? 50;

  if (messages.length <= threshold) {
    return { messages, cleared: 0, savedChars: 0 };
  }

  // Index every tool-result MESSAGE (role === 'tool'). We clear whole
  // result entries, not whole messages — a single tool message may carry
  // multiple results if the assistant invoked several tools in one round.
  const toolMessageIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') {
      toolMessageIndices.push(i);
    }
  }

  // Which tool messages are "old enough" to be eligible? Keep the last N
  // tool messages untouched; everything before is eligible.
  const eligibleUpTo = toolMessageIndices.length - keepLastN;
  if (eligibleUpTo <= 0) {
    return { messages, cleared: 0, savedChars: 0 };
  }
  const eligible = new Set(toolMessageIndices.slice(0, eligibleUpTo));

  let cleared = 0;
  let savedChars = 0;

  const out: ModelMessage[] = messages.map((msg, idx) => {
    if (msg.role !== 'tool' || !eligible.has(idx)) {
      return msg;
    }
    if (!Array.isArray(msg.content)) return msg;

    let touched = false;
    const newContent = msg.content.map((block) => {
      // Tool-result block shape: { type: 'tool-result', toolCallId, toolName, result, isError? }
      const b = block as unknown as Record<string, unknown>;
      if (b.type !== 'tool-result') return block;

      const toolName = normalizeToolName(b.toolName as string | undefined);
      if (!MICROCOMPACT_ALLOWLIST.has(toolName)) return block;

      // Already cleared? skip (idempotent).
      if (toolResultValue(b) === MICROCOMPACT_CLEARED_MESSAGE) return block;

      savedChars += Math.max(0, serializedLength(toolResultValue(b)) - MICROCOMPACT_CLEARED_MESSAGE.length);
      cleared++;
      touched = true;

      return {
        ...block,
        output: toolOutput(MICROCOMPACT_CLEARED_MESSAGE),
      } as typeof block;
    });

    if (!touched) return msg;
    return { ...msg, content: newContent } as ModelMessage;
  });

  return { messages: out, cleared, savedChars };
}
