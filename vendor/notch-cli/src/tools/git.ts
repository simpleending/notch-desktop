/**
 * Notch CLI — Git Tool
 *
 * Dedicated git operations with safety guardrails.
 * Blocks force-push to main/master, uses --force-with-lease, etc.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';

const PROTECTED_BRANCHES = ['main', 'master', 'production', 'release'];

const parameters = z.object({
  operation: z.enum([
    'status', 'diff', 'log', 'commit', 'branch', 'checkout',
    'push', 'pull', 'stash', 'add', 'show',
  ]).describe('Git operation to perform'),
  args: z.string().optional().describe('Additional arguments (e.g., branch name, commit message, file paths)'),
});

export const gitTool: NotchTool<typeof parameters> = {
  name: 'git',
  description:
    'Perform git operations with built-in safety. Always prefer this over shell for git commands. ' +
    'Blocks force-push to protected branches. Operations: status, diff, log, commit, branch, ' +
    'checkout, push, pull, stash, add, show.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const git: SimpleGit = simpleGit(ctx.cwd);

    try {
      switch (params.operation) {
        case 'status': {
          const status = await git.status();
          const lines = [
            `Branch: ${status.current}`,
            `Ahead: ${status.ahead} Behind: ${status.behind}`,
            status.staged.length ? `Staged: ${status.staged.join(', ')}` : null,
            status.modified.length ? `Modified: ${status.modified.join(', ')}` : null,
            status.not_added.length ? `Untracked: ${status.not_added.join(', ')}` : null,
            status.deleted.length ? `Deleted: ${status.deleted.join(', ')}` : null,
          ].filter(Boolean);
          return { content: lines.join('\n') };
        }

        case 'diff': {
          const diff = await git.diff(params.args?.split(' ') ?? []);
          return { content: diff || '(no changes)' };
        }

        case 'log': {
          const log = await git.log({ maxCount: 10, ...(params.args ? {} : {}) });
          const entries = log.all.map(
            (c) => `${c.hash.slice(0, 8)} ${c.date} ${c.message}`
          );
          return { content: entries.join('\n') || '(no commits)' };
        }

        case 'commit': {
          if (!params.args) {
            return { content: 'Commit requires a message. Use args: "your commit message"', isError: true };
          }
          const result = await git.commit(params.args);
          return {
            content: `Committed: ${result.commit} (${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions)`,
          };
        }

        case 'add': {
          const files = params.args?.split(' ') ?? ['.'];
          // Warn about potentially sensitive files
          const sensitive = files.filter(
            (f) => /\.(env|pem|key|credentials|secret)/i.test(f)
          );
          if (sensitive.length > 0) {
            const confirmed = await ctx.confirm(
              `⚠ Staging potentially sensitive files: ${sensitive.join(', ')}\nProceed?`
            );
            if (!confirmed) {
              return { content: 'Staging cancelled.', isError: true };
            }
          }
          await git.add(files);
          return { content: `Staged: ${files.join(', ')}` };
        }

        case 'branch': {
          if (params.args) {
            await git.branch(params.args.split(' '));
            return { content: `Branch operation completed: ${params.args}` };
          }
          const branches = await git.branch();
          return { content: branches.all.map((b) => `${b === branches.current ? '* ' : '  '}${b}`).join('\n') };
        }

        case 'checkout': {
          if (!params.args) {
            return { content: 'Checkout requires a branch or file path.', isError: true };
          }
          await git.checkout(params.args.split(' '));
          return { content: `Checked out: ${params.args}` };
        }

        case 'push': {
          const currentBranch = (await git.status()).current ?? '';
          const args = params.args?.split(' ') ?? [];
          const isForce = args.includes('--force') || args.includes('-f');

          if (isForce && PROTECTED_BRANCHES.includes(currentBranch)) {
            return {
              content: `Blocked: cannot force-push to protected branch "${currentBranch}". Use --force-with-lease instead.`,
              isError: true,
            };
          }

          await git.push(args);
          return { content: `Pushed ${currentBranch} successfully` };
        }

        case 'pull': {
          const pullResult = await git.pull(params.args?.split(' '));
          return {
            content: `Pulled: ${pullResult.summary.changes} changes, ${pullResult.summary.insertions} insertions, ${pullResult.summary.deletions} deletions`,
          };
        }

        case 'stash': {
          if (params.args === 'pop') {
            await git.stash(['pop']);
            return { content: 'Stash popped' };
          }
          if (params.args === 'list') {
            const list = await git.stashList();
            return { content: list.all.map((s) => `${s.hash} ${s.message}`).join('\n') || '(no stashes)' };
          }
          await git.stash(params.args?.split(' '));
          return { content: 'Changes stashed' };
        }

        case 'show': {
          const raw = await git.show(params.args?.split(' ') ?? []);
          return { content: raw };
        }

        default:
          return { content: `Unknown git operation: ${params.operation}`, isError: true };
      }
    } catch (err: any) {
      return { content: `Git error: ${err.message}`, isError: true };
    }
  },
};
