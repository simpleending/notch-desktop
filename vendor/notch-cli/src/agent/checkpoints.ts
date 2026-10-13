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

export interface FileSnapshot {
  path: string;
  /** null means the file didn't exist before */
  before: string | null;
  after: string | null;
}

export interface Checkpoint {
  id: number;
  timestamp: number;
  files: FileSnapshot[];
  description: string;
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private pendingFiles = new Map<string, string | null>();
  private pendingReads = new Map<string, Promise<void>>();

  /** Call before a file is modified — records its current content */
  async recordBefore(filePath: string): Promise<void> {
    filePath = path.resolve(filePath);
    if (this.pendingFiles.has(filePath)) return;
    const existing = this.pendingReads.get(filePath);
    if (existing) return existing;
    const read = (async () => {
      try {
        const bytes = await fs.readFile(filePath);
        const content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes)) throw new Error(`Cannot safely snapshot binary file: ${filePath}`);
        this.pendingFiles.set(filePath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.pendingFiles.set(filePath, null);
      }
    })();
    this.pendingReads.set(filePath, read);
    try { await read; } finally { this.pendingReads.delete(filePath); }
  }

  /** Commit all pending file changes as a checkpoint */
  async commit(description: string): Promise<Checkpoint> {
    await Promise.all(this.pendingReads.values());
    const files: FileSnapshot[] = [];

    for (const [filePath, before] of this.pendingFiles) {
      let after: string | null = null;
      try {
        after = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (before !== after) files.push({ path: filePath, before, after });
    }

    const checkpoint: Checkpoint = {
      id: this.nextId++,
      timestamp: Date.now(),
      files,
      description,
    };

    if (files.length) this.checkpoints.push(checkpoint);
    this.pendingFiles.clear();
    return checkpoint;
  }

  /** Undo the most recent checkpoint — restores all files to their before state */
  async undo(): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.at(-1);
    if (!checkpoint) return null;

    // Validate every target before restoring any; preserve edits made outside Notch.
    for (const snap of checkpoint.files) {
      let current: string | null = null;
      try { current = await fs.readFile(snap.path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current !== snap.after && current !== snap.before) throw new Error(`Undo blocked: ${snap.path} changed since this checkpoint.`);
    }

    for (const snap of checkpoint.files) {
      if (snap.before === null) {
        // File was created — delete it
        try { await fs.unlink(snap.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else {
        // Restore original content
        await fs.mkdir(path.dirname(snap.path), { recursive: true });
        await fs.writeFile(snap.path, snap.before, 'utf-8');
      }
    }
    this.checkpoints.pop();
    return checkpoint;
  }

  /** Get the list of checkpoints (most recent last) */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** How many checkpoints are available to undo */
  get undoCount(): number {
    return this.checkpoints.length;
  }

  /** Discard pending without committing */
  discard(): void {
    this.pendingFiles.clear();
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
