/**
 * Notch CLI — Coordinator Runtime
 *
 * Orchestration helpers for coordinator mode. Responsible for:
 *   - Tracking in-flight worker agents spawned via agent_spawn.
 *   - Formatting <task-notification> XML envelopes for worker completions.
 *   - Racing in-flight worker promises so the top-level agent loop can wait
 *     for the next completion when the model ran out of things to say but
 *     workers are still producing results.
 *
 * This file is imported unconditionally by the agent loop via
 * pollPendingAgents(); it is a no-op when coordinator mode is off (no
 * entries are ever registered, so nothing is awaited).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { ModelMessage } from 'ai';
import type { SubagentResult } from '../agent/subagent.js';

export type AgentStatus = 'spawned' | 'running' | 'completed' | 'failed' | 'killed';

export interface AgentRegistryEntry {
  /** Caller-facing agent id (what workers get told in <task-id>). */
  agentId: string;
  /** The originating agent_spawn tool-use id, echoed in the notification. */
  toolUseId: string;
  /** Human-readable label from the spawn call. */
  description: string;
  /** Completion promise — resolves to a SubagentResult (success or captured failure). */
  completionPromise: Promise<SubagentResult>;
  /** Abort controller — agent_stop triggers this. */
  abortController: AbortController;
  /** Current status. Flipped by the spawn tool on resolve. */
  status: AgentStatus;
  /** Resolved result, once the promise settles. */
  result?: SubagentResult;
  /** Flag set once the completion has been injected into the loop. */
  delivered: boolean;
  /** Timestamp when the agent was spawned (ms). */
  startedAt: number;
}

/**
 * Module-scoped registry shared by the 3 coordinator tools and the loop hook.
 * Keyed by agentId.
 */
const registry = new Map<string, AgentRegistryEntry>();

export function registerAgent(entry: AgentRegistryEntry): void {
  registry.set(entry.agentId, entry);
}

export function getAgent(agentId: string): AgentRegistryEntry | undefined {
  return registry.get(agentId);
}

export function clearRegistry(): void {
  registry.clear();
}

/**
 * Count agents whose completion has not yet been delivered into the loop.
 * Includes both still-running agents and settled-but-undelivered agents.
 */
export function pendingCount(): number {
  let n = 0;
  for (const entry of registry.values()) {
    if (!entry.delivered) n++;
  }
  return n;
}

/**
 * List all registry entries (read-only snapshot, for diagnostics).
 */
export function listAgents(): ReadonlyArray<AgentRegistryEntry> {
  return Array.from(registry.values());
}

/**
 * Format a completion into the <task-notification> XML envelope the
 * coordinator system prompt documents. Keeps the result field truncated so
 * a runaway worker cannot blow up the coordinator's context budget.
 */
export function formatTaskNotification(
  agentId: string,
  toolUseId: string,
  status: AgentStatus,
  summary: string,
  result: string,
): string {
  const MAX_RESULT = 8 * 1024; // 8KB
  const truncated =
    result.length > MAX_RESULT
      ? result.slice(0, MAX_RESULT) + `\n\n[truncated ${result.length - MAX_RESULT} chars]`
      : result;

  // XML-escape the dynamic fields. Workers can legitimately produce <, >, &
  // in their final text (code snippets, shell examples, etc).
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  return (
    `<task-notification>\n` +
    `<task-id>${esc(agentId)}</task-id>\n` +
    `<tool-use-id>${esc(toolUseId)}</tool-use-id>\n` +
    `<status>${status}</status>\n` +
    `<summary>${esc(summary)}</summary>\n` +
    `<result>${esc(truncated)}</result>\n` +
    `</task-notification>`
  );
}

export interface DeliveredCompletion {
  agentId: string;
  toolUseId: string;
  status: AgentStatus;
  summary: string;
  result: string;
  xml: string;
}

/**
 * Wait for any undelivered agent completion to arrive and return it.
 * Returns null if there are no undelivered agents currently tracked.
 *
 * Agents that settled while the loop was busy are returned immediately on
 * the next call — they are not double-delivered because the delivered
 * flag is set on resolve.
 */
export async function awaitOneCompletion(): Promise<DeliveredCompletion | null> {
  const pending: AgentRegistryEntry[] = [];
  for (const entry of registry.values()) {
    if (!entry.delivered) pending.push(entry);
  }
  if (pending.length === 0) return null;

  // Some may have already settled (result populated) — prefer those so we
  // don't block the loop waiting on a still-running worker when a settled
  // one is ready to go.
  const alreadySettled = pending.find((e) => e.result !== undefined);
  const winner: AgentRegistryEntry = alreadySettled
    ? alreadySettled
    : await Promise.race(
        pending.map((entry) =>
          entry.completionPromise.then(() => entry).catch(() => entry),
        ),
      );

  // Mark delivered *before* returning so a concurrent loop iteration doesn't
  // hand the same completion back twice.
  winner.delivered = true;

  const result = winner.result;
  const status: AgentStatus = winner.status;
  const summary =
    status === 'completed'
      ? `Agent "${winner.description}" completed`
      : status === 'failed'
        ? `Agent "${winner.description}" failed: ${result?.error ?? 'unknown error'}`
        : status === 'killed'
          ? `Agent "${winner.description}" was stopped`
          : `Agent "${winner.description}" ended (${status})`;
  const text = result?.text ?? result?.error ?? '';

  const xml = formatTaskNotification(
    winner.agentId,
    winner.toolUseId,
    status,
    summary,
    text,
  );

  return {
    agentId: winner.agentId,
    toolUseId: winner.toolUseId,
    status,
    summary,
    result: text,
    xml,
  };
}

/**
 * Push the completion into the given message array as a user-role message
 * containing the XML envelope. The coordinator system prompt explains how
 * to interpret these — from the model's perspective they look like synthetic
 * user messages tagged with <task-notification>.
 */
export function injectCompletionAsUserMessage(
  messages: ModelMessage[],
  completion: DeliveredCompletion,
): void {
  messages.push({
    role: 'user',
    content: completion.xml,
  });
}

/**
 * Loop integration hook. Called by runAgentLoop AFTER the model returned
 * text with no tool calls, BEFORE the loop exits. Returns true if a
 * completion was injected and the caller should `continue` the loop
 * instead of returning.
 *
 * This is a no-op in non-coordinator mode because the registry stays empty
 * (no agent_spawn tool is ever loaded into the model's tool map).
 */
export async function pollPendingAgents(messages: ModelMessage[]): Promise<boolean> {
  if (pendingCount() === 0) return false;
  const completion = await awaitOneCompletion();
  if (!completion) return false;
  injectCompletionAsUserMessage(messages, completion);
  return true;
}
