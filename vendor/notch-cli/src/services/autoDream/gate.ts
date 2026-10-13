/**
 * Notch CLI — autoDream Gate
 *
 * Cheap-first feature gate for the background memory-consolidation daemon.
 *
 * Gate order (cheapest first — one stat, then readdir, then atomic exclusive
 * create):
 *
 *   1. Time gate    — hours since last dream must be >= minHours (default 24)
 *   2. Session gate — count of session files modified since last dream must
 *                     be >= minSessions (default 5)
 *   3. Lock gate    — atomic `wx` create of ~/.notch/.dream.lock; if the file
 *                     exists, another dream is already running — skip
 *
 * State lives in `~/.notch/dream-state.json`.
 *
 * Port of yasasbanukaofficial/claude-code's
 * `src/services/autoDream/autoDream.ts` gate logic, adapted to Notch's
 * `~/.notch/` layout and without feature-flag plumbing.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths and thresholds
// ---------------------------------------------------------------------------

const NOTCH_DIR = path.join(os.homedir(), '.notch');
const SESSION_DIR = path.join(NOTCH_DIR, 'sessions');
const STATE_FILE = path.join(NOTCH_DIR, 'dream-state.json');
const LOCK_FILE = path.join(NOTCH_DIR, '.dream.lock');

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 5;
const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamState {
  /** ms epoch of last successful dream run. */
  lastRunAt: number;
  /** Number of dreams recorded so far (for diagnostics). */
  runs?: number;
}

export interface GateResult {
  should: boolean;
  reason: string;
}

export interface GateOptions {
  minHours?: number;
  minSessions?: number;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function ensureNotchDir(): Promise<void> {
  await fs.mkdir(NOTCH_DIR, { recursive: true });
}

async function readState(): Promise<DreamState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as DreamState;
    if (typeof parsed?.lastRunAt !== 'number' || !Number.isFinite(parsed.lastRunAt)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(state: DreamState): Promise<void> {
  await ensureNotchDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether a dream should run NOW. Performs the three gates in
 * ascending order of cost. `cwd` is accepted for symmetry with the forked
 * agent signature but unused (dream state is global to the notch install,
 * not per-project — the memory store itself is global).
 */
export async function shouldDream(
  _cwd: string,
  opts: GateOptions = {},
): Promise<GateResult> {
  const minHours = opts.minHours ?? DEFAULT_MIN_HOURS;
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;

  // --- Time gate ---
  const state = await readState();
  const lastAt = state?.lastRunAt ?? 0;
  const hoursSince = (Date.now() - lastAt) / MS_PER_HOUR;
  if (state && hoursSince < minHours) {
    return {
      should: false,
      reason: `time-gate: only ${hoursSince.toFixed(1)}h since last dream (need ${minHours}h)`,
    };
  }

  // --- Session gate ---
  let sessionFiles: string[] = [];
  try {
    sessionFiles = await fs.readdir(SESSION_DIR);
  } catch {
    // No session dir yet — user hasn't done enough to need consolidation.
    return { should: false, reason: 'session-gate: no session directory yet' };
  }

  let touchedCount = 0;
  for (const name of sessionFiles) {
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.stat(path.join(SESSION_DIR, name));
      if (stat.mtimeMs > lastAt) touchedCount++;
    } catch {
      // Skip unreadable files.
    }
  }
  if (touchedCount < minSessions) {
    return {
      should: false,
      reason: `session-gate: ${touchedCount} new sessions since last dream (need ${minSessions})`,
    };
  }

  // --- Lock gate (atomic exclusive create) ---
  try {
    await ensureNotchDir();
    // `wx` = open for write, fail if exists. This IS the lock check + grab.
    const handle = await fs.open(LOCK_FILE, 'wx');
    try {
      await handle.writeFile(String(process.pid), 'utf-8');
    } finally {
      await handle.close();
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      return { should: false, reason: 'lock-gate: another dream is in progress' };
    }
    return {
      should: false,
      reason: `lock-gate: could not acquire lock (${(err as Error).message})`,
    };
  }

  return {
    should: true,
    reason: `eligible: ${hoursSince.toFixed(1)}h since last, ${touchedCount} sessions to review`,
  };
}

/**
 * Release the dream lock. MUST be called in a finally block after shouldDream
 * returns should=true. Safe to call if the lock doesn't exist.
 */
export async function releaseDreamLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE);
  } catch {
    // Best-effort; nothing to do if already gone.
  }
}

/**
 * Record that a dream completed successfully. Updates `lastRunAt` to now.
 * Called after the subagent finishes (success OR partial failure — we don't
 * want to retry a broken prompt every minute).
 */
export async function recordDreamRun(): Promise<void> {
  const prior = await readState();
  const next: DreamState = {
    lastRunAt: Date.now(),
    runs: (prior?.runs ?? 0) + 1,
  };
  try {
    await writeState(next);
  } catch {
    // Non-critical: next run's gate will just trigger again on the next
    // eligible tick. We don't want to surface this to the user.
  }
}

// Re-exports for tests.
export { LOCK_FILE as __LOCK_FILE, STATE_FILE as __STATE_FILE, SESSION_DIR as __SESSION_DIR };
