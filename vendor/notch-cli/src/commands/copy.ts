/**
 * Notch CLI — /copy Command
 *
 * Copies the last assistant response to the system clipboard.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { registerCommand } from './registry.js';

function copyToClipboard(text: string): boolean {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      execSync('clip.exe', { input: text, timeout: 5000 });
    } else if (platform === 'darwin') {
      execSync('pbcopy', { input: text, timeout: 5000 });
    } else {
      // Linux — try xclip, then xsel, then wl-copy (Wayland)
      try {
        execSync('xclip -selection clipboard', { input: text, timeout: 5000 });
      } catch {
        try {
          execSync('xsel --clipboard --input', { input: text, timeout: 5000 });
        } catch {
          execSync('wl-copy', { input: text, timeout: 5000 });
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

registerCommand('/copy', async (_args, ctx) => {
  if (!ctx.lastResponse) {
    console.log(chalk.gray('  Nothing to copy yet.\n'));
    return;
  }

  if (copyToClipboard(ctx.lastResponse)) {
    const preview = ctx.lastResponse.slice(0, 60).replace(/\n/g, ' ');
    console.log(chalk.green(`  ✓ Copied to clipboard`) + chalk.gray(` (${ctx.lastResponse.length} chars)`));
    console.log(chalk.gray(`    "${preview}${ctx.lastResponse.length > 60 ? '...' : ''}"\n`));
  } else {
    console.log(chalk.red('  Clipboard not available.'));
    console.log(chalk.gray('  Install xclip (Linux) or ensure clip.exe/pbcopy is available.\n'));
  }
});
