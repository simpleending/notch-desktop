/**
 * Notch CLI — /commit Command
 *
 * Generates a smart commit message from staged/unstaged changes
 * and creates the commit. Uses the model to analyze the diff.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execFileSync, execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from '../ui/spinner.js';
import { registerCommand } from './registry.js';

/** Safe git commit — uses execFileSync with args array to prevent injection */
function gitCommit(message: string, cwd: string): void {
  execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

registerCommand('/commit', async (args, ctx) => {
  // Check for changes
  let diff: string;
  let stat: string;

  try {
    // Stage all if nothing is staged
    const staged = execFileSync('git', ['diff', '--cached', '--stat'], { cwd: ctx.cwd, encoding: 'utf-8' }).trim();
    if (!staged) {
      execFileSync('git', ['add', '-A'], { cwd: ctx.cwd, encoding: 'utf-8' });
    }

    stat = execFileSync('git', ['diff', '--cached', '--stat'], { cwd: ctx.cwd, encoding: 'utf-8' }).trim();
    diff = execFileSync('git', ['diff', '--cached'], { cwd: ctx.cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }).trim();
  } catch (err: any) {
    console.log(chalk.red(`  Git error: ${err.message}\n`));
    return;
  }

  if (!diff) {
    console.log(chalk.gray('  No changes to commit.\n'));
    return;
  }

  console.log(chalk.gray(`\n  Staged changes:\n  ${stat}\n`));

  // User provided message directly
  if (args) {
    try {
      gitCommit(args, ctx.cwd);
      console.log(chalk.green(`  ✓ Committed: ${args}\n`));
    } catch (err: any) {
      console.log(chalk.red(`  Commit failed: ${err.message}\n`));
    }
    return;
  }

  // Generate message using model
  const spinner = ora('Generating commit message...').start();

  const truncatedDiff = diff.length > 30_000
    ? diff.slice(0, 30_000) + '\n... (truncated)'
    : diff;

  const prompt = `Generate a concise git commit message for these changes. Follow conventional commit format (feat:, fix:, refactor:, docs:, chore:, etc.). Keep the first line under 72 characters. Add a blank line then a brief body if needed.

Changes:
${stat}

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Reply with ONLY the commit message, nothing else. No markdown, no explanation.`;

  const tempMessages: import('ai').ModelMessage[] = [
    { role: 'user', content: prompt },
  ];

  try {
    const message = await ctx.runPrompt(prompt, tempMessages);
    spinner.stop();

    // Clean up the message
    const cleanMessage = message
      .replace(/^```\n?/gm, '')
      .replace(/\n?```$/gm, '')
      .replace(/^["'`]/g, '')
      .replace(/["'`]$/g, '')
      .trim();

    console.log(chalk.white(`\n  ${cleanMessage.split('\n')[0]}\n`));
    if (cleanMessage.includes('\n')) {
      const body = cleanMessage.split('\n').slice(1).join('\n').trim();
      if (body) console.log(chalk.gray(`  ${body}\n`));
    }

    // Ask for confirmation
    const rl = await import('node:readline');
    const confirm = rl.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      confirm.question(chalk.yellow('  Commit with this message? [Y/n/e(dit)] '), resolve);
    });
    confirm.close();

    const choice = answer.trim().toLowerCase();

    if (choice === 'n' || choice === 'no') {
      console.log(chalk.gray('  Commit cancelled.\n'));
      return;
    }

    let finalMessage = cleanMessage;
    if (choice === 'e' || choice === 'edit') {
      const editRl = rl.createInterface({ input: process.stdin, output: process.stdout });
      finalMessage = await new Promise<string>((resolve) => {
        editRl.question(chalk.gray('  Enter commit message: '), resolve);
      });
      editRl.close();
      if (!finalMessage.trim()) {
        console.log(chalk.gray('  Commit cancelled.\n'));
        return;
      }
    }

    // Commit — safe against injection via execFileSync args array
    try {
      gitCommit(finalMessage, ctx.cwd);
      console.log(chalk.green(`  ✓ Committed: ${finalMessage.split('\n')[0]}\n`));
    } catch (err: any) {
      console.log(chalk.red(`  Commit failed: ${err.message}\n`));
    }
  } catch (err: any) {
    spinner.fail(`Failed: ${err.message}`);
  }
});
