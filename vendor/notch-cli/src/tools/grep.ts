/**
 * Notch CLI — Grep Tool
 *
 * Search file contents by text or regex pattern.
 * Uses ripgrep (rg) if available, falls back to Node.js implementation.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const parameters = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search (defaults to project root)'),
  glob: z.string().optional().describe('Glob filter, e.g. "*.ts" or "**/*.tsx"'),
  context: z.number().optional().default(0).describe('Lines of context around each match'),
  max_results: z.number().optional().default(50).describe('Maximum number of matches to return'),
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

    // Try ripgrep first (much faster for large codebases)
    try {
      const rgArgs = [
        'rg',
        '--no-heading',
        '--line-number',
        '--color=never',
        `--max-count=${params.max_results}`,
        params.context ? `-C ${params.context}` : '',
        params.glob ? `--glob "${params.glob}"` : '',
        '--',
        JSON.stringify(params.pattern),
        searchPath,
      ].filter(Boolean).join(' ');

      const output = execSync(rgArgs, {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 5 * 1024 * 1024,
      });

      return { content: output || '(no matches)' };
    } catch {
      // ripgrep not available or no matches — fall back to Node.js
    }

    // Node.js fallback
    try {
      const regex = new RegExp(params.pattern, 'g');
      const results: string[] = [];

      async function searchDir(dir: string) {
        if (results.length >= (params.max_results ?? 50)) return;

        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
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
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]!)) {
                  const rel = path.relative(ctx.cwd, full);
                  results.push(`${rel}:${i + 1}:${lines[i]}`);
                  regex.lastIndex = 0;
                  if (results.length >= (params.max_results ?? 50)) return;
                }
              }
            } catch {
              // Skip binary files or unreadable files
            }
          }
        }
      }

      const stat = await fs.stat(searchPath);
      if (stat.isFile()) {
        const content = await fs.readFile(searchPath, 'utf-8');
        const lines = content.split('\n');
        const rel = path.relative(ctx.cwd, searchPath);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            results.push(`${rel}:${i + 1}:${lines[i]}`);
            regex.lastIndex = 0;
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
