/**
 * Notch CLI — Interactive Permission Handler
 *
 * Default surface for the REPL. Pass-through with one enhancement:
 * recently-approved (tool, args-fingerprint) pairs get a 30s free pass so
 * the same prompt doesn't re-appear for the same command twice in a row.
 *
 * Modeled after leaked Claude Code's `interactiveHandler.ts` where
 * automated checks race against user interaction.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { classifyBashCommand } from './bash-classifier.js';
import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

const SESSION_RECENT_MS = 30_000;

interface RecentApproval {
  key: string;
  expires: number;
}

/**
 * Session-scoped map of recently-approved (tool, args-fingerprint) entries.
 * Session-id + tool + canonical-fingerprint keyed. Pruned lazily on lookup.
 */
const recentApprovals = new Map<string, RecentApproval>();

function fingerprintArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.slice(0, 200)}`);
  }
  return parts.join('|');
}

function makeKey(sessionId: string, toolName: string, args: Record<string, unknown>): string {
  return `${sessionId}\u0000${toolName}\u0000${fingerprintArgs(args)}`;
}

/** Record that the user just approved this (tool, args) pair. */
export function recordInteractiveApproval(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const key = makeKey(sessionId, toolName, args);
  recentApprovals.set(key, { key, expires: Date.now() + SESSION_RECENT_MS });
}

/** Forget everything — used by tests and session teardown. */
export function clearInteractiveApprovals(): void {
  recentApprovals.clear();
}

function wasRecentlyApproved(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const key = makeKey(sessionId, toolName, args);
  const hit = recentApprovals.get(key);
  if (!hit) return false;
  if (hit.expires < Date.now()) {
    recentApprovals.delete(key);
    return false;
  }
  return true;
}

export const interactiveHandler: PermissionHandler = {
  surface: 'interactive',
  check: async (
    toolName: string,
    args: Record<string, unknown>,
    baseDecision,
    ctx: HandlerContext,
  ): Promise<PermissionDecision> => {
    // `allow`/`deny` are terminal for the interactive surface — the REPL
    // already matches today's CLI behaviour for those.
    if (baseDecision === 'allow') {
      // Bash-specific: upgrade `allow` to `prompt` when the command text is
      // destructive (sneaks past an overly-broad shell allow rule).
      if (toolName === 'shell' && typeof args.command === 'string') {
        const pending = async (): Promise<PermissionDecision> => {
          const cls = classifyBashCommand(args.command as string);
          if (cls.category === 'destructive') {
            return {
              outcome: 'prompt',
              reason: `classifier flagged destructive command: ${cls.matchedPattern}`,
            };
          }
          return { outcome: 'allow' };
        };
        return { outcome: 'allow', pendingClassifierCheck: pending };
      }
      return { outcome: 'allow' };
    }
    if (baseDecision === 'deny') {
      return { outcome: 'deny', reason: 'denied by permission config' };
    }

    // baseDecision === 'prompt'
    if (wasRecentlyApproved(ctx.sessionId, toolName, args)) {
      return {
        outcome: 'allow',
        silent: true,
        reason: 'session-recent approval (within 30s)',
      };
    }
    return { outcome: 'prompt' };
  },
};
