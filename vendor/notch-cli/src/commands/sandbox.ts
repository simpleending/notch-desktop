/**
 * Notch CLI — /sandbox Command
 *
 * Toggle sandbox mode — restricts tool access to read-only operations.
 * Useful for safe exploration without risk of modifying files.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand, type CommandHandler } from './registry.js';

let sandboxEnabled = false;

export function isSandboxEnabled(): boolean {
  return sandboxEnabled;
}

const toggleDryRun: CommandHandler = async (args, _ctx) => {
  if (args === 'on') {
    sandboxEnabled = true;
  } else if (args === 'off') {
    sandboxEnabled = false;
  } else {
    sandboxEnabled = !sandboxEnabled;
  }

  if (sandboxEnabled) {
    console.log(chalk.yellow('  Dry-run ON — tools that may change state are previewed, including MCP and plugins.'));
    console.log(chalk.gray('  Built-in read, grep, glob, and web-fetch execute. This is not OS isolation.\n'));
  } else {
    console.log(chalk.green('  Dry-run OFF — the active access profile still applies.\n'));
  }
};
registerCommand('/dry-run', toggleDryRun);
registerCommand('/sandbox', toggleDryRun); // Backward-compatible alias.
