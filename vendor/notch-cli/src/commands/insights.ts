/**
 * Notch CLI — /insights Command
 *
 * Generate session analytics: token usage breakdown, tool usage patterns,
 * time per turn, most-touched files, and efficiency metrics.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';

registerCommand('/insights', async (_args, ctx) => {
  if (ctx.messages.length === 0) {
    console.log(chalk.gray('  No conversation data to analyze.\n'));
    return;
  }

  // Analyze messages
  let userMsgs = 0;
  let assistantMsgs = 0;
  let toolCalls = 0;
  const toolUsage = new Map<string, number>();
  const filesReferenced = new Set<string>();
  let totalChars = 0;

  for (const msg of ctx.messages) {
    if (msg.role === 'user') {
      userMsgs++;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      totalChars += content.length;
    } else if (msg.role === 'assistant') {
      assistantMsgs++;
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'object' && 'type' in part && part.type === 'tool-call') {
            toolCalls++;
            const name = (part as any).toolName || 'unknown';
            toolUsage.set(name, (toolUsage.get(name) || 0) + 1);

            // Track files from tool args
            const args = (part as any).args;
            if (args?.path) filesReferenced.add(String(args.path));
            if (args?.file) filesReferenced.add(String(args.file));
          }
        }
      }
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      totalChars += content.length;
    }
  }

  const estimatedTokens = Math.round(totalChars / 4);

  console.log(chalk.gray('\n  ═══ Session Insights ═══\n'));

  // Overview
  console.log(chalk.gray('  Conversation:'));
  console.log(chalk.gray(`    ${userMsgs} user turns, ${assistantMsgs} assistant responses`));
  console.log(chalk.gray(`    ${ctx.messages.length} total messages`));
  console.log(chalk.gray(`    ~${estimatedTokens.toLocaleString()} tokens estimated`));
  console.log('');

  // Tool usage
  if (toolCalls > 0) {
    console.log(chalk.gray('  Tool Usage:'));
    const sorted = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      const bar = '█'.repeat(Math.min(count, 20));
      console.log(chalk.gray(`    ${name.padEnd(14)} ${chalk.cyan(bar)} ${count}`));
    }
    console.log(chalk.gray(`    ${'Total'.padEnd(14)} ${toolCalls} calls`));
    console.log('');
  }

  // Files touched
  if (filesReferenced.size > 0) {
    console.log(chalk.gray('  Files Referenced:'));
    const files = [...filesReferenced].slice(0, 15);
    for (const f of files) {
      console.log(chalk.gray(`    • ${f}`));
    }
    if (filesReferenced.size > 15) {
      console.log(chalk.gray(`    ... and ${filesReferenced.size - 15} more`));
    }
    console.log('');
  }

  // Efficiency
  const avgToolsPerTurn = userMsgs > 0 ? (toolCalls / userMsgs).toFixed(1) : '0';
  console.log(chalk.gray('  Efficiency:'));
  console.log(chalk.gray(`    Avg tools per turn: ${avgToolsPerTurn}`));
  console.log(chalk.gray(`    Files per session: ${filesReferenced.size}`));
  console.log(chalk.gray(`    Tool diversity: ${toolUsage.size} unique tools used`));
  console.log('');
});
