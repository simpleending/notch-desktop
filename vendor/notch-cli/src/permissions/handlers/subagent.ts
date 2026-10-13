/**
 * Notch CLI — Subagent Permission Handler
 *
 * Surface for tool calls inside a spawned subagent. Subagents inherit the
 * parent's permission config but there is no UI to ask — a base `prompt`
 * becomes `deny` automatically and a tail notification is queued so the
 * parent REPL can surface what the child was blocked on.
 *
 * Modeled after leaked Claude Code's `swarmWorkerHandler.ts`, minus the
 * mailbox-forward path since notch subagents run in-process.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

export const subagentHandler: PermissionHandler = {
  surface: 'subagent',
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

    // prompt → deny (subagent has no UI)
    const count = (ctx.denialCounter.get(toolName) ?? 0) + 1;
    ctx.denialCounter.set(toolName, count);

    const id = ctx.subagentId ?? 'unknown';
    return {
      outcome: 'deny',
      silent: true,
      reason: 'subagent has no interactive UI to prompt',
      tailNotification: `subagent ${id}: denied ${toolName} (no UI to prompt)`,
    };
  },
};
