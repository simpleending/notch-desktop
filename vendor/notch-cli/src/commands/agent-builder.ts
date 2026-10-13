/**
 * Notch CLI — /agent-builder Command
 *
 * Launch and manage Notch agents from the terminal.
 *
 *   /agent-builder              — open agent builder in browser
 *   /agent-builder list         — list your agents
 *   /agent-builder open <id>    — open a specific agent in browser
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { exec } from 'node:child_process';
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

registerCommand('/agent-builder', async (args, _ctx) => {
  const sub = args.trim();

  // ── /agent-builder (no args) ──────────────────────────────────────────
  if (!sub || sub === 'open') {
    openBrowser(`${PLATFORM_URL}/agents/new`);
    console.log(chalk.cyan(`  Opening Agent Builder → ${PLATFORM_URL}/agents/new\n`));
    return;
  }

  // ── /agent-builder list ───────────────────────────────────────────────
  if (sub === 'list') {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.red('  Not logged in. Run: notch login\n'));
      return;
    }
    const spinner = ora('Fetching agents…').start();
    try {
      const res = await fetch(`${PLATFORM_URL}/api/agents/versions`, {
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) {
        spinner.fail(`Request failed: ${res.status} ${res.statusText}`);
        return;
      }
      const data = (await res.json()) as { agents?: Array<{ id: string; name: string; description?: string; deployed?: boolean }> };
      spinner.stop();
      const agents = data.agents ?? [];
      if (agents.length === 0) {
        console.log(chalk.gray('  No agents yet. Run /agent-builder to create one.\n'));
        return;
      }
      console.log(chalk.gray(`\n  Your agents (${agents.length}):\n`));
      const pad = Math.max(...agents.map((a) => (a.name ?? '').length), 4);
      for (const a of agents) {
        const deployed = a.deployed ? chalk.green('live') : chalk.gray('draft');
        const desc = a.description ? chalk.gray(a.description.slice(0, 50)) : '';
        console.log(`  ${chalk.cyan((a.name ?? a.id).padEnd(pad))}  [${deployed}]  ${desc}`);
      }
      console.log(chalk.gray(`\n  Manage at: ${PLATFORM_URL}/agents\n`));
    } catch (err) {
      spinner.fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // ── /agent-builder open <id> ──────────────────────────────────────────
  if (sub.startsWith('open ')) {
    const id = sub.slice(5).trim();
    if (!id) {
      console.log(chalk.red('  Usage: /agent-builder open <agent-id>\n'));
      return;
    }
    const url = `${PLATFORM_URL}/agents/${id}`;
    openBrowser(url);
    console.log(chalk.cyan(`  Opening agent → ${url}\n`));
    return;
  }

  console.log(chalk.gray('  Usage:\n'));
  console.log(chalk.gray('    /agent-builder              — open agent builder'));
  console.log(chalk.gray('    /agent-builder list         — list your agents'));
  console.log(chalk.gray('    /agent-builder open <id>    — open a specific agent\n'));
});
