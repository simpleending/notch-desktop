/**
 * Notch CLI — /rename Command
 *
 * Name the current session for easy identification and resumption.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';

/** Session name storage — set here, used by session save */
let sessionName = '';

export function getSessionName(): string {
  return sessionName;
}

registerCommand('/rename', async (args, _ctx) => {
  if (!args) {
    if (sessionName) {
      console.log(chalk.gray(`  Current session name: ${chalk.white(sessionName)}\n`));
    } else {
      console.log(chalk.gray('  Usage: /rename <name>\n'));
    }
    return;
  }

  sessionName = args.trim();
  console.log(chalk.green(`  ✓ Session named: "${sessionName}"\n`));
});
