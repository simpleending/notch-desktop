/**
 * Notch CLI — Rollout Tail
 * =========================
 * Follow a rollout JSONL as it's written. Used by:
 *   - `notch --watch <id>` to spectate a running session.
 *   - RSI Arena replay UI to stream events into the browser.
 *   - Test harnesses that assert on intermediate events.
 *
 * Implementation is a simple polling loop — fs.watch on Windows is unreliable
 * for append-only writes and the rollout cadence is per-token (1-10ms) so
 * a short poll interval is indistinguishable from a real file-system event
 * on any platform.
 *
 * The tail terminates when either:
 *   - The rollout emits a `turn-end` + no `active-stream` marker is present
 *     AND `opts.stopOnIdle` is true, OR
 *   - `ctl.stop()` is called externally, OR
 *   - The rollout file disappears (session was deleted mid-tail).
 */

import fsp from 'node:fs/promises';
import { rolloutPath, type RolloutRecord } from './rollout.js';

export interface TailOptions {
  /** Start emitting from this seq (exclusive). 0 = from the beginning. */
  fromSeq?: number;
  /** Poll interval in ms. Defaults to 80ms which feels instant in a TUI. */
  pollIntervalMs?: number;
  /** When true, tail exits after the next `turn-end` or `error`. */
  stopOnIdle?: boolean;
  /** Hard timeout in ms; tail exits even if new events are still arriving. */
  timeoutMs?: number;
}

export interface TailController {
  /** Request the tail to stop. Resolves once the loop exits. */
  stop(): Promise<void>;
}

/**
 * Begin tailing `sessionId`. `onRecord` fires for every record at-or-after
 * `fromSeq`. Returns a controller for external cancellation.
 *
 * Does NOT throw if the file doesn't exist yet — this lets callers start
 * a tail before the session has been opened; records will start flowing
 * as soon as the rollout appears.
 */
export function tailRollout(
  sessionId: string,
  onRecord: (r: RolloutRecord) => void | Promise<void>,
  opts: TailOptions = {},
): TailController {
  const pollMs = opts.pollIntervalMs ?? 80;
  const startSeq = opts.fromSeq ?? -1;
  const timeoutAt = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;

  let stopped = false;
  let lastOffset = 0;
  let tail = '';
  let lastSeq = startSeq;
  let resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((r) => { resolveStop = r; });

  const tick = async (): Promise<void> => {
    if (stopped) { resolveStop?.(); return; }
    if (Date.now() >= timeoutAt) { stopped = true; resolveStop?.(); return; }

    try {
      const p = rolloutPath(sessionId);
      const fh = await fsp.open(p, 'r');
      try {
        const stat = await fh.stat();
        if (stat.size > lastOffset) {
          const buf = Buffer.alloc(stat.size - lastOffset);
          await fh.read(buf, 0, buf.length, lastOffset);
          lastOffset = stat.size;
          tail += buf.toString('utf-8');

          const lines = tail.split('\n');
          // Keep the (possibly-partial) trailing line buffered until the
          // next poll — otherwise we'd emit half-written records.
          tail = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let rec: RolloutRecord;
            try { rec = JSON.parse(line) as RolloutRecord; } catch { continue; }
            if (rec.seq <= lastSeq) continue;
            lastSeq = rec.seq;
            await onRecord(rec);

            if (opts.stopOnIdle && (rec.type === 'turn-end' || rec.type === 'error')) {
              stopped = true;
              break;
            }
          }
        }
      } finally {
        await fh.close();
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Rollout not yet created (or deleted). Keep polling unless we've
        // already seen records — in which case deletion means we stop.
        if (lastSeq >= 0) { stopped = true; resolveStop?.(); return; }
      } else {
        // Any other IO error is logged via onRecord as a synthetic error
        // event and we bail — avoids a tight loop hammering a broken fs.
        try {
          await onRecord({
            seq: lastSeq + 1,
            ts: Date.now(),
            type: 'error',
            payload: { where: 'tail', message: err?.message ?? String(err) },
          });
        } catch {
          // ignore — caller's onRecord threw
        }
        stopped = true;
        resolveStop?.();
        return;
      }
    }

    if (!stopped) {
      setTimeout(tick, pollMs);
    } else {
      resolveStop?.();
    }
  };

  // Kick off asynchronously so the caller gets the controller first.
  setTimeout(tick, 0);

  return {
    stop: async () => {
      stopped = true;
      await stopPromise;
    },
  };
}
