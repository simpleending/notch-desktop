/**
 * Notch CLI — /cloud Command
 *
 * Interact with Notch Cloud from the terminal.
 *
 *   /cloud               — open cloud dashboard in browser
 *   /cloud run <prompt>  — submit a task for the current repo
 *   /cloud list          — list your 10 most recent tasks
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { exec, execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from '../ui/spinner.js';
import { registerCommand } from './registry.js';
import { loadCredentials } from '../auth.js';

const PLATFORM_URL = 'https://freesyntax.dev';

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {});
}

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

function detectRepo(cwd: string): string | null {
  const remote = tryExec('git remote get-url origin', cwd);
  if (!remote) return null;
  // Extract owner/repo from SSH or HTTPS GitHub URLs
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] ?? null : null;
}

registerCommand('/cloud', async (args, ctx) => {
  const sub = args.trim();

  // ── /cloud (no args) ──────────────────────────────────────────────────
  if (!sub || sub === 'open') {
    openBrowser(`${PLATFORM_URL}/cloud`);
    console.log(chalk.cyan(`  Opening Notch Cloud → ${PLATFORM_URL}/cloud\n`));
    return;
  }

  // ── /cloud list ───────────────────────────────────────────────────────
  if (sub === 'list') {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.red('  Not logged in. Run: notch login\n'));
      return;
    }
    const spinner = ora('Fetching tasks…').start();
    try {
      const res = await fetch(`${PLATFORM_URL}/api/cloud/tasks?limit=10`, {
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        spinner.fail(`Request failed: ${res.status} ${res.statusText}`);
        return;
      }
      const data = (await res.json()) as { tasks?: Array<{ id: string; status: string; prompt: string; repo: string; created_at: string }> };
      spinner.stop();
      const tasks = data.tasks ?? [];
      if (tasks.length === 0) {
        console.log(chalk.gray('  No cloud tasks yet.\n'));
        return;
      }
      console.log(chalk.gray(`\n  Recent cloud tasks (${tasks.length}):\n`));
      for (const t of tasks) {
        const statusColor = t.status === 'done' ? chalk.green : t.status === 'error' ? chalk.red : chalk.yellow;
        const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 57) + '…' : t.prompt;
        console.log(`  ${statusColor(t.status.padEnd(10))} ${chalk.cyan(t.id.slice(0, 8))}  ${chalk.gray(t.repo)}  ${prompt}`);
      }
      console.log(chalk.gray(`\n  View at: ${PLATFORM_URL}/cloud\n`));
    } catch (err) {
      spinner.fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // ── /cloud run <prompt> ───────────────────────────────────────────────
  if (sub.startsWith('run ') || sub.startsWith('run\n')) {
    const prompt = sub.slice(4).trim();
    if (!prompt) {
      console.log(chalk.red('  Usage: /cloud run <prompt>\n'));
      return;
    }
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.red('  Not logged in. Run: notch login\n'));
      return;
    }
    const repo = detectRepo(ctx.cwd);
    if (!repo) {
      console.log(chalk.red('  Could not detect a GitHub repo in this directory.\n'));
      console.log(chalk.gray('  Make sure you are in a git repo with a GitHub origin remote.\n'));
      return;
    }
    const baseBranch = tryExec('git rev-parse --abbrev-ref origin/HEAD', ctx.cwd)?.replace('origin/', '')
      ?? tryExec('git symbolic-ref refs/remotes/origin/HEAD', ctx.cwd)?.replace('refs/remotes/origin/', '')
      ?? 'main';

    const spinner = ora(`Submitting cloud task for ${repo}…`).start();
    try {
      const res = await fetch(`${PLATFORM_URL}/api/cloud/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repo, baseBranch, prompt, model: ctx.modelId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        spinner.fail(`Failed to submit task: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
        return;
      }
      const task = (await res.json()) as { id?: string };
      spinner.succeed(chalk.green(`Task submitted!`));
      if (task.id) {
        console.log(chalk.gray(`  ID:   ${task.id}`));
        console.log(chalk.gray(`  View: ${PLATFORM_URL}/cloud/tasks/${task.id}\n`));
        openBrowser(`${PLATFORM_URL}/cloud/tasks/${task.id}`);
      }
    } catch (err) {
      spinner.fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  console.log(chalk.gray('  Usage:\n'));
  console.log(chalk.gray('    /cloud              — open cloud dashboard'));
  console.log(chalk.gray('    /cloud list         — list recent tasks'));
  console.log(chalk.gray('    /cloud run <prompt> — submit a task for this repo\n'));
});
