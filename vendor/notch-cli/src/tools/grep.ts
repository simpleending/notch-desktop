/**
 * Notch CLI — Grep Tool
 *
 * Search file contents by text or regex pattern.
 * Uses ripgrep (rg) if available, falls back to Node.js implementation.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const execFileAsync = promisify(execFile);

const parameters = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search (defaults to project root)'),
  glob: z.string().optional().describe('Glob filter, e.g. "*.ts" or "**/*.tsx"'),
  context: z.number().int().nonnegative().optional().default(0).describe('Lines of context around each match'),
  max_results: z.number().int().positive().optional().default(50).describe('Maximum number of matches to return'),
});

export const grepTool: NotchTool<typeof parameters> = {
  name: 'grep',
  description:
    'Search file contents by regex pattern. Returns matching lines with file paths and line numbers. ' +
    'Supports glob filtering and context lines.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const searchPath = params.path
      ? path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path)
      : ctx.cwd;

    try {
      ctx.abortSignal?.throwIfAborted();
      if (ctx.workspaceSearch) {
        const result = await ctx.workspaceSearch('grep', params, ctx.cwd, ctx.abortSignal);
        if (result !== undefined) return result;
      }
      const rgArgs = [
        '--no-require-git',
        '--no-heading',
        '--line-number',
        '--color=never',
        `--max-count=${params.max_results}`,
        ...(params.context ? ['-C', String(params.context)] : []),
        ...(params.glob ? ['--glob', params.glob] : []),
        '--',
        params.pattern,
        searchPath,
      ];

      const { stdout } = await execFileAsync(ctx.ripgrepPath || 'rg', rgArgs, {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        signal: ctx.abortSignal,
      });

      return { content: stdout || '(no matches)' };
    } catch (err: any) {
      if (ctx.abortSignal?.aborted) return { content: 'Search cancelled.', isError: true };
      // ripgrep uses exit 1 for a successful search with no matches.
      if (err.code === 1) return { content: '(no matches)' };
      if (err.code !== 'ENOENT') {
        return { content: `Search error: ${err.stderr?.trim() || err.message}`, isError: true };
      }
    }

    // shortcut: fallback only handles extension globs and omits context, replace it if full ripgrep parity is needed.
    try {
      ctx.abortSignal?.throwIfAborted();
      const regex = new RegExp(params.pattern);
      const results: string[] = [];

      async function searchDir(dir: string) {
        ctx.abortSignal?.throwIfAborted();
        if (results.length >= (params.max_results ?? 50)) return;

        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          ctx.abortSignal?.throwIfAborted();
          if (results.length >= (params.max_results ?? 50)) return;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(full);
          } else if (entry.isFile()) {
            if (params.glob) {
              // Simple glob check: *.ext
              const ext = params.glob.replace(/^\*+\.?/, '');
              if (ext && !entry.name.endsWith(ext)) continue;
            }
            try {
              const content = await fs.readFile(full, 'utf-8');
              ctx.abortSignal?.throwIfAborted();
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]!)) {
                  const rel = path.relative(ctx.cwd, full);
                  results.push(`${rel}:${i + 1}:${lines[i]}`);
                  if (results.length >= (params.max_results ?? 50)) return;
                }
              }
            } catch (error) {
              if (ctx.abortSignal?.aborted) throw error;
              // Skip binary files or unreadable files
            }
          }
        }
      }

      const stat = await fs.stat(searchPath);
      if (stat.isFile()) {
        const content = await fs.readFile(searchPath, 'utf-8');
        ctx.abortSignal?.throwIfAborted();
        const lines = content.split('\n');
        const rel = path.relative(ctx.cwd, searchPath);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            results.push(`${rel}:${i + 1}:${lines[i]}`);
            if (results.length >= (params.max_results ?? 50)) break;
          }
        }
      } else {
        await searchDir(searchPath);
      }

      return { content: results.join('\n') || '(no matches)' };
    } catch (err: any) {
      return { content: `Search error: ${err.message}`, isError: true };
    }
  },
};
