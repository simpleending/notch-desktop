/**
 * Notch CLI — Permission Dispatcher
 *
 * Routes tool-permission checks to the active surface's handler, awaits any
 * pending async classifier check, records tail notifications for deferred
 * display, and exposes the queue drain API used by the REPL to surface
 * auto-mode denials between turns.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type {
  HandlerContext,
  PermissionDecision,
  PermissionHandler,
  PermissionOutcome,
  Surface,
} from './handlers/types.js';
import { interactiveHandler } from './handlers/interactive.js';
import { oneShotHandler } from './handlers/one-shot.js';
import { coordinatorHandler } from './handlers/coordinator.js';
import { subagentHandler } from './handlers/subagent.js';
import { autoModeHandler } from './handlers/auto-mode.js';
import { jsonModeHandler } from './handlers/json-mode.js';

const HANDLERS: Record<Surface, PermissionHandler> = {
  interactive: interactiveHandler,
  'one-shot': oneShotHandler,
  coordinator: coordinatorHandler,
  subagent: subagentHandler,
  'auto-mode': autoModeHandler,
  'json-mode': jsonModeHandler,
};

/** Singleton lookup. */
export function getActiveHandler(surface: Surface): PermissionHandler {
  return HANDLERS[surface];
}

/**
 * Run the full permission check pipeline: base → handler.check →
 * pendingClassifierCheck (if any) → final decision. Returns a plain
 * PermissionDecision (no lingering pending promises).
 */
export async function runPermissionCheck(
  toolName: string,
  args: Record<string, unknown>,
  baseDecision: PermissionOutcome,
  surface: Surface,
  ctx: HandlerContext,
): Promise<PermissionDecision> {
  const handler = getActiveHandler(surface);
  const initial = await handler.check(toolName, args, baseDecision, ctx);

  // Tail-notification collection happens here too so a handler that returns
  // allow+notification still surfaces the notification.
  if (initial.tailNotification) {
    pushTailNotification(initial.tailNotification);
  }

  if (!initial.pendingClassifierCheck) return initial;

  try {
    const refined = await initial.pendingClassifierCheck();
    if (refined.tailNotification) pushTailNotification(refined.tailNotification);
    // Classifier wins over the initial outcome when it's stricter.
    return {
      outcome: refined.outcome,
      reason: refined.reason ?? initial.reason,
      silent: refined.silent ?? initial.silent,
      tailNotification: refined.tailNotification ?? initial.tailNotification,
    };
  } catch {
    // Classifier failure must never block — fall through to the initial
    // decision minus the pending marker.
    return {
      outcome: initial.outcome,
      reason: initial.reason,
      silent: initial.silent,
      tailNotification: initial.tailNotification,
    };
  }
}

// ---------------------------------------------------------------------------
// Tail notification queue
// ---------------------------------------------------------------------------

const tailQueue: string[] = [];

/** Append a notification to the tail queue (internal + external use). */
export function pushTailNotification(message: string): void {
  tailQueue.push(message);
}

/**
 * Record an auto-mode denial so a tail notification can surface it after
 * the current turn completes. Safe to call with any decision — non-deny
 * decisions are ignored.
 */
export function recordAutoModeDenial(decision: PermissionDecision): void {
  if (decision.outcome !== 'deny') return;
  const msg = decision.tailNotification ?? decision.reason ?? 'auto-mode: tool denied';
  pushTailNotification(msg);
}

/** Pop + return all queued tail notifications. */
export function drainTailNotifications(): string[] {
  const out = tailQueue.splice(0, tailQueue.length);
  return out;
}

// ---------------------------------------------------------------------------
// Surface selection (global, mutated once at startup from src/index.ts)
// ---------------------------------------------------------------------------

let currentSurface: Surface = 'interactive';

export function setCurrentSurface(surface: Surface): void {
  currentSurface = surface;
}

export function getCurrentSurface(): Surface {
  return currentSurface;
}

// ---------------------------------------------------------------------------
// HandlerContext factory — one per session, threaded through ToolContext.
// ---------------------------------------------------------------------------

export function createHandlerContext(options: {
  cwd: string;
  sessionId: string;
  log: (message: string) => void;
  autoConfirm?: boolean;
  guardianEnabled?: boolean;
  subagentId?: string;
}): HandlerContext {
  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    denialCounter: new Map<string, number>(),
    log: options.log,
    autoConfirm: options.autoConfirm,
    guardianEnabled: options.guardianEnabled,
    subagentId: options.subagentId,
  };
}

export type { PermissionDecision, PermissionHandler, HandlerContext, Surface, PermissionOutcome };
