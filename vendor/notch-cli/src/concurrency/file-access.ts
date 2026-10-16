import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { acquireLease } from './lease.js';
import { parsePatch } from '../tools/apply-patch.js';
import type { ToolContext, ToolResult } from '../tools/types.js';

async function canonical(file: string): Promise<string> {
  let resolved: string;
  try { resolved = await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    resolved = path.join(await canonical(parent), path.basename(file));
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
async function fingerprint(file: string, signal?: AbortSignal) {
  try {
    if (!(await fs.stat(file)).isFile()) throw new Error(`Not a regular file: ${file}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('hex');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const orchestration = new Set(['task', 'events', 'code_exec', 'code_wait', 'agent_spawn', 'agent_send_message', 'agent_stop', 'web_fetch', 'web_search', 'glob', 'grep']);

/** Serialize cooperating file operations, and reject writes based on an unread or stale file. */
export async function guardedFileAccess(name: string, params: Record<string, any>, ctx: ToolContext, execute: () => Promise<ToolResult>): Promise<ToolResult> {
  if (orchestration.has(name)) return execute();
  const release = await acquireLease('file-mutations', ctx.abortSignal, waiting => ctx.onQueue?.(waiting ? 'Waiting for file access…' : null));
  try {
    ctx.abortSignal?.throwIfAborted();
    const versions = ctx._fileVersions ??= new Map();
    let targets: string[] = [];
    if (['read', 'write', 'edit', 'notebook'].includes(name)) targets = [params.path];
    if (name === 'apply_patch') targets = parsePatch(params.input).flatMap(action => action.kind === 'update' && action.moveTo ? [action.target, action.moveTo] : [action.target]);
    const files = await Promise.all(targets.map(file => canonical(path.resolve(ctx.cwd, file))));
    const before = await Promise.all(files.map(file => fingerprint(file, ctx.abortSignal)));
    const reading = name === 'read' || (name === 'notebook' && params.action === 'read');
    // Opaque commands cannot declare targets; reject them if any observed input became stale.
    if (!files.length) for (const [file, observed] of versions) {
      if (await fingerprint(file, ctx.abortSignal) !== observed) return { isError: true, content: `File conflict: ${file} changed since this task read it. Read it again before running ${name}.` };
    }
    for (let i = 0; i < files.length; i++) {
      if (reading) {
        if (versions.get(files[i]!) !== before[i]) ctx._readCache?.clear();
      } else if (before[i] !== null && !versions.has(files[i]!)) {
        return { isError: true, content: `File conflict: read ${files[i]} before changing it. Existing contents were preserved.` };
      } else if (versions.has(files[i]!) && versions.get(files[i]!) !== before[i]) {
        return { isError: true, content: `File conflict: ${files[i]} changed since this task read it. Read it again and reconcile the changes before retrying. Existing contents were preserved.` };
      }
    }
    const result = await execute();
    for (let i = 0; i < files.length; i++) {
      if (result.isError) versions.delete(files[i]!);
      else versions.set(files[i]!, reading ? before[i]! : await fingerprint(files[i]!, ctx.abortSignal));
    }
    return result;
  } finally { await release(); }
}
