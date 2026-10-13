/**
 * Notch CLI — Coordinator Permission Handler
 *
 * Surface for coordinator-mode's top-level loop. Coordinators may only use
 * the three orchestration tools plus read-only recon — anything that reaches
 * base `prompt` is something that slipped past the tool filter and must be
 * hard-denied with a reason that nudges the coordinator to delegate.
 *
 * Modeled after leaked Claude Code's `coordinatorHandler.ts`.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { HandlerContext, PermissionDecision, PermissionHandler } from './types.js';

const COORDINATOR_ALLOWED = new Set<string>([
  'agent_spawn',
  'agent_send_message',
  'agent_stop',
  'read',
  'grep',
  'glob',
]);

export const coordinatorHandler: PermissionHandler = {
  surface: 'coordinator',
  check: async (
    toolName: string,
    _args: Record<string, unknown>,
    baseDecision,
    _ctx: HandlerContext,
  ): Promise<PermissionDecision> => {
    if (COORDINATOR_ALLOWED.has(toolName)) {
      // Base decision is trusted for the whitelist — `allow` passes through,
      // `prompt` (rare — config override) is still allowed silently.
      if (baseDecision === 'deny') {
        return { outcome: 'deny', reason: 'coordinator tool explicitly denied by config' };
      }
      return { outcome: 'allow', silent: true };
    }

    // Non-coordinator tool — the filter in buildToolMap should have stripped
    // this, but if something slipped through, hard-deny.
    if (baseDecision === 'deny') {
      return { outcome: 'deny', reason: 'denied by permission config' };
    }
    return {
      outcome: 'deny',
      silent: true,
      reason: 'Coordinator must delegate write operations to a worker.',
      tailNotification: `coordinator: blocked ${toolName} (delegate to worker)`,
    };
  },
};
