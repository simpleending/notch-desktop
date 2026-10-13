/**
 * Notch CLI — JSON-Mode Permission Handler
 *
 * Surface for `--json` headless mode. No interactive dialog is possible,
 * so base `prompt` becomes `deny` silently with a tail notification that
 * carries a machine-readable reason. The JsonEmitter in index.ts translates
 * tail notifications into `permission_denied` events on the event stream.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

export const jsonModeHandler: PermissionHandler = {
  surface: 'json-mode',
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

    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);

    const payload = JSON.stringify({
      type: 'permission_denied',
      tool: toolName,
      reason: 'json mode requires explicit allowlist',
    });

    return {
      outcome: 'deny',
      silent: true,
      reason: 'json mode requires explicit allowlist',
      tailNotification: payload,
    };
  },
};
