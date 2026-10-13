/**
 * Notch CLI — /rewind Command
 *
 * Rewind conversation to a previous checkpoint.
 * Shows a list of turns and lets you jump back to any point.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';

registerCommand('/rewind', async (args, ctx) => {
  if (ctx.messages.length === 0) {
    console.log(chalk.gray('  No conversation to rewind.\n'));
    return;
  }

  // Count user turns
  const userTurns: Array<{ index: number; preview: string }> = [];
  for (let i = 0; i < ctx.messages.length; i++) {
    const msg = ctx.messages[i]!;
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const preview = content.slice(0, 60).replace(/\n/g, ' ');
      userTurns.push({ index: i, preview });
    }
  }

  if (userTurns.length === 0) {
    console.log(chalk.gray('  No turns to rewind to.\n'));
    return;
  }

  // If a turn number is given, rewind to that
  if (args) {
    const turnNum = parseInt(args, 10);
    if (isNaN(turnNum) || turnNum < 1 || turnNum > userTurns.length) {
      console.log(chalk.red(`  Invalid turn number: ${args}`));
      console.log(chalk.gray(`  Valid range: 1-${userTurns.length}\n`));
      return;
    }

    const target = userTurns[turnNum - 1]!;
    // Keep messages up to (but not including) this user message
    const kept = ctx.messages.slice(0, target.index);
    ctx.messages.length = 0;
    ctx.messages.push(...kept);

    console.log(chalk.green(`  ✓ Rewound to before turn ${turnNum}`));
    console.log(chalk.gray(`    "${target.preview}"`));
    console.log(chalk.gray(`    ${ctx.messages.length} messages remaining.\n`));
    return;
  }

  // Show turn list
  console.log(chalk.gray('\n  Conversation turns:\n'));
  for (let i = 0; i < userTurns.length; i++) {
    console.log(chalk.gray(`    ${i + 1}. ${userTurns[i]!.preview}${userTurns[i]!.preview.length >= 60 ? '...' : ''}`));
  }
  console.log(chalk.gray(`\n  Rewind to a turn: /rewind <turn-number>\n`));
});
