/**
 * Notch CLI — /btw Command
 *
 * Ask a side question without polluting the main conversation context.
 * The question and response are discarded after display.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';

registerCommand('/btw', async (args, ctx) => {
  if (!args) {
    console.log(chalk.gray('  Usage: /btw <question>\n'));
    return;
  }

  console.log(chalk.gray('  (Side question — won\'t affect main conversation)\n'));

  // Run in an isolated message array — results are NOT merged back
  const tempMessages: import('ai').ModelMessage[] = [
    { role: 'user', content: args },
  ];

  try {
    await ctx.runPrompt(args, tempMessages);
    console.log(chalk.gray('\n  (Side question complete — context unchanged)\n'));
  } catch (err: any) {
    console.log(chalk.red(`  Side question failed: ${err.message}\n`));
  }
});
