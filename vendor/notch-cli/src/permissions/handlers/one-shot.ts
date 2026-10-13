/**
 * Notch CLI — One-Shot Permission Handler
 *
 * Surface for `notch "do X"` invocations. No human at the keyboard — a
 * base `prompt` decision is downgraded to `deny` unless `--yes` / `-y` is
 * set (handler reads `ctx.autoConfirm`).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

export const oneShotHandler: PermissionHandler = {
  surface: 'one-shot',
  check: async (
    toolName: string,
    _args: Record<string, unknown>,
    baseDecision,
    ctx: HandlerContext,
  ): Promise<PermissionDecision> => {
    if (baseDecision === 'allow') return { outcome: 'allow' };
    if (baseDecision === 'deny') {
      return { outcome: 'deny', reason: 'denied by permission config' };
    }

    // baseDecision === 'prompt'
    if (ctx.autoConfirm) {
      return {
        outcome: 'allow',
        silent: true,
        reason: '--yes flag set; auto-confirming one-shot',
      };
    }

    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);
    return {
      outcome: 'deny',
      silent: true,
      reason: 'one-shot mode denies prompt-level tools without --yes',
      tailNotification: `one-shot: denied ${toolName} (pass --yes to auto-approve)`,
    };
  },
};
