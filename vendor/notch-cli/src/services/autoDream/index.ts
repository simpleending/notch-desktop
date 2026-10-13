/**
 * Notch CLI — autoDream Daemon
 *
 * Background memory consolidation. Fires the `/dream` prompt as a forked
 * `general` subagent after the CLI has been idle for a configurable period
 * (default 60s). Idle-triggered, never blocks REPL responsiveness.
 *
 * Wiring:
 *   - `startAutoDreamDaemon(opts)` schedules a single one-shot run, resettable
 *     via `resetAutoDreamIdle()` whenever the user types.
 *   - `stopAutoDreamDaemon()` clears the timer (called on exit).
 *   - `runAutoDream(opts)` may also be invoked manually (e.g. via a
 *     `/dream` slash command).
 *
 * Gate + lock are delegated to `./gate.ts`. The 4-phase prompt is in
 * `./consolidationPrompt.ts`.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { LanguageModel } from 'ai';
import type { ToolContext } from '../../tools/types.js';
import { spawnSubagent, nextSubagentId } from '../../agent/subagent.js';
import { shouldDream, releaseDreamLock, recordDreamRun, type GateOptions } from './gate.js';
import { DREAM_PROMPT } from './consolidationPrompt.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IDLE_MS = 60_000; // 60s idle before we consider firing.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoDreamOptions {
  cwd: string;
  model: LanguageModel;
  /** Logger — messages are printed quietly (gray). */
  log: (msg: string) => void;
  /** Optional gate thresholds (tests). */
  gate?: GateOptions;
  /**
   * ToolContext used for the subagent's tools. Reuse the main REPL's
   * toolCtx. We intentionally do NOT scope the tools to the memory dir here
   * — the 4-phase prompt tells the subagent to stay in \`~/.notch/memory/\`
   * + \`~/.notch/sessions/\`, and a general subagent has the full tool
   * surface it needs (read/grep/glob/edit/write/shell).
   */
  toolContext: ToolContext;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single dream cycle. Idempotent — the gate short-circuits if too
 * soon / too few sessions / lock already held. All errors are swallowed so a
 * background dream can never crash the user's foreground session.
 */
export async function runAutoDream(opts: AutoDreamOptions): Promise<void> {
  let acquired = false;
  try {
    const gate = await shouldDream(opts.cwd, opts.gate);
    if (!gate.should) {
      // Quiet — don't spam the user with gate misses. Dev log only.
      return;
    }
    acquired = true;
    opts.log('\u{1F319} autoDream starting (consolidation)...');

    const id = nextSubagentId('general');
    const result = await spawnSubagent({
      id,
      type: 'general',
      prompt: DREAM_PROMPT,
      model: opts.model,
      toolContext: {
        ...opts.toolContext,
        // Auto-confirm: background subagent must not block on prompts.
        requireConfirm: false,
        confirm: async () => true,
        // Silence per-tool chatter; only surface high-level status.
        log: () => {},
      },
      // Dreams are small — 10 iterations is plenty for orient+gather+edit.
      maxIterations: 12,
      onStatus: () => {}, // Silent
    });

    if (result.error) {
      opts.log(`autoDream finished with error: ${result.error}`);
    } else {
      opts.log(`autoDream done (${result.toolCalls} tool calls, ${result.iterations} iterations)`);
    }

    await recordDreamRun();
  } catch (err: unknown) {
    // Fire-and-forget — never propagate.
    opts.log(`autoDream failed: ${(err as Error).message}`);
  } finally {
    if (acquired) {
      await releaseDreamLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon — one-shot scheduler, resettable on user input
// ---------------------------------------------------------------------------

let idleTimer: NodeJS.Timeout | null = null;
let pendingOpts: AutoDreamOptions | null = null;
let fired = false;

/**
 * Schedule `runAutoDream` to fire after `IDLE_MS` of idle time. Call
 * `resetAutoDreamIdle()` on every user keystroke (REPL side) to reset the
 * countdown. Fires at most once per CLI session — once the dream runs, the
 * daemon is done for the session.
 */
export function startAutoDreamDaemon(opts: AutoDreamOptions): void {
  // Respect the env-var / flag opt-out at schedule time.
  if (isDisabled()) return;

  pendingOpts = opts;
  resetAutoDreamIdle();
}

/**
 * Reset the idle countdown. Called by the REPL on every line-in event.
 * Cheap — a single setTimeout replacement.
 */
export function resetAutoDreamIdle(): void {
  if (!pendingOpts || fired || isDisabled()) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!pendingOpts || fired) return;
    fired = true;
    // Deliberately unawaited — this MUST NOT block the REPL.
    void runAutoDream(pendingOpts);
  }, IDLE_MS);
  // Unref so Node can exit naturally if REPL closes first.
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/**
 * Cancel any scheduled dream. Called on CLI exit.
 */
export function stopAutoDreamDaemon(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  pendingOpts = null;
}

function isDisabled(): boolean {
  if (process.env.NOTCH_AUTO_DREAM === '0') return true;
  if (process.env.NOTCH_AUTO_DREAM === 'false') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset daemon state between tests. */
export function __resetAutoDreamDaemon(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  pendingOpts = null;
  fired = false;
}

// Re-exports for convenience
export { DREAM_PROMPT } from './consolidationPrompt.js';
export { shouldDream, releaseDreamLock, recordDreamRun } from './gate.js';
