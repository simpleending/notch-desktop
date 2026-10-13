import {
  readIndex,
  readRollout,
  rolloutPath
} from "./chunk-S5MWOFHZ.js";

// vendor/notch-cli/src/session/session-index.ts
import fsp from "fs/promises";
import path from "path";
import os from "os";
var INDEX_PATH = path.join(os.homedir(), ".notch", "sessions.index.json");
var INDEX_SCHEMA = 1;
async function ensureDir() {
  await fsp.mkdir(path.dirname(INDEX_PATH), { recursive: true });
}
async function readIndexFile() {
  try {
    const raw = await fsp.readFile(INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.schema !== INDEX_SCHEMA) {
      return { schema: INDEX_SCHEMA, updatedAt: Date.now(), entries: {} };
    }
    return parsed;
  } catch {
    return { schema: INDEX_SCHEMA, updatedAt: Date.now(), entries: {} };
  }
}
async function writeIndexFile(file) {
  await ensureDir();
  file.updatedAt = Date.now();
  const tmp = INDEX_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2));
  await fsp.rename(tmp, INDEX_PATH);
}
async function deriveEntryFromRollout(id) {
  let records;
  try {
    records = await readRollout(id);
  } catch {
    return null;
  }
  if (records.length === 0) return null;
  const header = records[0];
  const rolloutIdx = await readIndex(id).catch(() => null);
  let firstUser = "";
  let forkSourceId;
  let forkFromSeq;
  let branches = 0;
  let cwd;
  {
    const headerPayload = header.payload;
    if (headerPayload?.cwd) cwd = headerPayload.cwd;
    if (headerPayload?.forkSourceId) {
      forkSourceId = headerPayload.forkSourceId;
      forkFromSeq = headerPayload.forkFromSeq;
    }
  }
  for (const r of records) {
    if (r.type === "user-message" && !firstUser) {
      const payload = r.payload;
      firstUser = (payload?.content ?? "").slice(0, 160);
    }
    if (r.type === "branch-fork") {
      branches++;
    }
  }
  const lastRecord = records[records.length - 1];
  const lastTurnAt = lastRecord && typeof lastRecord.ts === "number" ? lastRecord.ts : Date.now();
  const createdAtIso = header.payload?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const createdAt = new Date(createdAtIso).getTime();
  const turnCount = rolloutIdx?.messageCount ?? records.filter((r) => r.type === "user-message" || r.type === "assistant-message").length;
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
    hasActiveStream: !!rolloutIdx?.activeStream
  };
}
async function upsertSessionIndexEntry(id, patch) {
  const file = await readIndexFile();
  const derived = await deriveEntryFromRollout(id);
  if (!derived) return;
  file.entries[id] = { ...derived, ...patch ?? {} };
  await writeIndexFile(file);
}
async function rebuildIndex() {
  await ensureDir();
  const rolloutDir = path.dirname(rolloutPath("placeholder"));
  let files;
  try {
    files = (await fsp.readdir(rolloutDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [];
  }
  const entries = {};
  let skipped = 0;
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    const entry = await deriveEntryFromRollout(id);
    if (entry) entries[id] = entry;
    else skipped++;
  }
  await writeIndexFile({ schema: INDEX_SCHEMA, updatedAt: Date.now(), entries });
  return { indexed: Object.keys(entries).length, skipped };
}
async function querySessions(opts = {}) {
  const file = await readIndexFile();
  const all = Object.values(file.entries);
  const since = opts.since ? typeof opts.since === "number" ? opts.since : new Date(opts.since).getTime() : 0;
  const search = opts.search?.toLowerCase();
  const filtered = all.filter((e) => {
    if (opts.project && e.project !== opts.project) return false;
    if (opts.model && e.model !== opts.model) return false;
    if (opts.cwd && e.cwd !== opts.cwd) return false;
    if (since && e.lastTurnAt < since) return false;
    if (opts.nonEmptyOnly && e.turnCount === 0) return false;
    if (opts.interruptedOnly && !e.hasActiveStream) return false;
    if (search) {
      const hay = `${e.preview ?? ""} ${e.project ?? ""} ${e.model ?? ""} ${e.id}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}
async function getSession(id) {
  const file = await readIndexFile();
  return file.entries[id] ?? null;
}
async function forgetSession(id) {
  const file = await readIndexFile();
  if (id in file.entries) {
    delete file.entries[id];
    await writeIndexFile(file);
  }
}
async function tagSession(id, tags) {
  const file = await readIndexFile();
  const existing = file.entries[id];
  if (!existing) return;
  const merged = Array.from(/* @__PURE__ */ new Set([...existing.tags ?? [], ...tags]));
  file.entries[id] = { ...existing, tags: merged };
  await writeIndexFile(file);
}
function indexFilePath() {
  return INDEX_PATH;
}
export {
  deriveEntryFromRollout,
  forgetSession,
  getSession,
  indexFilePath,
  querySessions,
  rebuildIndex,
  tagSession,
  upsertSessionIndexEntry
};
