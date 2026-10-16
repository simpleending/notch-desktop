/**
 * Notch CLI — File Change Checkpoints
 *
 * Tracks file changes made by tools so they can be undone.
 * Each agent round creates a checkpoint with before/after snapshots.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLease } from '../concurrency/lease.js';

export interface FileSnapshot {
  path: string;
  /** null means the file didn't exist before */
  before: string | null;
  after: string | null;
  uncertain?: boolean;
}

export interface Checkpoint {
  id: number;
  timestamp: number;
  files: FileSnapshot[];
  description: string;
  messageId?: string;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private pendingFiles = new Map<string, string | null>();
  private pendingReads = new Map<string, Promise<void>>();
  private pendingAfter = new Map<string, string | null>();
  private messageId?: string;
  private storage?: { cwd: string; file: string; identity: string };
  private saving = Promise.resolve();
  private restoring?: { index: number; files: FileSnapshot[] };

  static async open(cwd: string, file: string): Promise<CheckpointManager> {
    const manager = new CheckpointManager();
    const realCwd = await fs.realpath(cwd), stat = await fs.stat(realCwd, { bigint: true });
    manager.storage = { cwd: realCwd, file: path.resolve(file), identity: `${stat.dev}:${stat.ino}` };
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return manager; throw error; }
    if (Buffer.byteLength(raw) > 64 * 2 ** 20) throw new Error('Undo history exceeds 64 MiB.');
    const state = JSON.parse(raw);
    if (state.version !== 1 || state.cwd !== manager.storage.cwd || state.identity !== manager.storage.identity || !Array.isArray(state.checkpoints) || !Array.isArray(state.pending)) throw new Error('Invalid undo history or workspace mismatch; history was preserved.');
    const snapshot = (row: FileSnapshot, pending = false) => {
      if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path) || !manager.isWithin(row.path) ||
        !(row.before === null || typeof row.before === 'string') ||
        !(row.after === null || typeof row.after === 'string' || (pending && row.after === undefined)) ||
        (row.uncertain !== undefined && typeof row.uncertain !== 'boolean')) throw new Error('Invalid undo snapshot; history was preserved.');
    };
    let previous = 0;
    for (const row of state.checkpoints) {
      if (!Number.isSafeInteger(row.id) || row.id <= previous || !Number.isFinite(row.timestamp) || typeof row.description !== 'string' || !Array.isArray(row.files)) throw new Error('Invalid undo checkpoint.');
      manager.validateMessageId(row.messageId);
      row.files.forEach((file: FileSnapshot) => snapshot(file));
      if (new Set(row.files.map((file: FileSnapshot) => file.path)).size !== row.files.length) throw new Error('Duplicate undo path.');
      previous = row.id;
    }
    if (!Number.isSafeInteger(state.nextId) || state.nextId <= previous) throw new Error('Invalid undo sequence.');
    manager.checkpoints = state.checkpoints; manager.nextId = state.nextId;
    manager.validateMessageId(state.messageId); manager.messageId = state.messageId;
    for (const row of state.pending) {
      snapshot(row, true);
      if (manager.pendingFiles.has(row.path)) throw new Error('Duplicate pending undo path.');
      manager.pendingFiles.set(row.path, row.before);
      if (row.after !== undefined) manager.pendingAfter.set(row.path, row.after);
    }
    if (state.restoring) {
      if (!Number.isInteger(state.restoring.index) || state.restoring.index < 0 || state.restoring.index >= manager.checkpoints.length || !Array.isArray(state.restoring.files)) throw new Error('Invalid undo recovery transaction.');
      state.restoring.files.forEach((file: FileSnapshot) => snapshot(file)); manager.restoring = state.restoring;
    }
    if (manager.pendingFiles.size) {
      const files: FileSnapshot[] = [];
      for (const [filePath, before] of manager.pendingFiles) {
        const current = await manager.read(filePath);
        if (current !== before) files.push({ path: filePath, before, after: manager.pendingAfter.get(filePath) ?? null, uncertain: !manager.pendingAfter.has(filePath) });
      }
      manager.checkpoints.push({ id: manager.nextId++, timestamp: Date.now(), files, description: 'Interrupted turn', messageId: manager.messageId });
      manager.pendingFiles.clear(); manager.pendingAfter.clear(); manager.messageId = undefined;
      await manager.persist();
    }
    return manager;
  }
  private validateMessageId(id?: string): void {
    if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_:.-]{1,128}$/.test(id))) throw new Error('Invalid undo turn ID.');
  }
  private isWithin(file: string): boolean {
    if (!this.storage) return true;
    const relative = path.relative(this.storage.cwd, file);
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && (process.platform !== 'win32' || !relative.includes(':'));
  }
  private async safePath(file: string): Promise<void> {
    if (!this.isWithin(file)) throw new Error('Undo path is outside this workspace.');
    if (this.storage) {
      const relative = path.relative(path.dirname(this.storage.file), file);
      if (path.resolve(file) === this.storage.file || (this.isWithin(path.dirname(this.storage.file)) && (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))))) throw new Error('Agent changes cannot overwrite undo history.');
    }
    let cursor = file;
    while (true) {
      try { const stat = await fs.lstat(cursor); if (stat.isSymbolicLink() || (cursor === file && stat.nlink > 1)) throw new Error('Undo refuses symbolic links and shared hard links.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (cursor === this.storage?.cwd || path.dirname(cursor) === cursor) break;
      cursor = path.dirname(cursor);
    }
  }
  private async read(file: string): Promise<string | null> {
    await this.safePath(file);
    try {
      const bytes = await fs.readFile(file), content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes)) throw new Error(`Cannot safely snapshot binary file: ${file}`);
      return content;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async persist(): Promise<void> {
    if (!this.storage) return;
    const data = JSON.stringify({ version: 1, cwd: this.storage.cwd, identity: this.storage.identity, nextId: this.nextId, checkpoints: this.checkpoints,
      pending: [...this.pendingFiles].map(([path, before]) => ({ path, before, after: this.pendingAfter.get(path) })), messageId: this.messageId, restoring: this.restoring });
    if (Buffer.byteLength(data) > 64 * 2 ** 20) throw new Error('Undo history exceeds 64 MiB; no further writes are allowed.');
    const file = this.storage.file;
    const save = this.saving.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx', flush: true }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.saving = save.catch(() => {}); await save;
  }
  async beginTurn(messageId: string): Promise<void> {
    this.validateMessageId(messageId);
    if (this.restoring || this.pendingFiles.size) throw new Error('Finish pending undo recovery before starting another turn.');
    this.messageId = messageId; await this.persist();
  }

  /** Call before a file is modified — records its current content */
  async recordBefore(filePath: string): Promise<void> {
    filePath = path.resolve(filePath);
    const existing = this.pendingReads.get(filePath);
    if (existing) return existing;
    const read = (async () => {
      if (this.restoring) throw new Error('Finish pending undo recovery before writing files.');
      await this.safePath(filePath);
      if (this.pendingFiles.has(filePath)) {
        if (this.pendingAfter.has(filePath) && await this.read(filePath) !== this.pendingAfter.get(filePath)) throw new Error(`File changed during this turn: ${filePath}`);
        this.pendingAfter.delete(filePath); await this.persist(); return;
      }
      try {
        const bytes = await fs.readFile(filePath);
        const content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes)) throw new Error(`Cannot safely snapshot binary file: ${filePath}`);
        this.pendingFiles.set(filePath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.pendingFiles.set(filePath, null);
      }
      await this.persist();
    })();
    this.pendingReads.set(filePath, read);
    try { await read; } finally { this.pendingReads.delete(filePath); }
  }

  async recordAfter(filePath?: string): Promise<void> {
    await Promise.all(this.pendingReads.values());
    if (filePath !== undefined) {
      filePath = path.resolve(filePath);
      if (!this.pendingFiles.has(filePath)) throw new Error('Capture the file before recording its completed write.');
      this.pendingAfter.set(filePath, await this.read(filePath));
    } else for (const filePath of this.pendingFiles.keys()) if (!this.pendingAfter.has(filePath)) this.pendingAfter.set(filePath, await this.read(filePath));
    await this.persist();
  }

  /** Commit all pending file changes as a checkpoint */
  async commit(description: string): Promise<Checkpoint> {
    await this.recordAfter();
    const files: FileSnapshot[] = [];

    for (const [filePath, before] of this.pendingFiles) {
      const after = this.pendingAfter.get(filePath)!;
      if (await this.read(filePath) !== after) throw new Error(`File changed since tool completion: ${filePath}`);
      if (before !== after) files.push({ path: filePath, before, after });
    }

    const checkpoint: Checkpoint = {
      id: this.nextId++,
      timestamp: Date.now(),
      files,
      description,
      messageId: this.messageId,
    };

    if (files.length || this.messageId) this.checkpoints.push(checkpoint);
    this.pendingFiles.clear();
    this.pendingAfter.clear(); this.messageId = undefined;
    await this.persist();
    return checkpoint;
  }

  /** Undo the most recent checkpoint — restores all files to their before state */
  private selection(messageId?: string): { index: number; files: FileSnapshot[] } | null {
    if (this.restoring) {
      if (messageId && this.checkpoints[this.restoring.index]?.messageId !== messageId) throw new Error('Retry interrupted undo before choosing another turn.');
      return this.restoring;
    }
    const index = messageId ? this.checkpoints.findIndex(row => row.messageId === messageId) : this.checkpoints.map(row => row.files.length > 0).lastIndexOf(true);
    if (index < 0) { if (messageId) throw new Error('No saved file checkpoint for this turn.'); return null; }
    const files = new Map<string, FileSnapshot>();
    for (const checkpoint of this.checkpoints.slice(index)) for (const snapshot of checkpoint.files) {
      const old = files.get(snapshot.path);
      files.set(snapshot.path, { ...snapshot, before: old ? old.before : snapshot.before, uncertain: !!(old?.uncertain || snapshot.uncertain) });
    }
    return { index, files: [...files.values()] };
  }
  async preview(messageId?: string) {
    const selected = this.selection(messageId);
    if (!selected) return { canRewind: false, filesChanged: [] as string[], insertions: 0, deletions: 0 };
    for (const snap of selected.files) {
      const current = await this.read(snap.path);
      if (snap.uncertain && current !== snap.before) throw new Error(`Undo blocked: interrupted write to ${snap.path} was not verified. Inspect this file first.`);
      if (current !== snap.after && current !== snap.before) throw new Error(`Undo blocked: ${snap.path} changed since this checkpoint.`);
    }
    return { canRewind: true, filesChanged: selected.files.map(row => row.path), insertions: 0, deletions: 0 };
  }
  async undo(messageId?: string): Promise<Checkpoint | null> {
    const release = await acquireLease('file-mutations');
    try { return await this.undoLocked(messageId); } finally { await release(); }
  }
  private async undoLocked(messageId?: string): Promise<Checkpoint | null> {
    const selected = this.selection(messageId);
    if (!selected) return null;
    await this.preview(messageId);
    const checkpoint = this.checkpoints[selected.index]!;
    this.restoring = selected; await this.persist();

    // Validate every target before restoring any; preserve edits made outside Notch.
    for (const snap of selected.files) {
      const current = await this.read(snap.path);
      if (current !== snap.after && current !== snap.before) throw new Error(`Undo blocked: ${snap.path} changed since this checkpoint.`);
    }

    for (const snap of selected.files) {
      const current = await this.read(snap.path);
      if (current !== snap.after && current !== snap.before) throw new Error(`Undo blocked: ${snap.path} changed since this checkpoint.`);
      if (current === snap.before) continue;
      if (snap.before === null) {
        // File was created — delete it
        try { await fs.unlink(snap.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else {
        // Restore original content
        await fs.mkdir(path.dirname(snap.path), { recursive: true });
        const temporary = `${snap.path}.${randomUUID()}.undo-tmp`;
        const mode = current === null ? 0o600 : (await fs.stat(snap.path)).mode & 0o777;
        try { await fs.writeFile(temporary, snap.before, { mode, flag: 'wx', flush: true }); await fs.rename(temporary, snap.path); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      }
    }
    this.checkpoints.splice(selected.index); this.restoring = undefined;
    await this.persist();
    return { ...checkpoint, files: selected.files };
  }

  /** Get the list of checkpoints (most recent last) */
  list(): Checkpoint[] {
    return structuredClone(this.checkpoints);
  }

  /** How many checkpoints are available to undo */
  get undoCount(): number {
    return this.checkpoints.filter(row => row.files.length > 0).length;
  }

  /** Discard pending without committing */
  discard(): void {
    if (this.storage) throw new Error('Persisted pending snapshots cannot be discarded without verification.');
    this.pendingFiles.clear();
    this.pendingAfter.clear();
  }

  /**
   * Get all diffs across all checkpoints (for /diff command).
   * Returns unique file paths with their first-seen "before" and latest "after" content.
   */
  allDiffs(): Array<{ path: string; before: string | null; after: string | null }> {
    const fileMap = new Map<string, { before: string | null; after: string | null }>();

    for (const checkpoint of this.checkpoints) {
      for (const snapshot of checkpoint.files) {
        if (!fileMap.has(snapshot.path)) {
          fileMap.set(snapshot.path, { before: snapshot.before, after: snapshot.after });
        } else {
          // Update the "after" to the latest version
          fileMap.get(snapshot.path)!.after = snapshot.after;
        }
      }
    }

    return Array.from(fileMap.entries()).map(([path, { before, after }]) => ({
      path,
      before,
      after,
    }));
  }
}
