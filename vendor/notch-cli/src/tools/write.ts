/**
 * Notch CLI — Write Tool
 *
 * Creates or overwrites a file with complete content.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const parameters = z.object({
  path: z.string().describe('Relative or absolute path to write'),
  content: z.string().describe('Complete file content to write'),
});

export const writeTool: NotchTool<typeof parameters> = {
  name: 'write',
  description:
    'Write a file (create or overwrite). Creates parent directories if needed. ' +
    'Always provide the COMPLETE file content.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : path.resolve(ctx.cwd, params.path);

    try {
      // Create parent directories
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Check if file exists for the confirmation message
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        // File doesn't exist, that's fine
      }

      await fs.writeFile(filePath, params.content, 'utf-8');

      const lines = params.content.split('\n').length;
      const action = existed ? 'Updated' : 'Created';
      return { content: `${action} ${filePath} (${lines} lines)` };
    } catch (err: any) {
      return { content: `Error writing ${filePath}: ${err.message}`, isError: true };
    }
  },
};
