/**
 * Notch CLI — Git-state event source
 *
 * Lightweight poll that emits events when the repo state changes:
 *   - new commits on the current branch
 *   - branch switches
 *   - unpushed commits
 *   - dirty working tree transitions (clean -> dirty -> clean)
 *
 * Runs out-of-band of the agent loop so the agent isn't spammed with
 * filesystem churn. Events feed the router, which dedupes and filters.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventRouter } from '../router.js';

const exec = promisify(execFile);

interface GitState {
  branch: string;
  head: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

async function readGitState(cwd: string): Promise<GitState | null> {
  try {
    const { stdout: branchOut } = await exec('git', ['branch', '--show-current'], { cwd });
    const branch = branchOut.trim();
    if (!branch) return null;

    const { stdout: headOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headOut.trim();

    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd });
    const dirty = statusOut.trim().length > 0;

    // ahead/behind vs upstream (best-effort — no upstream -> 0/0)
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: abOut } = await exec(
        'git',
        ['rev-list', '--left-right', '--count', `HEAD...@{u}`],
        { cwd },
      );
      const [a, b] = abOut.trim().split(/\s+/);
      ahead = parseInt(a ?? '0', 10) || 0;
      behind = parseInt(b ?? '0', 10) || 0;
    } catch {
      // No upstream configured — ahead/behind stay 0.
    }

    return { branch, head, dirty, ahead, behind };
  } catch {
    return null;
  }
}

export interface GitWatchOptions {
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Poll interval in ms. Default 10_000 (10s). */
  intervalMs?: number;
  /** Router to emit into. */
  router: EventRouter;
}

export interface GitWatchHandle {
  /** Stop polling. Safe to call more than once. */
  stop(): void;
  /** Force a poll tick now. Returns the new state or null. */
  tick(): Promise<GitState | null>;
}

/**
 * Start polling git state. Emits events on transitions.
 *
 * Intentionally does NOT fire an event on first-observation of state —
 * we only care about CHANGES, not the opening snapshot.
 */
export function watchGitState(opts: GitWatchOptions): GitWatchHandle {
  const cwd = opts.cwd ?? process.cwd();
  const intervalMs = Math.max(1000, opts.intervalMs ?? 10_000);
  const router = opts.router;

  let prev: GitState | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<GitState | null> => {
    if (stopped) return null;
    const next = await readGitState(cwd);
    if (!next) return null;

    if (prev) {
      // Branch switch
      if (prev.branch !== next.branch) {
        router.emit({
          source: 'git',
          type: 'branch-switch',
          severity: 'info',
          title: `branch: ${prev.branch} \u2192 ${next.branch}`,
          payload: { from: prev.branch, to: next.branch },
        });
      }
      // New commit on same branch
      if (prev.branch === next.branch && prev.head !== next.head) {
        router.emit({
          source: 'git',
          type: 'new-commit',
          severity: 'info',
          title: `new commit on ${next.branch}`,
          payload: { from: prev.head, to: next.head, branch: next.branch },
        });
      }
      // Clean → dirty transition
      if (!prev.dirty && next.dirty) {
        router.emit({
          source: 'git',
          type: 'dirty-tree',
          severity: 'info',
          title: 'working tree now dirty',
          payload: { branch: next.branch },
        });
      }
      // Dirty → clean transition
      if (prev.dirty && !next.dirty) {
        router.emit({
          source: 'git',
          type: 'clean-tree',
          severity: 'info',
          title: 'working tree now clean',
          payload: { branch: next.branch },
        });
      }
      // Newly behind upstream (someone pushed)
      if (prev.behind < next.behind && next.behind > 0) {
        router.emit({
          source: 'git',
          type: 'behind-upstream',
          severity: 'warn',
          title: `${next.behind} new commit(s) on upstream ${next.branch}`,
          payload: { branch: next.branch, behind: next.behind },
        });
      }
    }

    prev = next;
    return next;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch {
        // Swallow — transient git failures shouldn't crash the watcher.
      }
      if (stopped) return;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
      });
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tick,
  };
}
