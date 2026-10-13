/**
 * Notch CLI — /debug Command
 *
 * Toggle debug logging. Shows internal state: message count, token estimates,
 * tool call details, compression events, MCP connections.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';

let debugEnabled = false;

registerCommand('/debug', async (args, ctx) => {
  if (args === 'off') {
    debugEnabled = false;
    console.log(chalk.gray('  Debug logging disabled.\n'));
    return;
  }

  if (args === 'on' || !args) {
    debugEnabled = !debugEnabled;
    console.log(debugEnabled
      ? chalk.yellow('  Debug logging enabled. Verbose output will be shown.\n')
      : chalk.gray('  Debug logging disabled.\n'));
    return;
  }

  // /debug status — show internal state
  if (args === 'status') {
    console.log(chalk.gray('\n  Debug Status:'));
    console.log(chalk.gray(`    Model: ${ctx.modelId}`));
    console.log(chalk.gray(`    Messages: ${ctx.messages.length}`));
    console.log(chalk.gray(`    CWD: ${ctx.cwd}`));
    console.log(chalk.gray(`    Debug: ${debugEnabled ? 'on' : 'off'}`));
    console.log(chalk.gray(`    Last response: ${ctx.lastResponse ? ctx.lastResponse.length + ' chars' : 'none'}`));

    // Estimate tokens
    const charCount = ctx.messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    console.log(chalk.gray(`    Estimated tokens: ~${Math.round(charCount / 4)}`));
    console.log('');
    return;
  }

  console.log(chalk.gray('  Usage: /debug [on|off|status]\n'));
});
