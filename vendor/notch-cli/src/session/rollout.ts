import { toolOutput } from '../messages.js';
/**
 * Notch CLI — Rollout log.
 *
 * Append-only JSONL file per session. Every turn's events — user prompt,
 * text deltas, tool calls, tool results, assistant messages, usage, errors,
 * fork markers — are flushed to disk synchronously as they happen.
 *
 * Benefits vs. the previous "dump JSON at end of session" model:
 *   - Ctrl+C mid-stream preserves every token received so far.
 *   - `notch --resume` can replay or tail an in-flight session.
 *   - Branching is append-only: fork events carry the parent message id,
 *     so /fork never mutates history.
 *
 * File format:
 *   line 1: header record { type: 'header', ... }
 *   line N: event records, each { seq, type, ts, parent?, ...payload }
 *
 * One sqlite-shaped index is kept in a sibling .idx.json file (rebuilt
 * on read if missing). No native deps — pure fs + JSON.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROLLOUT_DIR = path.join(os.homedir(), '.notch', 'rollouts');

export type RolloutType =
  | 'header'
  | 'turn-start'
  | 'user-message'
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'assistant-message'
  | 'usage'
  | 'error'
  | 'turn-end'
  | 'branch-fork'
  | 'active-stream' // marker that a stream is in progress (cleared on end)
  | 'compact';      // compaction checkpoint

export interface RolloutRecord {
  seq: number;
  type: RolloutType;
  ts: number;
  /** Message id this record belongs to (for parentId/branch graph) */
  msgId?: string;
  /** Parent msgId — fork points create a sibling with the same parent */
  parent?: string;
  /** Stream id for resumable streams */
  streamId?: string;
  payload?: unknown;
}

export interface RolloutHeader extends RolloutRecord {
  type: 'header';
  payload: {
    id: string;
    project: string;
    model: string;
    createdAt: string;
    schema: 1;
  };
}

export interface RolloutIndex {
  lastSeq: number;
  messageCount: number;
  branches: Record<string, string[]>; // parentId → [childMsgId, …]
  activeStream: string | null;
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(ROLLOUT_DIR, { recursive: true });
}

export function rolloutPath(id: string): string {
  return path.join(ROLLOUT_DIR, `${id}.jsonl`);
}
export function indexPath(id: string): string {
  return path.join(ROLLOUT_DIR, `${id}.idx.json`);
}

export function generateSessionId(): string {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
                d.toISOString().slice(11, 16).replace(':', '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${rand}`;
}

/**
 * Rollout writer — append events line-by-line with fsync for crash safety
 * on important records. Uses a persistent fd so we don't pay open+close
 * per line.
 */
export class Rollout {
  private fd: fs.promises.FileHandle | null = null;
  private seq = 0;
  private idx: RolloutIndex = {
    lastSeq: -1, messageCount: 0, branches: {}, activeStream: null,
  };

  constructor(public readonly id: string) {}

  async openNew(header: { project: string; model: string }): Promise<void> {
    await ensureDir();
    this.fd = await fsp.open(rolloutPath(this.id), 'a');
    await this.writeRecord({
      type: 'header',
      payload: { id: this.id, project: header.project, model: header.model, createdAt: new Date().toISOString(), schema: 1 },
    });
  }

  async openExisting(): Promise<void> {
    await ensureDir();
    // Load or rebuild index
    this.idx = await readIndex(this.id);
    this.seq = this.idx.lastSeq + 1;
    this.fd = await fsp.open(rolloutPath(this.id), 'a');
  }

  async close(): Promise<void> {
    await this.saveIndex();
    if (this.fd) { await this.fd.close(); this.fd = null; }
    // Refresh the cross-session index so `listSessions()` sees the final
    // turn count / preview / interrupted-stream flag. Dynamic import keeps
    // this module import-graph-clean (session-index imports readRollout
    // from here, so a top-level import would be circular).
    try {
      const { upsertSessionIndexEntry } = await import('./session-index.js');
      await upsertSessionIndexEntry(this.id);
    } catch {
      // Best-effort — index failures never block session save.
    }
  }

  private async writeRecord(partial: Omit<RolloutRecord, 'seq' | 'ts'>): Promise<RolloutRecord> {
    if (!this.fd) throw new Error('rollout not open');
    const rec: RolloutRecord = { seq: this.seq++, ts: Date.now(), ...partial };
    const line = JSON.stringify(rec) + '\n';
    await this.fd.write(line);
    this.idx.lastSeq = rec.seq;
    if (rec.type === 'user-message' || rec.type === 'assistant-message') {
      this.idx.messageCount++;
      if (rec.parent && rec.msgId) {
        (this.idx.branches[rec.parent] ??= []).push(rec.msgId);
      }
    }
    if (rec.type === 'active-stream') {
      this.idx.activeStream = rec.streamId ?? null;
    } else if (rec.type === 'turn-end' || rec.type === 'error') {
      this.idx.activeStream = null;
    }
    return rec;
  }

  append(record: Omit<RolloutRecord, 'seq' | 'ts'>): Promise<RolloutRecord> {
    return this.writeRecord(record);
  }

  async flush(): Promise<void> {
    if (this.fd) await this.fd.sync();
    await this.saveIndex();
  }

  private async saveIndex(): Promise<void> {
    await fsp.writeFile(indexPath(this.id), JSON.stringify(this.idx, null, 2));
  }

  get activeStream(): string | null { return this.idx.activeStream; }
  get index(): RolloutIndex { return this.idx; }
}

/** Load all records from a rollout (synchronous-ish — whole file into memory). */
export async function readRollout(id: string): Promise<RolloutRecord[]> {
  const raw = await fsp.readFile(rolloutPath(id), 'utf-8');
  const out: RolloutRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RolloutRecord); } catch { /* skip corrupt */ }
  }
  return out;
}

/** Read or rebuild the index. */
export async function readIndex(id: string): Promise<RolloutIndex> {
  try {
    const raw = await fsp.readFile(indexPath(id), 'utf-8');
    return JSON.parse(raw) as RolloutIndex;
  } catch {
    const records = await readRollout(id);
    const idx: RolloutIndex = { lastSeq: -1, messageCount: 0, branches: {}, activeStream: null };
    for (const r of records) {
      idx.lastSeq = r.seq;
      if (r.type === 'user-message' || r.type === 'assistant-message') {
        idx.messageCount++;
        if (r.parent && r.msgId) (idx.branches[r.parent] ??= []).push(r.msgId);
      }
      if (r.type === 'active-stream') idx.activeStream = r.streamId ?? null;
      else if (r.type === 'turn-end' || r.type === 'error') idx.activeStream = null;
    }
    await fsp.writeFile(indexPath(id), JSON.stringify(idx, null, 2)).catch(() => {});
    return idx;
  }
}

/** List all rollouts newest-first with quick metadata. */
export async function listRollouts(): Promise<Array<{ id: string; updated: number; messageCount: number; project?: string; model?: string }>> {
  try {
    const entries = await fsp.readdir(ROLLOUT_DIR);
    const files = entries.filter((e) => e.endsWith('.jsonl'));
    const out: Array<{ id: string; updated: number; messageCount: number; project?: string; model?: string }> = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      const stat = await fsp.stat(path.join(ROLLOUT_DIR, f));
      const idx = await readIndex(id).catch(() => ({ messageCount: 0 } as RolloutIndex));
      let project: string | undefined; let model: string | undefined;
      try {
        const first = (await fsp.readFile(path.join(ROLLOUT_DIR, f), 'utf-8')).split('\n', 1)[0];
        if (first) {
          const header = JSON.parse(first) as RolloutHeader;
          project = header.payload?.project; model = header.payload?.model;
        }
      } catch { /* ignore */ }
      out.push({ id, updated: stat.mtimeMs, messageCount: idx.messageCount, project, model });
    }
    return out.sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}

/** Reconstruct the default (main) message chain for an AI SDK ModelMessage[] array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rebuildMessagesFromRollout(records: RolloutRecord[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = [];
  let current: { role: 'assistant'; content: string } | null = null;
  for (const r of records) {
    if (r.type === 'user-message') {
      if (current) { msgs.push(current); current = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      msgs.push({ role: 'user', content: (r.payload as any)?.content ?? '' });
    } else if (r.type === 'text-delta') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (r.payload as any)?.content ?? '';
      if (!current) current = { role: 'assistant', content: '' };
      current.content += delta;
    } else if (r.type === 'assistant-message') {
      if (current) { msgs.push(current); current = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      msgs.push({ role: 'assistant', content: (r.payload as any)?.content ?? '' });
    } else if (r.type === 'turn-end' && current) {
      msgs.push(current); current = null;
    }
  }
  if (current) msgs.push(current);
  return msgs;
}

/**
 * True if the session was interrupted mid-stream (process died before
 * turn-end). Callers can surface a "resuming…" UI and continue the turn.
 */
export function hasActiveStream(idx: RolloutIndex): boolean {
  return !!idx.activeStream;
}
