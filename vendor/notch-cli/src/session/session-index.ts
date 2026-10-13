/**
 * Notch CLI — Cross-Session Index
 * =================================
 * A single JSON file at `~/.notch/sessions.index.json` that catalogs every
 * rollout on disk. Replaces the O(N) directory walk in `listRollouts()` with
 * an O(1) lookup + O(N) substring search that stays in memory.
 *
 * Codex ships `codex-rs/rollout/src/session_index.rs` backed by SQLite — we
 * use JSON because this CLI is distributed as an npm package and a native
 * sqlite binding is a cross-platform install hazard. At the per-user scale
 * (hundreds to a few thousand sessions) a flat JSON index is well within a
 * few milliseconds per read.
 *
 * The index is authoritative for metadata ONLY. The JSONL rollout is still
 * the ground-truth event log. When the two disagree, the rollout wins — run
 * `rebuildIndex()` to reconcile.
 *
 * Callers:
 *   - `rollout.ts::Rollout` upserts on close via `upsertSessionIndexEntry()`.
 *   - `commands/resume.ts`, `commands/sessions.ts` read via `listSessions()`.
 *   - `forkSession()` inserts a new entry pointing at `fork_source_id`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readIndex, readRollout, rolloutPath, type RolloutHeader, type RolloutRecord } from './rollout.js';

const INDEX_PATH = path.join(os.homedir(), '.notch', 'sessions.index.json');
const INDEX_SCHEMA = 1;

export interface SessionIndexEntry {
  id: string;
  project?: string;
  model?: string;
  createdAt: number;        // epoch ms
  lastTurnAt: number;       // epoch ms of last record
  turnCount: number;
  preview: string;          // first user-message truncated to 160 chars
  cwd?: string;
  branches: number;         // count of fork events off this session
  forkSourceId?: string;    // set if this session was forked
  forkFromSeq?: number;     // seq it was forked at
  hasActiveStream: boolean; // crash-interrupted?
  tags?: string[];
}

interface IndexFile {
  schema: number;
  updatedAt: number;
  entries: Record<string, SessionIndexEntry>;
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(path.dirname(INDEX_PATH), { recursive: true });
}

async function readIndexFile(): Promise<IndexFile> {
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed.schema !== INDEX_SCHEMA) {
      // Future-schema bump hook. For now we only have v1.
      return { schema: INDEX_SCHEMA, updatedAt: Date.now(), entries: {} };
    }
    return parsed;
  } catch {
    return { schema: INDEX_SCHEMA, updatedAt: Date.now(), entries: {} };
  }
}

async function writeIndexFile(file: IndexFile): Promise<void> {
  await ensureDir();
  file.updatedAt = Date.now();
  // Atomic write: tempfile + rename so a crash mid-write can't corrupt
  // the global index. The rollout JSONL is always the source of truth
  // for reconstruction anyway, but a clean index is cheaper to load.
  const tmp = INDEX_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2));
  await fsp.rename(tmp, INDEX_PATH);
}

/**
 * Derive a SessionIndexEntry from a rollout's current on-disk state.
 * Walks the JSONL once — cheap enough for the close-path, too expensive to
 * call per-record.
 */
export async function deriveEntryFromRollout(id: string): Promise<SessionIndexEntry | null> {
  let records: RolloutRecord[];
  try {
    records = await readRollout(id);
  } catch {
    return null;
  }
  if (records.length === 0) return null;

  const header = records[0] as RolloutHeader;
  const rolloutIdx = await readIndex(id).catch(() => null);

  let firstUser = '';
  let forkSourceId: string | undefined;
  let forkFromSeq: number | undefined;
  let branches = 0;
  let cwd: string | undefined;

  // Also pick up lineage from the header payload — that's where forkSession
  // stamps it on the CHILD side (the SOURCE side records a branch-fork event
  // instead). Reading both keeps the derivation symmetric.
  {
    const headerPayload = header.payload as
      | { cwd?: string; forkSourceId?: string; forkFromSeq?: number }
      | undefined;
    if (headerPayload?.cwd) cwd = headerPayload.cwd;
    if (headerPayload?.forkSourceId) {
      forkSourceId = headerPayload.forkSourceId;
      forkFromSeq = headerPayload.forkFromSeq;
    }
  }

  for (const r of records) {
    if (r.type === 'user-message' && !firstUser) {
      const payload = r.payload as { content?: string } | undefined;
      firstUser = (payload?.content ?? '').slice(0, 160);
    }
    if (r.type === 'branch-fork') {
      branches++;
    }
  }

  const lastRecord = records[records.length - 1];
  const lastTurnAt = lastRecord && typeof lastRecord.ts === 'number' ? lastRecord.ts : Date.now();

  const createdAtIso = header.payload?.createdAt ?? new Date().toISOString();
  const createdAt = new Date(createdAtIso).getTime();

  const turnCount = rolloutIdx?.messageCount ?? records.filter((r) => r.type === 'user-message' || r.type === 'assistant-message').length;

  return {
    id,
    project: header.payload?.project,
    model: header.payload?.model,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    lastTurnAt,
    turnCount,
    preview: firstUser,
    cwd,
    branches,
    forkSourceId,
    forkFromSeq,
    hasActiveStream: !!rolloutIdx?.activeStream,
  };
}

/**
 * Update-or-insert a single session's entry. Called by `Rollout.close()`.
 * Silently succeeds if the rollout can't be read — the index is best-effort.
 */
export async function upsertSessionIndexEntry(id: string, patch?: Partial<SessionIndexEntry>): Promise<void> {
  const file = await readIndexFile();
  const derived = await deriveEntryFromRollout(id);
  if (!derived) return;
  file.entries[id] = { ...derived, ...(patch ?? {}) };
  await writeIndexFile(file);
}

/** Fully rebuild the index from disk — walks every rollout JSONL. */
export async function rebuildIndex(): Promise<{ indexed: number; skipped: number }> {
  await ensureDir();
  const rolloutDir = path.dirname(rolloutPath('placeholder')); // resolves ~/.notch/rollouts
  let files: string[];
  try {
    files = (await fsp.readdir(rolloutDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  const entries: Record<string, SessionIndexEntry> = {};
  let skipped = 0;
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    const entry = await deriveEntryFromRollout(id);
    if (entry) entries[id] = entry;
    else skipped++;
  }
  await writeIndexFile({ schema: INDEX_SCHEMA, updatedAt: Date.now(), entries });
  return { indexed: Object.keys(entries).length, skipped };
}

export interface ListOptions {
  project?: string;
  model?: string;
  cwd?: string;
  /** ISO string or epoch ms — only sessions whose lastTurnAt >= this. */
  since?: string | number;
  /** Substring match against preview/project/model (case-insensitive). */
  search?: string;
  /** Hide sessions with zero turns (preview-less stubs). */
  nonEmptyOnly?: boolean;
  /** Only sessions that crashed mid-stream. */
  interruptedOnly?: boolean;
  limit?: number;
}

/** Read the index and apply filters. Returns newest-first. */
export async function querySessions(opts: ListOptions = {}): Promise<SessionIndexEntry[]> {
  const file = await readIndexFile();
  const all = Object.values(file.entries);
  const since = opts.since ? (typeof opts.since === 'number' ? opts.since : new Date(opts.since).getTime()) : 0;
  const search = opts.search?.toLowerCase();

  const filtered = all.filter((e) => {
    if (opts.project && e.project !== opts.project) return false;
    if (opts.model && e.model !== opts.model) return false;
    if (opts.cwd && e.cwd !== opts.cwd) return false;
    if (since && e.lastTurnAt < since) return false;
    if (opts.nonEmptyOnly && e.turnCount === 0) return false;
    if (opts.interruptedOnly && !e.hasActiveStream) return false;
    if (search) {
      const hay = `${e.preview ?? ''} ${e.project ?? ''} ${e.model ?? ''} ${e.id}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/** Get one entry by id. */
export async function getSession(id: string): Promise<SessionIndexEntry | null> {
  const file = await readIndexFile();
  return file.entries[id] ?? null;
}

/** Drop a session's index entry (does NOT delete the JSONL — caller's job). */
export async function forgetSession(id: string): Promise<void> {
  const file = await readIndexFile();
  if (id in file.entries) {
    delete file.entries[id];
    await writeIndexFile(file);
  }
}

/** Tag a session (user-applied labels for grouping). Idempotent. */
export async function tagSession(id: string, tags: string[]): Promise<void> {
  const file = await readIndexFile();
  const existing = file.entries[id];
  if (!existing) return;
  const merged = Array.from(new Set([...(existing.tags ?? []), ...tags]));
  file.entries[id] = { ...existing, tags: merged };
  await writeIndexFile(file);
}

/** The canonical index file location. Exported for tests + diagnostics. */
export function indexFilePath(): string {
  return INDEX_PATH;
}
