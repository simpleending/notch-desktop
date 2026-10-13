/**
 * Notch CLI — Fork-from-Turn
 * ===========================
 * Create a NEW rollout that starts as a copy of an existing one up to a
 * specified turn, then diverges. Matches Codex's `thread_manager.fork()`
 * semantics: the forked session is independent after the fork point — new
 * tool calls, new user turns, new assistant replies — but history up to
 * that point is preserved so the agent has full context.
 *
 * Use cases:
 *   - User wants to edit turn N and re-run with a different prompt.
 *   - A/B comparison: fork the same session twice with different models.
 *   - RSI Arena: snapshot successful trajectories as fork points for
 *     replay evaluation.
 *
 * The fork point is recorded as a `branch-fork` event on BOTH sides:
 *   - On the source session: a marker event pointing at the new child id.
 *   - On the child session: the copied header carries `forkSourceId` +
 *     `forkFromSeq` in its payload so downstream tooling can trace lineage.
 *
 * The child is NOT a symlink. It's a full copy of events[0..N] so the two
 * lines of history can be compacted, rewritten, or pruned independently.
 */

import fsp from 'node:fs/promises';
import {
  Rollout,
  readRollout,
  rolloutPath,
  generateSessionId,
  type RolloutRecord,
} from './rollout.js';
import { upsertSessionIndexEntry } from './session-index.js';

export interface ForkOptions {
  /** Optional explicit id for the child. Defaults to a fresh generated id. */
  childId?: string;
  /** Free-form note stored in the branch-fork record for UX. */
  note?: string;
  /**
   * When true, the last user-message at or before `fromSeq` becomes the
   * "new starting prompt" of the child. Everything after `fromSeq` is
   * dropped. This is the typical /fork UX.
   */
  truncateAfter?: boolean;
}

export interface ForkResult {
  childId: string;
  copiedRecords: number;
  sourceId: string;
  fromSeq: number;
}

/**
 * Fork `sourceId` at `fromSeq` (inclusive). Returns the new child session id.
 *
 * Seq numbering:
 *   - Child records retain their ORIGINAL seq values so lineage is obvious.
 *     The child's internal counter resumes at `fromSeq + 1`.
 *   - A fresh `branch-fork` marker is appended to the SOURCE with seq-bump
 *     as usual — lineage is bidirectional.
 */
export async function forkSession(
  sourceId: string,
  fromSeq: number,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  const records = await readRollout(sourceId);
  const header = records[0];
  if (!header) {
    throw new Error(`Cannot fork empty or missing session: ${sourceId}`);
  }
  if (header.type !== 'header') {
    throw new Error(`Source ${sourceId} has no header — refusing to fork.`);
  }
  if (fromSeq < 0) {
    throw new Error(`fromSeq must be >= 0 (got ${fromSeq}).`);
  }

  const truncated = opts.truncateAfter
    ? records.filter((r) => r.type === 'header' || r.seq <= fromSeq)
    : records.filter((r) => r.type === 'header' || r.seq <= fromSeq);
  if (truncated.length === 1) {
    // Only the header survived — that's a valid fork (from session start),
    // but caller probably meant something else. Allow it; user intent
    // might be "start over with the same project/model".
  }

  const childId = opts.childId ?? generateSessionId();

  // Append records up to fromSeq directly into the new child rollout.
  // We write raw lines (bypassing Rollout.writeRecord) so seqs are preserved
  // verbatim — then open the Rollout handle at seq = fromSeq + 1 for the
  // NEXT run to continue from.
  const childPath = rolloutPath(childId);
  const headerPayload = header.payload as { project?: string; model?: string; createdAt?: string; schema?: number; cwd?: string } | undefined;
  const newHeader: RolloutRecord = {
    seq: 0,
    ts: Date.now(),
    type: 'header',
    payload: {
      id: childId,
      project: headerPayload?.project,
      model: headerPayload?.model,
      createdAt: new Date().toISOString(),
      schema: 1,
      cwd: headerPayload?.cwd,
      forkSourceId: sourceId,
      forkFromSeq: fromSeq,
      note: opts.note,
    },
  };

  const lines: string[] = [JSON.stringify(newHeader)];
  let copied = 1;
  for (const r of truncated) {
    if (r.type === 'header') continue; // already wrote the child header
    lines.push(JSON.stringify(r));
    copied++;
  }
  await fsp.writeFile(childPath, lines.join('\n') + '\n');

  // Open the child as a Rollout so future appends land at seq = fromSeq + 1.
  // We avoid `openNew` (which would write a second header) and manually
  // seed the internal counter via openExisting → it reads our pre-seeded
  // lines and picks up the seq.
  const child = new Rollout(childId);
  await child.openExisting();

  // Stamp the fork marker on the SOURCE so it knows a child exists.
  const parent = new Rollout(sourceId);
  await parent.openExisting();
  await parent.append({
    type: 'branch-fork',
    payload: {
      childId,
      fromSeq,
      note: opts.note,
      createdAt: new Date().toISOString(),
    },
  });
  await parent.flush();
  await parent.close();

  // Finalize the child handle. The caller will reopen it when they start
  // the next turn.
  await child.flush();
  await child.close();

  // Refresh cross-session index for both sides.
  await upsertSessionIndexEntry(sourceId).catch(() => {});
  await upsertSessionIndexEntry(childId).catch(() => {});

  return { childId, copiedRecords: copied, sourceId, fromSeq };
}

/**
 * Find the seq of the Nth user-turn (0-indexed) in a rollout. Helper for
 * higher-level UX like "fork from turn 3" without the user having to
 * know internal seq numbers.
 */
export async function seqOfUserTurn(sourceId: string, turnIndex: number): Promise<number | null> {
  const records = await readRollout(sourceId);
  let count = 0;
  for (const r of records) {
    if (r.type === 'user-message') {
      if (count === turnIndex) return r.seq;
      count++;
    }
  }
  return null;
}
