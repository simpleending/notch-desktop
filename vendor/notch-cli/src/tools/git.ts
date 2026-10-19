/**
 * Notch CLI — Git Tool
 *
 * Dedicated git operations with safety guardrails.
 * Blocks force-push to main/master, uses --force-with-lease, etc.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFile } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { z } from 'zod';
import type { NotchTool, ToolResult, ToolContext } from './types.js';

const PROTECTED_BRANCHES = ['main', 'master', 'production', 'release'];
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|credentials(?:\.json)?$|[^/]+\.(?:pem|p12|pfx|key)$|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$)/i;

const parameters = z.object({
  operation: z.enum([
    'status', 'diff', 'log', 'commit', 'branch', 'checkout',
    'push', 'pull', 'stash', 'add', 'show', 'commit_and_push',
  ]).describe('Git operation to perform'),
  args: z.string().optional().describe('For commit_and_push, the commit message. For other operations, extra arguments such as a branch name or file path.'),
});

export function isSecretPath(file: string): boolean {
  return SECRET_PATH.test(file.replaceAll('\\', '/'));
}

function gitExec(cwd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stderr?: string };
        failure.message = [stderr, failure.message].filter(Boolean).join('\n');
        reject(failure);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function changedFiles(porcelain: string): string[] {
  const parts = porcelain.split('\0').filter(entry => entry.length > 0);
  const files: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push(parts[index + 1] || file);
      index += 1;
    } else files.push(file);
  }
  return [...new Set(files.filter(Boolean))];
}

async function commitAndPush(message: string, ctx: ToolContext): Promise<ToolResult> {
  const clean = message.replace(/\r\n/g, '\n').trim();
  if (!clean || clean.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) {
    return { content: 'Commit and push needs a message of 2,000 characters or fewer.', isError: true, notExecuted: true };
  }
  let inside = '';
  try { inside = (await gitExec(ctx.cwd, ['rev-parse', '--is-inside-work-tree'], ctx.abortSignal)).stdout.trim(); }
  catch { return { content: 'This folder is not a Git repository.', isError: true, notExecuted: true }; }
  if (inside !== 'true') return { content: 'This folder is not a Git repository.', isError: true, notExecuted: true };
  const branch = (await gitExec(ctx.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.abortSignal)).stdout.trim();
  if (!branch || branch === 'HEAD') return { content: 'Commit and push needs a branch. This repository is in detached HEAD.', isError: true, notExecuted: true };
  const changes = changedFiles((await gitExec(ctx.cwd, ['status', '--porcelain', '-z'], ctx.abortSignal)).stdout);
  const secrets = changes.filter(isSecretPath);
  const safe = changes.filter(file => !isSecretPath(file));
  let upstream = '';
  let ahead = 0;
  try {
    upstream = (await gitExec(ctx.cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], ctx.abortSignal)).stdout.trim();
    const counts = (await gitExec(ctx.cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], ctx.abortSignal)).stdout.trim().split(/\s+/);
    ahead = Number(counts[1] || 0);
  } catch { upstream = ''; }
  if (!safe.length && ahead < 1) {
    return { content: secrets.length ? `Nothing safe to commit. Left unstaged: ${secrets.join(', ')}.` : 'Nothing to commit or push.', isError: secrets.length > 0, notExecuted: true };
  }
  const confirmed = await ctx.confirm([
    `Commit and push ${branch}${upstream ? ` to ${upstream}` : ' to origin'}?`,
    safe.length ? `Commit: ${clean.split('\n')[0]}` : `Push ${ahead} existing commit${ahead === 1 ? '' : 's'}.`,
    safe.length ? `Files: ${safe.join(', ')}` : '',
    secrets.length ? `Left unstaged: ${secrets.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
  if (!confirmed) return { content: 'Commit and push cancelled.', isError: true, notExecuted: true };
  if (safe.length) {
    await gitExec(ctx.cwd, ['add', '-A'], ctx.abortSignal);
    if (secrets.length) await gitExec(ctx.cwd, ['reset', '-q', '--', ...secrets], ctx.abortSignal);
    try { await gitExec(ctx.cwd, ['commit', '-m', clean], ctx.abortSignal); }
    catch (error) {
      const text = (error as Error).message;
      if (/user\.(name|email)|tell me who you are/i.test(text)) return { content: 'Commit needs a Git name and email on this computer. Set them with git config user.name and git config user.email, then ask again.', isError: true };
      return { content: `Commit failed:\n${text}`, isError: true };
    }
  }
  try {
    const push = upstream
      ? await gitExec(ctx.cwd, ['push'], ctx.abortSignal)
      : await gitExec(ctx.cwd, ['push', '-u', 'origin', 'HEAD'], ctx.abortSignal);
    const sha = (await gitExec(ctx.cwd, ['rev-parse', '--short', 'HEAD'], ctx.abortSignal)).stdout.trim();
    return { content: [`Committed and pushed ${branch} (${sha}).`, secrets.length ? `Left unstaged: ${secrets.join(', ')}.` : '', [push.stdout, push.stderr].filter(Boolean).join('\n').trim()].filter(Boolean).join('\n') };
  } catch (error) {
    const sha = await gitExec(ctx.cwd, ['rev-parse', '--short', 'HEAD'], ctx.abortSignal).then(result => result.stdout.trim()).catch(() => '');
    return { content: `Commit ${sha || 'created'} is local. Push failed:\n${(error as Error).message}`, isError: true };
  }
}

export const gitTool: NotchTool<typeof parameters> = {
  name: 'git',
  description:
    'Perform git operations with built-in safety. Always prefer this over shell for git commands. ' +
    'When the user asks to commit, push, or commit and push, use commit_and_push and put the commit message in args. ' +
    'That stages the open folder, leaves secret files unstaged, asks before publishing, and pushes the current branch without force. ' +
    'Blocks force-push to protected branches. Operations: status, diff, log, commit, commit_and_push, branch, ' +
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

        case 'commit_and_push':
          return await commitAndPush(params.args ?? '', ctx);

        default:
          return { content: `Unknown git operation: ${params.operation}`, isError: true };
      }
    } catch (err: any) {
      return { content: `Git error: ${err.message}`, isError: true };
    }
  },
};
