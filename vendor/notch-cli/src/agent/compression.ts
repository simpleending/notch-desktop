/**
 * Context reduction under pressure: bound old tool results, summarize older
 * turns, then fall back if still over budget. Keep original/current requests
 * and complete tool chains. The desktop archives the raw transcript first.
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { ModelMessage, LanguageModel } from 'ai';
import { generateText } from 'ai';
import { contextBudget, estimateTextTokens } from './context-budget.js';
import { createHash } from 'node:crypto';
import { toolOutput, toolResultValue } from '../messages.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough estimate of token count from messages.
 * Uses ~4 chars per token as a conservative heuristic.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  return estimateTextTokens(messages.map(message => JSON.stringify(message)).join("\n"));
}

// ---------------------------------------------------------------------------
// Artifact store — backs Budget Reduction & Context Collapse
// ---------------------------------------------------------------------------

/**
 * Stashes full content for items that compaction replaces with references.
 * The default implementation is an in-memory Map; Cloud and session-backed
 * runtimes can inject a persistent store (Supabase row, S3 object, etc.)
 * so originals survive process restarts and resume.
 */
export interface ArtifactStore {
  put(key: string, value: string): void | Promise<void>;
  get(key: string): string | undefined | Promise<string | undefined>;
  has?(key: string): boolean | Promise<boolean>;
}

class InMemoryArtifactStore implements ArtifactStore {
  private readonly map = new Map<string, string>();
  put(key: string, value: string): void {
    this.map.set(key, value);
  }
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
}

let globalArtifactStore: ArtifactStore = new InMemoryArtifactStore();

/**
 * Install a session-scoped artifact store (e.g. Supabase-backed in Cloud).
 * Returns a disposer that restores the previous store.
 */
export function setArtifactStore(store: ArtifactStore): () => void {
  const prev = globalArtifactStore;
  globalArtifactStore = store;
  return () => {
    globalArtifactStore = prev;
  };
}

export function getArtifactStore(): ArtifactStore {
  return globalArtifactStore;
}

/** Opaque URI format: notch-artifact://<sha1-16> */
const ARTIFACT_URI_PREFIX = 'notch-artifact://';

function artifactKey(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

function makeArtifactUri(key: string): string {
  return `${ARTIFACT_URI_PREFIX}${key}`;
}

/** Parse a Budget Reduction reference marker back to its artifact key. */
export function parseArtifactUri(text: string): string | null {
  const match = text.match(/notch-artifact:\/\/([a-f0-9]{8,64})/);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// Layer 1 — Budget Reduction
// ---------------------------------------------------------------------------

/** Default maximum chars kept inline for any one tool result */
const BUDGET_TOOL_RESULT_MAX = 3000;
/** Preview bytes kept inline when stashing full content */
const BUDGET_PREVIEW_CHARS = 400;

export interface BudgetReduceOptions {
  /** Max chars to keep inline for any single tool result. */
  maxToolResultChars?: number;
  /** Bytes to retain as a human-readable preview. */
  previewChars?: number;
  /** Never stash the last N tool messages. Default 4. */
  keepLastN?: number;
  /** Alternative artifact store (defaults to the installed store). */
  store?: ArtifactStore;
}

export interface BudgetReduceStats {
  messages: ModelMessage[];
  /** Count of tool-result blocks that were stashed. */
  stashed: number;
  /** Approximate chars saved from the in-context history. */
  savedChars: number;
}

/**
 * Cap oversized tool results, stashing full content to the artifact store
 * and replacing the inline payload with `{ preview, ref }`. Safe to run
 * every turn. No model cost.
 */
export function budgetReduce(
  messages: ModelMessage[],
  opts: BudgetReduceOptions = {},
): BudgetReduceStats {
  const maxChars = opts.maxToolResultChars ?? BUDGET_TOOL_RESULT_MAX;
  const previewChars = opts.previewChars ?? BUDGET_PREVIEW_CHARS;
  const keepLastN = opts.keepLastN ?? 4;
  const store = opts.store ?? globalArtifactStore;

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') toolIdx.push(i);
  }
  const eligibleUpTo = toolIdx.length - keepLastN;
  if (eligibleUpTo <= 0) return { messages, stashed: 0, savedChars: 0 };
  const eligible = new Set(toolIdx.slice(0, eligibleUpTo));

  let stashed = 0;
  let savedChars = 0;

  const out: ModelMessage[] = messages.map((msg, idx) => {
    if (msg.role !== 'tool' || !eligible.has(idx)) return msg;
    if (!Array.isArray(msg.content)) return msg;

    let touched = false;
    const newContent = msg.content.map((block) => {
      const b = block as unknown as Record<string, unknown>;
      if (b.type !== 'tool-result') return block;

      // Measure current result size.
      const resultStr =
        typeof toolResultValue(b) === 'string' ? toolResultValue(b) as string : JSON.stringify(toolResultValue(b) ?? '');
      if (resultStr.length <= maxChars) return block;

      const key = artifactKey(resultStr);
      try {
        void store.put(key, resultStr);
      } catch {
        // Store failures must never break the agent loop.
        return block;
      }

      const preview = resultStr.slice(0, previewChars);
      const replacement =
        `${preview}\n... [+${resultStr.length - previewChars} chars stashed at ${makeArtifactUri(key)}]`;
      savedChars += resultStr.length - replacement.length;
      stashed++;
      touched = true;

      return {
        ...block,
        output: toolOutput(replacement),
      } as typeof block;
    });

    if (!touched) return msg;
    return { ...msg, content: newContent } as ModelMessage;
  });

  return { messages: out, stashed, savedChars };
}

// ---------------------------------------------------------------------------
// Layer 2 — Snip (age-based removal)
// ---------------------------------------------------------------------------

export interface SnipOptions {
  /** Preserve the first N messages verbatim. Default 1 (original task). */
  keepStart?: number;
  /** Preserve the last N messages verbatim. Default 6. */
  keepRecent?: number;
  /** Only run if middle-span exceeds this count. Default 40. */
  triggerMiddleCount?: number;
  /** Remove this many messages from the start of the middle span. Default 10. */
  snipCount?: number;
}

export interface SnipStats {
  messages: ModelMessage[];
  /** Number of messages removed. */
  snipped: number;
}

/**
 * Age-based removal: when the middle span grows large, drop the oldest N
 * messages and insert a single synthetic marker. Assistant/tool message
 * pairs are removed together to keep the tool_use/tool_result chain valid.
 */
export function snip(messages: ModelMessage[], opts: SnipOptions = {}): SnipStats {
  const keepStart = opts.keepStart ?? 1;
  const keepRecent = opts.keepRecent ?? 6;
  const trigger = opts.triggerMiddleCount ?? 40;
  const snipCount = opts.snipCount ?? 10;

  if (messages.length < keepStart + keepRecent + trigger) {
    return { messages, snipped: 0 };
  }

  const head = messages.slice(0, keepStart);
  const tail = messages.slice(-keepRecent);
  const middle = messages.slice(keepStart, messages.length - keepRecent);

  // Find a safe cut point: next message-boundary after snipCount that is
  // NOT a 'tool' role (so we don't leave a tool_result orphaned from its
  // tool_use block).
  let cut = Math.min(snipCount, middle.length);
  while (cut < middle.length && middle[cut]!.role === 'tool') cut++;

  const dropped = middle.slice(0, cut);
  const kept = middle.slice(cut);

  if (dropped.length === 0) return { messages, snipped: 0 };

  const marker: ModelMessage = {
    role: 'user',
    content: `[snip: ${dropped.length} older messages removed by age]`,
  };

  return {
    messages: [...head, marker, ...kept, ...tail],
    snipped: dropped.length,
  };
}

// ---------------------------------------------------------------------------
// Layer 3 — MicroCompact (zero-cost local edits)
// ---------------------------------------------------------------------------

/** Maximum chars to keep for a single tool result */
const TOOL_RESULT_MAX = 3000;
/** Maximum chars for a single text content block */
const TEXT_BLOCK_MAX = 8000;

/**
 * Tier 1: Collapse large tool results and trim oversized text blocks.
 * No API calls — just local string trimming. Safe to run every turn.
 */
export function microCompact(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!;
    // Never touch the first message (initial user request) or last 4 messages
    if (idx === 0 || idx >= messages.length - 4) {
      result.push(msg);
      continue;
    }

    if (typeof msg.content === 'string' && msg.content.length > TEXT_BLOCK_MAX && msg.role === 'assistant') {
      result.push({
        ...msg,
        content: msg.content.slice(0, TEXT_BLOCK_MAX) + '\n... [truncated]',
      } as ModelMessage);
      continue;
    }

    result.push(msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer 4 — Context Collapse (non-destructive summary projection)
// ---------------------------------------------------------------------------

export interface ContextCollapseOptions {
  /** Preserve the first N messages verbatim. Default 1. */
  keepStart?: number;
  /** Preserve the last N messages verbatim. Default 4. */
  keepRecent?: number;
  /**
   * Only collapse if the middle span exceeds this many messages. Default 12.
   * Distinct from autoCompact threshold — Context Collapse is a CHEAPER
   * intermediary that produces a deterministic summary without a model call.
   */
  triggerMiddleCount?: number;
  /** Alternative artifact store. */
  store?: ArtifactStore;
}

export interface ContextCollapseStats {
  messages: ModelMessage[];
  collapsed: boolean;
  /** Artifact key where the original middle span is stashed. */
  artifactKey?: string;
}

/**
 * Replace the middle span with a deterministic summary message while
 * stashing the ORIGINAL middle messages in the artifact store. This is
 * non-destructive: on session resume the full transcript can be rebuilt
 * from the artifact. Unlike AutoCompact (Layer 5), Context Collapse does
 * NOT call the model — it uses the deterministic summarizer.
 */
export function contextCollapse(
  messages: ModelMessage[],
  opts: ContextCollapseOptions = {},
): ContextCollapseStats {
  const keepStart = opts.keepStart ?? 1;
  const keepRecent = opts.keepRecent ?? 4;
  const trigger = opts.triggerMiddleCount ?? 12;
  const store = opts.store ?? globalArtifactStore;

  if (messages.length < keepStart + keepRecent + trigger) {
    return { messages, collapsed: false };
  }

  const head = messages.slice(0, keepStart);
  const middle = messages.slice(keepStart, messages.length - keepRecent);
  const tail = messages.slice(-keepRecent);
  if (middle.length === 0) return { messages, collapsed: false };

  // Stash originals for resume.
  let key: string | undefined;
  try {
    const serialized = JSON.stringify(middle);
    key = artifactKey(serialized);
    void store.put(key, serialized);
  } catch {
    // Store failure: still safe to project summary, just loses resume-ability.
  }

  const summaryText = buildDeterministicSummary(middle);
  const ref = key ? ` (originals at ${makeArtifactUri(key)})` : '';
  const summaryMarker: ModelMessage = {
    role: 'user',
    content: `[Context collapsed — ${middle.length} messages summarized${ref}]\n${summaryText}`,
  };

  return {
    messages: [...head, summaryMarker, ...tail],
    collapsed: true,
    artifactKey: key,
  };
}

/**
 * Restore a collapsed middle span by resolving the artifact reference.
 * Used on session resume to reconstruct the full transcript when needed.
 */
export async function restoreCollapsedSpan(
  artifactKeyOrUri: string,
  store: ArtifactStore = globalArtifactStore,
): Promise<ModelMessage[] | null> {
  const key = artifactKeyOrUri.startsWith(ARTIFACT_URI_PREFIX)
    ? artifactKeyOrUri.slice(ARTIFACT_URI_PREFIX.length)
    : artifactKeyOrUri;
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelMessage[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 5 — AutoCompact (model-based summarization)
// ---------------------------------------------------------------------------

/** Reserve buffer — never fill the context window past this margin */
const compressionThreshold = (window: number) => contextBudget(window).compactAt;
/** Maximum summary length */

/** Circuit breaker: stop trying model summarization after this many failures */
const MAX_COMPRESSION_FAILURES = 3;

const compressionFailures = new WeakMap<object, number>();

/**
 * Tier 2: Model-based summarization of older conversation turns.
 * Keeps first message + last N messages, summarizes the middle.
 */
export async function autoCompactSummarize(
  messages: ModelMessage[],
  opts: {
    model: LanguageModel;
    contextWindow: number;
    keepRecent?: number;
    signal?: AbortSignal;
    historyBudget?: number;
  },
): Promise<{ messages: ModelMessage[]; compressed: boolean }> {
  const threshold = opts.historyBudget ? Math.floor(opts.historyBudget * .8) : compressionThreshold(opts.contextWindow);
  const currentTokens = estimateTokens(messages);

  if (currentTokens < threshold || messages.length < 6) {
    return { messages, compressed: false };
  }

  // Circuit breaker — fall through to deterministic if model keeps failing
  if ((compressionFailures.get(opts.model as object) ?? 0) >= MAX_COMPRESSION_FAILURES) {
    return deterministicCompress(messages, opts.keepRecent ?? 4);
  }

  const keepRecent = opts.keepRecent ?? 4;
  const keepStart = 1;

  const cut = safeTailStart(messages, keepRecent);
  const head = messages.slice(0, keepStart);
  const middle = messages.slice(keepStart, cut);
  const tail = messages.slice(cut);

  if (middle.length === 0) {
    return { messages, compressed: false };
  }

  const middleText = boundedSummaryInput(middle, opts.contextWindow);

  let summaryText: string;
  try {
    const result = await generateText({
      model: opts.model,
      instructions:
        'You are a conversation summarizer. Condense the following conversation ' +
        'history into a brief summary. Preserve: files modified, key decisions, ' +
        'errors encountered, and the current task state. Be concise but thorough. ' +
        'Output only the summary, no preamble.',
      messages: [{ role: 'user', content: middleText }],
      maxOutputTokens: Math.min(1024, contextBudget(opts.contextWindow).output),
      abortSignal: opts.signal,
      maxRetries: 0,
    });
    summaryText = result.text.trim();
    if (!summaryText) throw new Error("Empty compaction summary");
    compressionFailures.delete(opts.model as object);
  } catch {
    opts.signal?.throwIfAborted();
    compressionFailures.set(opts.model as object, (compressionFailures.get(opts.model as object) ?? 0) + 1);
    // Fall back to deterministic
    return deterministicCompress(messages, keepRecent);
  }

  return buildCompressedHistory(head, summaryText, tail);
}

// ---------------------------------------------------------------------------
// Tier 3 — FullCompact (retain task boundaries)
// ---------------------------------------------------------------------------

/**
 * Tier 3: Full conversation compression.
 * Used when AutoCompact can't free enough space.
 * Preserves the original request and the complete current user turn.
 */
export async function fullCompact(
  messages: ModelMessage[],
  model: LanguageModel,
  contextWindow = 131072,
  signal?: AbortSignal,
): Promise<{ messages: ModelMessage[]; compressed: boolean }> {
  if (messages.length < 4) {
    return { messages, compressed: false };
  }

  const cut = safeTailStart(messages, 2);
  if (!cut) return { messages, compressed: false };
  const head = messages.slice(0, 1);
  const allButLast2 = messages.slice(1, cut);
  const last2 = messages.slice(cut);

  const middleText = boundedSummaryInput(allButLast2, contextWindow);

  let summaryText: string;
  try {
    const result = await generateText({
      model,
      instructions:
        'Compress this entire conversation into a dense summary. Include: ' +
        'the original task, all files created/modified, key decisions, ' +
        'current state, and any unresolved issues. Max 500 words.',
      messages: [{ role: 'user', content: middleText }],
      maxOutputTokens: Math.min(2048, contextBudget(contextWindow).output),
      abortSignal: signal,
      maxRetries: 0,
    });
    summaryText = result.text;
  } catch {
    signal?.throwIfAborted();
    summaryText = buildDeterministicSummary(allButLast2);
  }

  return buildCompressedHistory(head, summaryText, last2);
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no model call)
// ---------------------------------------------------------------------------

function deterministicCompress(
  messages: ModelMessage[],
  keepRecent: number,
): { messages: ModelMessage[]; compressed: boolean } {
  const cut = safeTailStart(messages, keepRecent);
  const head = messages.slice(0, 1);
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);

  if (middle.length === 0) return { messages, compressed: false };

  const summaryText = buildDeterministicSummary(middle);
  return buildCompressedHistory(head, summaryText, tail);
}

function buildDeterministicSummary(messages: ModelMessage[]): string {
  const filesModified = new Set<string>();
  const toolsUsed = new Set<string>();
  const userRequests: string[] = [];
  let errorCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      userRequests.push(msg.content.slice(0, 1000));
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') userRequests.push(`Assistant state: ${msg.content.slice(0, 1000)}`);
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part) userRequests.push(`${msg.role}: ${part.text.slice(0, 1000)}`);
        if ('toolName' in part) {
          const p = part as unknown as Record<string, unknown>;
          toolsUsed.add(String(p.toolName));
          const args = p.input as Record<string, unknown> | undefined;
          if (args?.path) filesModified.add(String(args.path));
        }
        if ('output' in part) {
          const r = part as unknown as Record<string, unknown>;
          const res = toolResultValue(r) as Record<string, unknown> | undefined;
          if (res?.isError) errorCount++;
        }
      }
    }
  }

  const lines = ['Summary of previous conversation:'];
  if (userRequests.length > 0) lines.push(`- User requests: ${userRequests.join('; ')}`);
  if (toolsUsed.size > 0) lines.push(`- Tools used: ${[...toolsUsed].join(', ')}`);
  if (filesModified.size > 0) lines.push(`- Files touched: ${[...filesModified].join(', ')}`);
  if (errorCount > 0) lines.push(`- Errors encountered: ${errorCount}`);
  lines.push(`- Total messages summarized: ${messages.length}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function summarizeMessages(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === 'string') {
      lines.push(`${role}: ${msg.content.slice(0, 500)}`);
    } else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const part of msg.content) {
        if ('text' in part) parts.push(part.text.slice(0, 200));
        else if ('toolName' in part) parts.push(`[tool: ${(part as unknown as Record<string, unknown>).toolName}]`);
        else if ('output' in part) parts.push(`[result: ${JSON.stringify(toolResultValue(part)).slice(0, 100)}]`);
      }
      lines.push(`${role}: ${parts.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

/** Preserve the current user turn and its complete tool-call/result chain. */
export function safeTailStart(messages: ModelMessage[], keepRecent: number): number {
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut > 0 && messages[cut]?.role !== 'user') cut--;
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser]!.role !== 'user') lastUser--;
  return lastUser < 0 ? 0 : Math.min(cut, lastUser);
}
function boundedSummaryInput(messages: ModelMessage[], window: number): string {
  const text = summarizeMessages(messages), limit = Math.max(256, contextBudget(window).history - 512);
  const tokens = estimateTextTokens(text);
  if (tokens <= limit) return text;
  const half = Math.floor(text.length * limit / tokens * .45);
  return text.slice(0, half) + '\n[Older transcript abbreviated]\n' + text.slice(-half);
}

function buildCompressedHistory(
  head: ModelMessage[],
  summaryText: string,
  tail: ModelMessage[],
): { messages: ModelMessage[]; compressed: boolean } {
  const compressed: ModelMessage[] = [...head];
  const summaryContent = `[Previous conversation context]\n${summaryText}\n[End of context]`;

  if (tail.length > 0 && tail[0]!.role === 'user') {
    const firstContent = tail[0]!.content;
    compressed.push({ role: 'user', content: typeof firstContent === 'string' ? `${summaryContent}\n\n---\n\n${firstContent}` : [{ type: 'text', text: summaryContent }, ...firstContent] });
    compressed.push(...tail.slice(1));
  } else {
    compressed.push({ role: 'user', content: summaryContent });
    compressed.push({
      role: 'assistant',
      content: 'Understood. I have the context from our previous conversation. Continuing.',
    });
    compressed.push(...tail);
  }

  return { messages: compressed, compressed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AutoCompressStats {
  budgetStashed: number;
  snipped: number;
  collapsed: boolean;
  autoCompacted: boolean;
  fullCompacted: boolean;
}

/** Reduce history only when it approaches the available token allowance. */
export async function autoCompress(
  messages: ModelMessage[], model: LanguageModel, contextWindow: number,
  onCompress?: () => void, signal?: AbortSignal, historyBudget?: number,
): Promise<ModelMessage[]> {
  const result = await autoCompressWithStats(messages, model, contextWindow, signal, historyBudget);
  if (result.messages !== messages) onCompress?.();
  return result.messages;
}

/** Trim only under context pressure, then summarize once; use the full fallback only if still over budget. */
export async function autoCompressWithStats(
  messages: ModelMessage[], model: LanguageModel, contextWindow: number,
  signal?: AbortSignal, historyBudget = contextBudget(contextWindow).history,
): Promise<{ messages: ModelMessage[]; stats: AutoCompressStats }> {
  const stats: AutoCompressStats = { budgetStashed: 0, snipped: 0, collapsed: false, autoCompacted: false, fullCompacted: false };
  const threshold = Math.floor(historyBudget * .8);
  if (estimateTokens(messages) < threshold) return { messages, stats };
  const br = budgetReduce(messages);
  let result = microCompact(br.messages);
  stats.budgetStashed = br.stashed;
  if (estimateTokens(result) >= threshold) {
    const auto = await autoCompactSummarize(result, { model, contextWindow, signal, historyBudget });
    result = auto.messages; stats.autoCompacted = auto.compressed;
  }
  if (estimateTokens(result) > historyBudget) {
    const full = await fullCompact(result, model, contextWindow, signal);
    result = full.messages; stats.fullCompacted = full.compressed;
  }
  return { messages: result, stats };
}

/**
 * Compress conversation history (legacy API — delegates to autoCompress).
 */
export async function compressHistory(
  messages: ModelMessage[],
  opts: {
    model: LanguageModel;
    contextWindow: number;
    targetRatio?: number;
    keepRecent?: number;
  },
): Promise<{ messages: ModelMessage[]; compressed: boolean }> {
  const result = await autoCompactSummarize(messages, opts);
  return result;
}
