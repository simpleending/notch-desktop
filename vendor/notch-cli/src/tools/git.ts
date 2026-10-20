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

const PROTECTED = new Set(['main', 'master', 'production', 'release']);

export function forcePushError(args: string[], currentBranch: string): string | null {
  const force = args.some(arg => arg.startsWith('+') || /^--(?:for|mir)/.test(arg) || /^-[^-]*f/.test(arg));
  if (!force) return null;
  const flags = args.filter(arg => arg.startsWith('-'));
  const values = args.filter(arg => !arg.startsWith('-'));
  // Require explicit destinations rather than guessing push.default or remote push mappings.
  if (flags.some(arg => !/^(?:--force(?:-with-lease(?:=.*)?)?|-[fuvq]+|--(?:verbose|quiet|porcelain|set-upstream))$/.test(arg)) || values.length < 2) {
    return 'Blocked: force-push needs an explicit remote and unprotected destination branch.';
  }
  for (const refspec of values.slice(1)) {
    let destination = refspec.replace(/^\+/, '').split(':').at(-1) || '';
    if (destination === 'HEAD') destination = currentBranch;
    destination = destination.replace(/^refs\/heads\//, '');
    if (!destination || destination.includes('*') || PROTECTED.has(destination)) return 'Blocked: cannot force-push to a protected or ambiguous destination branch.';
  }
  return null;
}

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

function changedFiles(porcelain: string): { safe: string[]; secrets: string[] } {
  const entries = porcelain.split('\0').filter(Boolean);
  const safe = new Set<string>();
  const secrets = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const files = [entry.slice(3)];
    if (/[RC]/.test(entry.slice(0, 2))) files.push(entries[++index]!);
    const target = files.some(isSecretPath) ? secrets : safe;
    for (const file of files) target.add(file);
  }
  return { safe: [...safe].filter(file => !secrets.has(file)), secrets: [...secrets] };
}

async function commitAndPush(message: string, ctx: ToolContext): Promise<ToolResult> {
  const clean = message.replace(/\r\n/g, '\n').trim();
  if (!clean || clean.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) {
    return { content: 'Commit and push needs a message of 2,000 characters or fewer.', isError: true, notExecuted: true };
  }
  const run = (args: string[]) => gitExec(ctx.cwd, args, ctx.abortSignal);
  const optional = (args: string[]) => run(args).then(result => result.stdout.trim()).catch(error => { ctx.abortSignal?.throwIfAborted(); return ''; });
  if (await optional(['rev-parse', '--is-inside-work-tree']) !== 'true') return { content: 'This folder is not a Git repository. Initialize Git and connect a remote first.', isError: true, notExecuted: true };
  const branch = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return { content: 'Commit and push needs a branch. This repository is in detached HEAD.', isError: true, notExecuted: true };
  const hasHead = !!await optional(['rev-parse', '--verify', 'HEAD']);
  const { safe, secrets } = changedFiles((await run(['status', '--porcelain', '-z', '--untracked-files=all'])).stdout);
  const upstream = await optional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remotes = (await optional(['remote'])).split(/\r?\n/).filter(Boolean);
  const trackingRemote = await optional(['config', '--get', `branch.${branch}.remote`]);
  const remote = await optional(['config', '--get', `branch.${branch}.pushRemote`]) || await optional(['config', '--get', 'remote.pushDefault']) || trackingRemote || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : '');
  if (!remote || remote === '.' || !remotes.includes(remote)) return { content: 'No push remote is configured. Connect one with git remote add origin <repository-url>, or choose a branch push remote.', isError: true, notExecuted: true };
  const destination = remote === trackingRemote ? (await optional(['config', '--get', `branch.${branch}.merge`]) || `refs/heads/${branch}`) : `refs/heads/${branch}`;
  const remoteUrl = await optional(['remote', 'get-url', '--push', '--all', remote]);
  const ahead = upstream ? Number((await optional(['rev-list', '--count', '@{upstream}..HEAD'])) || 0) : hasHead ? 1 : 0;
  if (!safe.length && ahead < 1) return { content: secrets.length ? `Nothing safe to commit. Left unstaged: ${secrets.join(', ')}.` : 'Nothing to commit or push.', isError: secrets.length > 0, notExecuted: true };
  if (!await ctx.confirm([
    `Commit and push ${branch} to ${remote}/${destination.replace(/^refs\/heads\//, '')}?`,
    `Remote: ${remoteUrl.replace(/(https?:\/\/)[^/@]+@/g, '$1')}`,
    safe.length ? `Commit: ${clean.split('\n')[0]}` : 'Push existing local commits.',
    safe.length ? `Files: ${safe.join(', ')}` : '',
    secrets.length ? `Left unstaged: ${secrets.join(', ')}` : '',
  ].filter(Boolean).join('\n'))) return { content: 'Commit and push cancelled.', isError: true, notExecuted: true };
  ctx.abortSignal?.throwIfAborted();
  if (safe.length) {
    if (secrets.length) await run(['--literal-pathspecs', ...(hasHead ? ['reset', '-q', '--', ...secrets] : ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...secrets])]);
    await run(['--literal-pathspecs', 'add', '-A', '--', ...safe]);
    const stagedSecrets = changedFiles((await run(['status', '--porcelain', '-z', '--untracked-files=all'])).stdout).secrets;
    if (stagedSecrets.length) await run(['--literal-pathspecs', ...(hasHead ? ['reset', '-q', '--', ...stagedSecrets] : ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...stagedSecrets])]);
    if ((await run(['diff', '--cached', '--name-only', '-z'])).stdout) {
      try { await run(['commit', '-m', clean]); }
      catch (error) {
        const text = (error as Error).message;
        if (/user\.(name|email)|tell me who you are/i.test(text)) return { content: 'Commit needs a Git name and email. Set git config user.name and git config user.email, then ask again.', isError: true };
        return { content: `Commit failed:\n${text}`, isError: true };
      }
    }
  }
  try {
    const push = await run(['push', '-u', remote, `HEAD:${destination}`]);
    const sha = (await run(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    return { content: [`Committed and pushed ${branch} (${sha}).`, secrets.length ? `Left unstaged: ${secrets.join(', ')}.` : '', [push.stdout, push.stderr].filter(Boolean).join('\n').trim()].filter(Boolean).join('\n') };
  } catch (error) {
    const sha = await optional(['rev-parse', '--short', 'HEAD']);
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
          const blocked = forcePushError(args, currentBranch);
          if (blocked) return { content: blocked, isError: true, notExecuted: true };

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
