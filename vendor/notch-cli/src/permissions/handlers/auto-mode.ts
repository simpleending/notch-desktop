/**
 * Notch CLI — Auto-Mode Permission Handler
 *
 * Surface for `--trust` / auto mode. Base `prompt` becomes `allow` UNLESS
 * the command hits the hard-deny list (force-push to main, npm publish,
 * anything classifier-flagged destructive). Each implicit-allow is counted
 * so a tail notification can warn if 10+ writes happen unattended.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { classifyBashCommand } from './bash-classifier.js';
import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

const AUTO_IMPLICIT_WRITE_KEY = '__auto_mode_implicit_writes__';
const AUTO_WRITE_NOTIFY_THRESHOLD = 10;

/** Tools that count as a "write" for the unattended-writes tally. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'shell', 'git']);

/**
 * Hard-deny patterns that a non-shell tool might produce. Each returns a
 * reason string when matched. Shell commands get their own classifier path.
 */
function hardDenyReason(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'git') {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const flags = typeof args.flags === 'string' ? args.flags : '';
    const argsStr = typeof args.args === 'string' ? args.args : '';
    const combined = `${op} ${flags} ${argsStr}`.toLowerCase();
    if (combined.includes('push') && /(-f\b|--force\b|--force-with-lease\b)/.test(combined)) {
      return 'force-push is never auto-approved';
    }
    if (combined.includes('reset') && combined.includes('--hard')) {
      return 'git reset --hard is never auto-approved';
    }
  }
  if (toolName === 'shell' && typeof args.command === 'string') {
    const cmd = args.command as string;
    if (/\bnpm\s+publish\b/i.test(cmd) || /\byarn\s+publish\b/i.test(cmd) || /\bpnpm\s+publish\b/i.test(cmd)) {
      return 'package publish is never auto-approved';
    }
    if (/\bgit\s+push\b.*\b(?:-f|--force|--force-with-lease)\b/i.test(cmd)) {
      return 'force-push is never auto-approved';
    }
    if (/\b(?:rm\s+-rf?|dd\s+if=|mkfs\.|shred)\b/i.test(cmd)) {
      return 'classifier-flagged destructive shell command';
    }
  }
  return null;
}

export const autoModeHandler: PermissionHandler = {
  surface: 'auto-mode',
  check: async (
    toolName: string,
    args: Record<string, unknown>,
    baseDecision,
    ctx: HandlerContext,
  ): Promise<PermissionDecision> => {
    if (baseDecision === 'deny') {
      return { outcome: 'deny', reason: 'denied by permission config' };
    }

    // Hard-deny list takes priority over trust mode
    const reason = hardDenyReason(toolName, args);
    if (reason) {
      return {
        outcome: 'deny',
        silent: false,
        reason,
        tailNotification: `auto-mode: refused ${toolName} — ${reason}`,
      };
    }

    // Shell classifier hook — upgrade `allow` to `prompt` for destructive,
    // and deny outright if we're already hearing from an explicit prompt.
    if (toolName === 'shell' && typeof args.command === 'string') {
      const pending = async (): Promise<PermissionDecision> => {
        const cls = classifyBashCommand(args.command as string);
        if (cls.category === 'destructive') {
          return {
            outcome: 'deny',
            silent: false,
            reason: `classifier flagged destructive command: ${cls.matchedPattern}`,
            tailNotification: `auto-mode: refused destructive shell command (${cls.head ?? 'shell'})`,
          };
        }
        return baseDecision === 'allow'
          ? { outcome: 'allow', silent: true }
          : { outcome: 'allow', silent: true, reason: 'auto-mode implicit approval' };
      };
      if (baseDecision === 'allow') return { outcome: 'allow', pendingClassifierCheck: pending };
      // prompt → defer to classifier (allow unless destructive)
      return { outcome: 'allow', silent: true, pendingClassifierCheck: pending };
    }

    if (baseDecision === 'allow') return { outcome: 'allow' };

    // baseDecision === 'prompt' — trust mode implicit allow
    if (WRITE_TOOLS.has(toolName)) {
      const writes = (ctx.denialCounter.get(AUTO_IMPLICIT_WRITE_KEY) ?? 0) + 1;
      ctx.denialCounter.set(AUTO_IMPLICIT_WRITE_KEY, writes);
      if (writes === AUTO_WRITE_NOTIFY_THRESHOLD) {
        return {
          outcome: 'allow',
          silent: true,
          reason: 'auto-mode implicit approval',
          tailNotification: `auto-mode: ${writes} unattended writes this session — consider reviewing`,
        };
      }
      if (writes > AUTO_WRITE_NOTIFY_THRESHOLD && writes % 10 === 0) {
        return {
          outcome: 'allow',
          silent: true,
          reason: 'auto-mode implicit approval',
          tailNotification: `auto-mode: ${writes} unattended writes this session`,
        };
      }
    }

    return { outcome: 'allow', silent: true, reason: 'auto-mode implicit approval' };
  },
};
