/**
 * Notch CLI — Edit Tool
 *
 * Exact string replacement in files. The old_string must match exactly
 * and be unique within the file.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const parameters = z.object({
  path: z.string().describe('Relative or absolute path to the file'),
  old_string: z.string().describe('Exact string to find and replace (must be unique in file)'),
  new_string: z.string().describe('Replacement string'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurrences'),
});

export const editTool: NotchTool<typeof parameters> = {
  name: 'edit',
  description:
    'Perform exact string replacement in a file. old_string must match exactly ' +
    'and be unique unless replace_all is true. Use small exact matches, without read-output line numbers. ' +
    'Use actual newlines for multiple lines; literal backslash sequences are preserved.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : path.resolve(ctx.cwd, params.path);

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (!content.includes(params.old_string)) {
        return {
          content: `old_string not found in ${filePath}. No files changed. Read the file again and use a smaller exact match, including whitespace and indentation.` +
            (params.old_string.includes('\\n') ? ' Your match contains literal backslash-n characters; use actual newlines when matching line breaks.' : ''),
          isError: true,
        };
      }

      if (!params.replace_all) {
        const firstIdx = content.indexOf(params.old_string);
        const secondIdx = content.indexOf(params.old_string, firstIdx + 1);
        if (secondIdx !== -1) {
          return {
            content:
              `old_string appears multiple times in ${filePath}. ` +
              'Provide more surrounding context to make it unique, or set replace_all: true.',
            isError: true,
          };
        }
      }

      const newContent = params.replace_all
        ? content.replaceAll(params.old_string, () => params.new_string)
        : content.replace(params.old_string, () => params.new_string);

      await fs.writeFile(filePath, newContent, 'utf-8');

      // Show a compact diff summary
      const oldLines = params.old_string.split('\n').length;
      const newLines = params.new_string.split('\n').length;
      return {
        content: `Edited ${filePath}: replaced ${oldLines} line(s) with ${newLines} line(s)`,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { content: `File not found: ${filePath}`, isError: true };
      }
      return { content: `Error editing ${filePath}: ${err.message}`, isError: true };
    }
  },
};
