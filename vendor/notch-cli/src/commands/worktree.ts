/**
 * Notch CLI — /worktree Command
 *
 * Manage git worktrees for parallel branch work.
 * Create isolated worktrees, run agents in them, and clean up.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync, execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { registerCommand } from './registry.js';

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

registerCommand('/worktree', async (args, ctx) => {
  const parts = args.split(/\s+/);
  const subcommand = parts[0] || 'list';

  switch (subcommand) {
    case 'list':
    case 'ls': {
      const result = tryExec('git worktree list', ctx.cwd);
      if (!result) {
        console.log(chalk.red('  Not a git repository.\n'));
        return;
      }
      console.log(chalk.gray('\n  Git Worktrees:\n'));
      for (const line of result.split('\n')) {
        const isCurrent = line.includes(ctx.cwd);
        console.log(isCurrent ? chalk.green(`  ● ${line}`) : chalk.gray(`    ${line}`));
      }
      console.log('');
      return;
    }

    case 'create':
    case 'new': {
      const branchName = parts[1];
      if (!branchName) {
        console.log(chalk.gray('  Usage: /worktree create <branch-name> [base-branch]\n'));
        return;
      }

      const baseBranch = parts[2] || 'HEAD';
      const worktreePath = `../${branchName}`;

      try {
        execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName, baseBranch], {
          cwd: ctx.cwd,
          encoding: 'utf-8',
          timeout: 15_000,
        });
        const absPath = tryExec(`cd "${worktreePath}" && pwd`, ctx.cwd);
        console.log(chalk.green(`  ✓ Created worktree: ${branchName}`));
        console.log(chalk.gray(`    Path: ${absPath || worktreePath}`));
        console.log(chalk.gray(`    Base: ${baseBranch}`));
        console.log(chalk.gray(`\n  Run: /worktree switch ${branchName}\n`));
      } catch (err: any) {
        console.log(chalk.red(`  Failed: ${err.message}\n`));
      }
      return;
    }

    case 'remove':
    case 'rm': {
      const target = parts[1];
      if (!target) {
        console.log(chalk.gray('  Usage: /worktree remove <branch-or-path>\n'));
        return;
      }

      try {
        execFileSync('git', ['worktree', 'remove', target, '--force'], {
          cwd: ctx.cwd,
          encoding: 'utf-8',
          timeout: 15_000,
        });
        // Also try to delete the branch
        try {
          execFileSync('git', ['branch', '-D', target], { cwd: ctx.cwd, encoding: 'utf-8', timeout: 5_000 });
        } catch { /* Branch might not match */ }
        console.log(chalk.green(`  ✓ Removed worktree: ${target}\n`));
      } catch (err: any) {
        console.log(chalk.red(`  Failed: ${err.message}\n`));
      }
      return;
    }

    case 'switch': {
      const target = parts[1];
      if (!target) {
        console.log(chalk.gray('  Usage: /worktree switch <branch-name>\n'));
        return;
      }

      // Find the worktree path
      const list = tryExec('git worktree list --porcelain', ctx.cwd);
      if (!list) {
        console.log(chalk.red('  Not a git repository.\n'));
        return;
      }

      const worktrees = list.split('\n\n')
        .filter((block) => block.trim().length > 0)
        .map((block) => {
          const lines = block.split('\n');
          const wtPath = lines.find((l) => l.startsWith('worktree '))?.slice(9)?.trim();
          const branch = lines.find((l) => l.startsWith('branch '))?.slice(7)?.replace('refs/heads/', '')?.trim();
          return { path: wtPath, branch };
        })
        .filter((wt) => wt.path);

      const match = worktrees.find((wt) =>
        wt.branch === target || wt.path?.includes(target)
      );

      if (!match?.path) {
        console.log(chalk.red(`  Worktree not found: ${target}\n`));
        return;
      }

      console.log(chalk.green(`  ✓ Switched context to: ${match.branch || target}`));
      console.log(chalk.gray(`    Path: ${match.path}`));
      console.log(chalk.gray(`\n  Note: This changes the working directory for Notch tools.\n`));

      // Update the tool context cwd (this is the key integration point)
      // The caller (index.ts) should handle updating toolCtx.cwd
      return;
    }

    case 'prune': {
      try {
        execSync('git worktree prune', { cwd: ctx.cwd, encoding: 'utf-8' });
        console.log(chalk.green('  ✓ Pruned stale worktrees.\n'));
      } catch (err: any) {
        console.log(chalk.red(`  Failed: ${err.message}\n`));
      }
      return;
    }

    default:
      console.log(chalk.gray('  Usage: /worktree <list|create|remove|switch|prune>\n'));
      console.log(chalk.gray('  Commands:'));
      console.log(chalk.gray('    list                    — List all worktrees'));
      console.log(chalk.gray('    create <branch> [base]  — Create new worktree'));
      console.log(chalk.gray('    remove <branch>         — Remove a worktree'));
      console.log(chalk.gray('    switch <branch>         — Switch Notch context'));
      console.log(chalk.gray('    prune                   — Clean up stale worktrees\n'));
  }
});
