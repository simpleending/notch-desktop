// vendor/notch-cli/src/session/rollout.ts
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
var ROLLOUT_DIR = path.join(os.homedir(), ".notch", "rollouts");
async function ensureDir() {
  await fsp.mkdir(ROLLOUT_DIR, { recursive: true });
}
function rolloutPath(id) {
  return path.join(ROLLOUT_DIR, `${id}.jsonl`);
}
function indexPath(id) {
  return path.join(ROLLOUT_DIR, `${id}.idx.json`);
}
var Rollout = class {
  constructor(id) {
    this.id = id;
  }
  id;
  fd = null;
  seq = 0;
  idx = {
    lastSeq: -1,
    messageCount: 0,
    branches: {},
    activeStream: null
  };
  async openNew(header) {
    await ensureDir();
    this.fd = await fsp.open(rolloutPath(this.id), "a");
    await this.writeRecord({
      type: "header",
      payload: { id: this.id, project: header.project, model: header.model, createdAt: (/* @__PURE__ */ new Date()).toISOString(), schema: 1 }
    });
  }
  async openExisting() {
    await ensureDir();
    this.idx = await readIndex(this.id);
    this.seq = this.idx.lastSeq + 1;
    this.fd = await fsp.open(rolloutPath(this.id), "a");
  }
  async close() {
    await this.saveIndex();
    if (this.fd) {
      await this.fd.close();
      this.fd = null;
    }
    try {
      const { upsertSessionIndexEntry } = await import("./session-index-WA3YH4SW.js");
      await upsertSessionIndexEntry(this.id);
    } catch {
    }
  }
  async writeRecord(partial) {
    if (!this.fd) throw new Error("rollout not open");
    const rec = { seq: this.seq++, ts: Date.now(), ...partial };
    const line = JSON.stringify(rec) + "\n";
    await this.fd.write(line);
    this.idx.lastSeq = rec.seq;
    if (rec.type === "user-message" || rec.type === "assistant-message") {
      this.idx.messageCount++;
      if (rec.parent && rec.msgId) {
        (this.idx.branches[rec.parent] ??= []).push(rec.msgId);
      }
    }
    if (rec.type === "active-stream") {
      this.idx.activeStream = rec.streamId ?? null;
    } else if (rec.type === "turn-end" || rec.type === "error") {
      this.idx.activeStream = null;
    }
    return rec;
  }
  append(record) {
    return this.writeRecord(record);
  }
  async flush() {
    if (this.fd) await this.fd.sync();
    await this.saveIndex();
  }
  async saveIndex() {
    await fsp.writeFile(indexPath(this.id), JSON.stringify(this.idx, null, 2));
  }
  get activeStream() {
    return this.idx.activeStream;
  }
  get index() {
    return this.idx;
  }
};
async function readRollout(id) {
  const raw = await fsp.readFile(rolloutPath(id), "utf-8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
async function readIndex(id) {
  try {
    const raw = await fsp.readFile(indexPath(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    const records = await readRollout(id);
    const idx = { lastSeq: -1, messageCount: 0, branches: {}, activeStream: null };
    for (const r of records) {
      idx.lastSeq = r.seq;
      if (r.type === "user-message" || r.type === "assistant-message") {
        idx.messageCount++;
        if (r.parent && r.msgId) (idx.branches[r.parent] ??= []).push(r.msgId);
      }
      if (r.type === "active-stream") idx.activeStream = r.streamId ?? null;
      else if (r.type === "turn-end" || r.type === "error") idx.activeStream = null;
    }
    await fsp.writeFile(indexPath(id), JSON.stringify(idx, null, 2)).catch(() => {
    });
    return idx;
  }
}

export {
  rolloutPath,
  Rollout,
  readRollout,
  readIndex
};
