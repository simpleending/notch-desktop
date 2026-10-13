/**
 * Notch CLI — Notebook Tool
 *
 * Read and edit Jupyter .ipynb notebook files.
 * Supports reading cells, editing cell content, adding/removing cells,
 * and viewing cell outputs.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  outputs?: Array<{
    output_type: string;
    text?: string[];
    data?: Record<string, string[]>;
    ename?: string;
    evalue?: string;
    traceback?: string[];
  }>;
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

const parameters = z.object({
  action: z.enum(['read', 'edit', 'add', 'remove'])
    .describe('Action: read (view cells), edit (modify cell source), add (insert new cell), remove (delete cell)'),
  path: z.string().describe('Path to the .ipynb notebook file'),
  cell_index: z.number().optional().describe('Cell index (0-based) — for edit/remove actions'),
  cell_type: z.enum(['code', 'markdown', 'raw']).optional().describe('Cell type — for add action'),
  content: z.string().optional().describe('New cell content — for edit/add actions'),
  insert_after: z.number().optional().describe('Insert after this cell index — for add action (-1 for beginning)'),
});

/**
 * Format a notebook for display.
 */
function formatNotebook(nb: Notebook, filePath: string): string {
  const parts: string[] = [
    `# ${path.basename(filePath)}`,
    `# ${nb.cells.length} cells | nbformat ${nb.nbformat}.${nb.nbformat_minor}`,
    '',
  ];

  for (let i = 0; i < nb.cells.length; i++) {
    const cell = nb.cells[i]!;
    const source = cell.source.join('');
    const header = cell.cell_type === 'code'
      ? `[${i}] Code (exec: ${cell.execution_count ?? '-'})`
      : `[${i}] ${cell.cell_type.charAt(0).toUpperCase() + cell.cell_type.slice(1)}`;

    parts.push(`--- ${header} ---`);
    parts.push(source);

    // Show outputs for code cells
    if (cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
      parts.push('  Output:');
      for (const output of cell.outputs) {
        if (output.text) {
          parts.push('  ' + output.text.join('').slice(0, 500));
        } else if (output.data?.['text/plain']) {
          parts.push('  ' + output.data['text/plain'].join('').slice(0, 500));
        } else if (output.ename) {
          parts.push(`  Error: ${output.ename}: ${output.evalue}`);
        }
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

export const notebookTool: NotchTool<typeof parameters> = {
  name: 'notebook',
  description:
    'Read and edit Jupyter .ipynb notebook files. ' +
    'Actions: read (view all cells with outputs), edit (modify a cell), ' +
    'add (insert a new cell), remove (delete a cell).',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : path.resolve(ctx.cwd, params.path);

    try {
      switch (params.action) {
        case 'read': {
          const raw = await fs.readFile(filePath, 'utf-8');
          const nb = JSON.parse(raw) as Notebook;
          return { content: formatNotebook(nb, filePath) };
        }

        case 'edit': {
          if (params.cell_index === undefined) {
            return { content: 'cell_index is required for edit action.', isError: true };
          }
          if (params.content === undefined) {
            return { content: 'content is required for edit action.', isError: true };
          }

          const raw = await fs.readFile(filePath, 'utf-8');
          const nb = JSON.parse(raw) as Notebook;

          if (params.cell_index < 0 || params.cell_index >= nb.cells.length) {
            return { content: `Cell index ${params.cell_index} out of range (0-${nb.cells.length - 1}).`, isError: true };
          }

          // Split content into lines (notebook format stores as array of lines)
          const lines = params.content.split('\n').map((l, i, arr) =>
            i < arr.length - 1 ? l + '\n' : l
          );
          nb.cells[params.cell_index]!.source = lines;

          await fs.writeFile(filePath, JSON.stringify(nb, null, 1) + '\n');
          return { content: `Cell [${params.cell_index}] updated in ${path.basename(filePath)}.` };
        }

        case 'add': {
          if (params.content === undefined) {
            return { content: 'content is required for add action.', isError: true };
          }

          const raw = await fs.readFile(filePath, 'utf-8');
          const nb = JSON.parse(raw) as Notebook;

          const cellType = params.cell_type ?? 'code';
          const lines = params.content.split('\n').map((l, i, arr) =>
            i < arr.length - 1 ? l + '\n' : l
          );

          const newCell: NotebookCell = {
            cell_type: cellType,
            source: lines,
            metadata: {},
            ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
          };

          const insertIdx = params.insert_after !== undefined
            ? params.insert_after + 1
            : nb.cells.length;
          nb.cells.splice(insertIdx, 0, newCell);

          await fs.writeFile(filePath, JSON.stringify(nb, null, 1) + '\n');
          return { content: `Added ${cellType} cell at index [${insertIdx}] in ${path.basename(filePath)}.` };
        }

        case 'remove': {
          if (params.cell_index === undefined) {
            return { content: 'cell_index is required for remove action.', isError: true };
          }

          const raw = await fs.readFile(filePath, 'utf-8');
          const nb = JSON.parse(raw) as Notebook;

          if (params.cell_index < 0 || params.cell_index >= nb.cells.length) {
            return { content: `Cell index ${params.cell_index} out of range (0-${nb.cells.length - 1}).`, isError: true };
          }

          const removed = nb.cells.splice(params.cell_index, 1)[0]!;
          await fs.writeFile(filePath, JSON.stringify(nb, null, 1) + '\n');
          return { content: `Removed ${removed.cell_type} cell [${params.cell_index}] from ${path.basename(filePath)}. ${nb.cells.length} cells remaining.` };
        }

        default:
          return { content: `Unknown action: ${params.action}`, isError: true };
      }
    } catch (err: any) {
      return { content: `Notebook error: ${err.message}`, isError: true };
    }
  },
};
