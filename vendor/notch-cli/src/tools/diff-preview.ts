/**
 * Notch CLI — Diff Preview
 *
 * Generates unified diffs for file changes.
 * Used to preview edits before applying and for /diff command.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { theme } from '../ui/themes.js';

/**
 * Generate a unified diff between two strings.
 */
export function unifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  const t = theme();
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const hunks = computeHunks(oldLines, newLines);
  if (hunks.length === 0) return '(no changes)';

  const output: string[] = [
    t.diffHeader(`--- a/${filePath}`),
    t.diffHeader(`+++ b/${filePath}`),
  ];

  for (const hunk of hunks) {
    output.push(t.diffHeader(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        output.push(t.diffAdd(line));
      } else if (line.startsWith('-')) {
        output.push(t.diffRemove(line));
      } else {
        output.push(t.dim(line));
      }
    }
  }

  return output.join('\n');
}

/**
 * Simple diff summary: how many lines added/removed/changed.
 */
export function diffSummary(oldContent: string, newContent: string): string {
  const t = theme();
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const added = newLines.length - oldLines.length;
  const parts: string[] = [];
  if (added > 0) parts.push(t.diffAdd(`+${added}`));
  if (added < 0) parts.push(t.diffRemove(`${added}`));
  if (added === 0) parts.push(t.dim('0'));

  return parts.join(' ');
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Compute diff hunks using a simple LCS-based approach.
 */
function computeHunks(oldLines: string[], newLines: string[], context: number = 3): Hunk[] {
  // Find changed regions using simple line comparison
  const changes: Array<{ type: 'add' | 'remove' | 'same'; oldIdx: number; newIdx: number; line: string }> = [];

  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      changes.push({ type: 'same', oldIdx: oi, newIdx: ni, line: oldLines[oi]! });
      oi++;
      ni++;
    } else {
      // Look ahead to find sync point
      const syncPoint = findSync(oldLines, newLines, oi, ni, 10);

      if (syncPoint) {
        // Add removals
        while (oi < syncPoint.oi) {
          changes.push({ type: 'remove', oldIdx: oi, newIdx: ni, line: oldLines[oi]! });
          oi++;
        }
        // Add additions
        while (ni < syncPoint.ni) {
          changes.push({ type: 'add', oldIdx: oi, newIdx: ni, line: newLines[ni]! });
          ni++;
        }
      } else {
        // No sync found — dump remaining
        while (oi < oldLines.length) {
          changes.push({ type: 'remove', oldIdx: oi, newIdx: ni, line: oldLines[oi]! });
          oi++;
        }
        while (ni < newLines.length) {
          changes.push({ type: 'add', oldIdx: oi, newIdx: ni, line: newLines[ni]! });
          ni++;
        }
      }
    }
  }

  // Group changes into hunks with context
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let contextRemaining = 0;

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;

    if (c.type !== 'same') {
      if (!currentHunk) {
        // Start new hunk with leading context
        const start = Math.max(0, i - context);
        currentHunk = {
          oldStart: changes[start]!.oldIdx + 1,
          oldCount: 0,
          newStart: changes[start]!.newIdx + 1,
          newCount: 0,
          lines: [],
        };
        // Add leading context
        for (let j = start; j < i; j++) {
          currentHunk.lines.push(` ${changes[j]!.line}`);
          currentHunk.oldCount++;
          currentHunk.newCount++;
        }
      }

      if (c.type === 'remove') {
        currentHunk.lines.push(`-${c.line}`);
        currentHunk.oldCount++;
      } else {
        currentHunk.lines.push(`+${c.line}`);
        currentHunk.newCount++;
      }
      contextRemaining = context;
    } else if (currentHunk) {
      if (contextRemaining > 0) {
        currentHunk.lines.push(` ${c.line}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
        contextRemaining--;
      } else {
        hunks.push(currentHunk);
        currentHunk = null;
      }
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}

function findSync(
  oldLines: string[],
  newLines: string[],
  oi: number,
  ni: number,
  lookAhead: number,
): { oi: number; ni: number } | null {
  for (let d = 1; d <= lookAhead; d++) {
    // Check if advancing old by d finds a match
    if (oi + d < oldLines.length && ni < newLines.length && oldLines[oi + d] === newLines[ni]) {
      return { oi: oi + d, ni };
    }
    // Check if advancing new by d finds a match
    if (oi < oldLines.length && ni + d < newLines.length && oldLines[oi] === newLines[ni + d]) {
      return { oi, ni: ni + d };
    }
    // Check diagonal
    if (oi + d < oldLines.length && ni + d < newLines.length && oldLines[oi + d] === newLines[ni + d]) {
      return { oi: oi + d, ni: ni + d };
    }
  }
  return null;
}
