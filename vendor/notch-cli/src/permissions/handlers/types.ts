/**
 * Notch CLI — Permission Handler Types
 *
 * Per-surface permission handlers. Each surface (interactive REPL, one-shot,
 * coordinator, subagent, auto-mode, json-mode) owns its own handler that
 * decides a PermissionDecision BEFORE the blocking UI dialog opens.
 *
 * Modeled after leaked Claude Code's src/hooks/toolPermission/handlers/*.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

/**
 * Surface identifies the execution context a tool call is happening in.
 * The surface determines which handler's `check()` runs before the UI
 * prompt (if any) is shown.
 */
export type Surface =
  | 'interactive'
  | 'one-shot'
  | 'coordinator'
  | 'subagent'
  | 'auto-mode'
  | 'json-mode';

/**
 * Outcome from a handler's check(). `prompt` means the UI dialog still
 * needs to run; `allow`/`deny` are terminal.
 */
export type PermissionOutcome = 'allow' | 'deny' | 'prompt';

export interface PermissionDecision {
  outcome: PermissionOutcome;
  /** Machine-readable reason code or human-readable explanation */
  reason?: string;
  /** If true, skip the prompt UI and treat as the outcome silently */
  silent?: boolean;
  /** Tail notification message for tray/log instead of blocking dialog */
  tailNotification?: string;
  /**
   * Async classifier still pending (Bash command parser etc). If set, the
   * dispatcher will await it and fold the result into the final decision.
   */
  pendingClassifierCheck?: () => Promise<PermissionDecision>;
}

export interface HandlerContext {
  cwd: string;
  sessionId: string;
  /**
   * Tracks denials per-session so repeated denials can suppress the prompt
   * or trigger a tail notification (e.g. "10+ unattended writes"). Keyed
   * by tool name; counts monotonically increase.
   */
  denialCounter: Map<string, number>;
  /** Logger used for tail notifications and handler diagnostics */
  log: (message: string) => void;
  /** --yes flag from CLI — used by oneShotHandler */
  autoConfirm?: boolean;
  /** Whether a guardian model is wired — affects autoMode hard-deny fallback */
  guardianEnabled?: boolean;
  /** Subagent id (only set when surface === 'subagent') */
  subagentId?: string;
}

export interface PermissionHandler {
  surface: Surface;
  /** Called BEFORE any UI prompt. Decides whether to prompt at all. */
  check: (
    toolName: string,
    args: Record<string, unknown>,
    baseDecision: PermissionOutcome,
    ctx: HandlerContext,
  ) => Promise<PermissionDecision>;
}
