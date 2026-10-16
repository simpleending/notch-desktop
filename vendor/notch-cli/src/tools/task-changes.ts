import { z } from 'zod';
import type { NotchTool } from './types.js';

export const taskChangesTool: NotchTool = {
  name: 'task_changes',
  description: 'Inspect this private task’s pending file changes. read_source reads the latest original project file; then edit the private task file to reconcile those contents before finishing. Merely reading newer source never authorizes a stale overwrite. Changes are applied automatically when the task completes.',
  parameters: z.object({ action: z.enum(['status', 'read_source']), path: z.string().optional() }),
  execute: async (args, ctx) => {
    if (!ctx.taskWorkspace) return { content: 'No private task workspace is active.', isError: true };
    if (args.action === 'read_source') {
      if (!args.path) return { content: 'Specify a relative source path.', isError: true };
      return { content: await ctx.taskWorkspace.readSource(args.path) };
    }
    return { content: JSON.stringify({ cwd: ctx.cwd, files: (await ctx.taskWorkspace.changes()).map(change => change.name) }) };
  },
};
