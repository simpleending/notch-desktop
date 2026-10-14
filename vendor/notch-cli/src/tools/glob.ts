/**
 * Notch CLI — Glob Tool
 *
 * Find files by glob pattern. Returns matching paths sorted by modification time.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { glob as globFn } from 'glob';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const parameters = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx"'),
  path: z.string().optional().describe('Directory to search (defaults to project root)'),
});

export const globTool: NotchTool<typeof parameters> = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Returns relative paths sorted by modification time. ' +
    'Ignores node_modules and .git by default.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const searchDir = params.path
      ? path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path)
      : ctx.cwd;

    try {
      ctx.abortSignal?.throwIfAborted();
      if (ctx.workspaceSearch) {
        const result = await ctx.workspaceSearch('glob', params, ctx.cwd, ctx.abortSignal);
        if (result !== undefined) return result;
      }
      const matches = await globFn(params.pattern, {
        cwd: searchDir,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        nodir: true,
        dot: false,
      });

      if (matches.length === 0) {
        return { content: `No files matching "${params.pattern}" in ${path.relative(ctx.cwd, searchDir) || '.'}` };
      }

      const relative = matches.map((m) => path.relative(ctx.cwd, path.resolve(searchDir, m)));
      return {
        content: `Found ${relative.length} file(s):\n${relative.join('\n')}`,
      };
    } catch (err: any) {
      return { content: `Glob error: ${err.message}`, isError: true };
    }
  },
};
