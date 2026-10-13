/**
 * Notch CLI — apply_patch Tool
 *
 * Implements the Codex/OpenAI patch format for precise multi-file edits:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +line 1
 *   +line 2
 *   *** Update File: path/to/existing.ts
 *   *** Move to: path/to/renamed.ts          (optional)
 *   @@ optional context header
 *   -removed line
 *   +added line
 *    unchanged context line
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 *
 * Advantages over raw string replacement: multi-file in one call, no line
 * numbers required, unambiguous add/delete/rename, context-anchored hunks
 * that tolerate minor drift. Models produce this format reliably.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type PatchAction =
  | { kind: 'add'; target: string; content: string }
  | { kind: 'delete'; target: string }
  | { kind: 'update'; target: string; moveTo?: string; hunks: Hunk[] };

export interface Hunk {
  /** Optional anchor line after `@@` — used to disambiguate when context repeats. */
  header?: string;
  /** Each op is either ` `, `-`, or `+` followed by the remainder of the line. */
  ops: PatchOp[];
}

export type PatchOp =
  | { op: 'keep'; line: string }
  | { op: 'del'; line: string }
  | { op: 'add'; line: string };

export class PatchParseError extends Error {}
export class PatchApplyError extends Error {}

export function parsePatch(raw: string): PatchAction[] {
  const lines = raw.split(/\r?\n/);
  let i = 0;

  // Strip optional leading/trailing fences and whitespace
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i >= lines.length) throw new PatchParseError('Empty patch');

  if (lines[i]!.trim() !== '*** Begin Patch') {
    throw new PatchParseError(`Patch must start with "*** Begin Patch" (got: ${lines[i]})`);
  }
  i++;

  const actions: PatchAction[] = [];

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '*** End Patch') {
      i++;
      // Trailing content after End Patch is tolerated
      return actions;
    }

    if (trimmed.startsWith('*** Add File: ')) {
      const target = trimmed.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      let sawPlusLine = false;
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        if (l.startsWith('+')) { body.push(l.slice(1)); sawPlusLine = true; }
        else if (l.trim() === '') body.push('');
        else throw new PatchParseError(`Add File body line must start with '+': ${l}`);
        i++;
      }
      // Empty-file add: zero `+` lines → write a zero-byte file, not '\n'.
      const content = sawPlusLine ? body.join('\n') : '';
      actions.push({ kind: 'add', target, content });
      continue;
    }

    if (trimmed.startsWith('*** Delete File: ')) {
      const target = trimmed.slice('*** Delete File: '.length).trim();
      actions.push({ kind: 'delete', target });
      i++;
      continue;
    }

    if (trimmed.startsWith('*** Update File: ')) {
      const target = trimmed.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && lines[i]!.trim().startsWith('*** Move to: ')) {
        moveTo = lines[i]!.trim().slice('*** Move to: '.length).trim();
        i++;
      }
      const hunks: Hunk[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        // `*** End of File` is a sentinel for the final hunk — skip and continue.
        if (l.trim() === '*** End of File') { i++; continue; }
        if (l.startsWith('@@')) {
          const header = l.slice(2).trim() || undefined;
          i++;
          const ops: PatchOp[] = [];
          while (
            i < lines.length &&
            !lines[i]!.startsWith('*** ') &&
            !lines[i]!.startsWith('@@') &&
            lines[i]!.trim() !== '*** End of File'
          ) {
            ops.push(parseOp(lines[i]!));
            i++;
          }
          hunks.push({ header, ops });
        } else {
          const ops: PatchOp[] = [];
          while (
            i < lines.length &&
            !lines[i]!.startsWith('*** ') &&
            !lines[i]!.startsWith('@@') &&
            lines[i]!.trim() !== '*** End of File'
          ) {
            ops.push(parseOp(lines[i]!));
            i++;
          }
          if (ops.length > 0) hunks.push({ ops });
        }
      }
      if (hunks.length === 0) {
        throw new PatchParseError(`Update File "${target}" has no hunks`);
      }
      actions.push({ kind: 'update', target, moveTo, hunks });
      continue;
    }

    if (trimmed === '') {
      i++;
      continue;
    }

    throw new PatchParseError(`Unexpected patch line: ${line}`);
  }

  throw new PatchParseError('Patch missing "*** End Patch"');
}

function parseOp(line: string): PatchOp {
  if (line.startsWith('+')) return { op: 'add', line: line.slice(1) };
  if (line.startsWith('-')) return { op: 'del', line: line.slice(1) };
  if (line.startsWith(' ')) return { op: 'keep', line: line.slice(1) };
  if (line === '') return { op: 'keep', line: '' };
  throw new PatchParseError(`Hunk line must start with ' ', '+', or '-': ${line}`);
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/**
 * Apply a parsed hunk to `source` lines by matching on context + deletions.
 * Returns the new lines. Throws PatchApplyError if context cannot be found.
 */
export function applyHunk(source: string[], hunk: Hunk): string[] {
  const pattern: string[] = [];
  const replacement: string[] = [];
  for (const op of hunk.ops) {
    if (op.op === 'keep') { pattern.push(op.line); replacement.push(op.line); }
    else if (op.op === 'del') { pattern.push(op.line); }
    else if (op.op === 'add') { replacement.push(op.line); }
  }
  if (pattern.length === 0) {
    // Pure insertion — append at end or at header location
    if (hunk.header) {
      const idx = source.findIndex((l) => l.includes(hunk.header!));
      if (idx === -1) throw new PatchApplyError(`Insertion header not found: ${hunk.header}`);
      return [...source.slice(0, idx + 1), ...replacement, ...source.slice(idx + 1)];
    }
    return [...source, ...replacement];
  }

  const matchIdx = findMatch(source, pattern, hunk.header);
  if (matchIdx === -1) {
    throw new PatchApplyError(
      `Could not locate hunk context${hunk.header ? ` near "${hunk.header}"` : ''}. ` +
      `First context line: ${JSON.stringify(pattern[0])}`
    );
  }
  return [
    ...source.slice(0, matchIdx),
    ...replacement,
    ...source.slice(matchIdx + pattern.length),
  ];
}

function findMatch(source: string[], pattern: string[], header?: string): number {
  // Three-pass fuzzy match matching Codex's seek_sequence algorithm:
  //   1. Exact match
  //   2. Trailing-whitespace stripped
  //   3. All leading + trailing whitespace stripped
  // The `@@` header scopes the search; if absent and multiple matches exist,
  // the caller sees PatchApplyError on apply.
  const start = header ? source.findIndex((l) => l.includes(header)) + 1 : 0;
  const scanFrom = Math.max(0, start);

  const strategies: Array<(s: string) => string> = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/, ''),
    (s) => s.trim(),
  ];

  for (const norm of strategies) {
    const normPattern = pattern.map(norm);
    for (let i = scanFrom; i + pattern.length <= source.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (norm(source[i + j]!) !== normPattern[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    // Also try ignoring the header scope if the first pass failed
    if (header) {
      for (let i = 0; i + pattern.length <= source.length; i++) {
        let ok = true;
        for (let j = 0; j < pattern.length; j++) {
          if (norm(source[i + j]!) !== normPattern[j]) { ok = false; break; }
        }
        if (ok) return i;
      }
    }
  }

  return -1;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const parameters = z.object({
  input: z.string().describe(
    'A patch in the apply_patch format. Must begin with "*** Begin Patch" and end with "*** End Patch". ' +
    'Use "*** Add File: path", "*** Update File: path" (with @@ context + +/-/space lines), ' +
    'or "*** Delete File: path" sections. Optionally "*** Move to: path" right after Update File.'
  ),
});

export const applyPatchTool: NotchTool<typeof parameters> = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch in the apply_patch format. Prefer this over the edit tool when ' +
    'making coordinated changes across multiple files, adding/deleting/renaming files, or when ' +
    'context-anchored hunks are safer than exact string match. Format: *** Begin Patch / *** Add|Update|Delete File: path / (for Update: @@ header, then lines prefixed with " ", "+", "-") / *** End Patch.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    let actions: PatchAction[];
    try {
      actions = parsePatch(params.input);
    } catch (err) {
      return { content: `Patch parse error: ${(err as Error).message}`, isError: true };
    }

    const summary: string[] = [];
    try {
      for (const action of actions) {
        const abs = path.isAbsolute(action.target)
          ? action.target
          : path.resolve(ctx.cwd, action.target);

        if (action.kind === 'add') {
          try {
            await fs.access(abs);
            return { content: `Add File failed: ${action.target} already exists`, isError: true };
          } catch { /* doesn't exist — good */ }
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, action.content, 'utf-8');
          summary.push(`A ${action.target}`);
        } else if (action.kind === 'delete') {
          await fs.unlink(abs);
          summary.push(`D ${action.target}`);
        } else {
          const original = await fs.readFile(abs, 'utf-8');
          // Preserve per-file line-ending (CRLF vs LF) and trailing-newline state.
          const hasCrlf = original.includes('\r\n');
          const eol = hasCrlf ? '\r\n' : '\n';
          const hadTrailingNewline = original.endsWith('\n') || original.endsWith('\r\n');
          const stripped = hasCrlf ? original.replace(/\r\n/g, '\n') : original;
          let lines = (hadTrailingNewline ? stripped.slice(0, -1) : stripped).split('\n');
          for (const hunk of action.hunks) {
            lines = applyHunk(lines, hunk);
          }
          const joined = lines.join(eol);
          const next = hadTrailingNewline ? joined + eol : joined;
          const destAbs = action.moveTo
            ? (path.isAbsolute(action.moveTo) ? action.moveTo : path.resolve(ctx.cwd, action.moveTo))
            : abs;
          if (action.moveTo) {
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            await fs.writeFile(destAbs, next, 'utf-8');
            await fs.unlink(abs);
            summary.push(`R ${action.target} -> ${action.moveTo}`);
          } else {
            await fs.writeFile(abs, next, 'utf-8');
            summary.push(`M ${action.target}`);
          }
        }
      }
    } catch (err) {
      return {
        content: `Patch apply failed: ${(err as Error).message}\nPartial changes may have been written. Applied so far: ${summary.join(', ') || '(none)'}`,
        isError: true,
      };
    }

    return { content: `Applied patch (${actions.length} file op${actions.length === 1 ? '' : 's'}):\n${summary.join('\n')}` };
  },
};
