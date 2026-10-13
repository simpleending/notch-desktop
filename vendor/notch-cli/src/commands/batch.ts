/**
 * Notch CLI — /batch Command
 *
 * Apply a task across multiple files in parallel.
 * The agent identifies target files, then processes them concurrently.
 *
 * Usage: /batch add JSDoc to all exported functions
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import ora from '../ui/spinner.js';
import { registerCommand } from './registry.js';

/** Concurrency limit for parallel agent calls */
const MAX_CONCURRENT = 3;

/**
 * Run promises with a concurrency limit.
 */
async function pLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  let idx = 0;

  async function runNext(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        const value = await tasks[i]!();
        results[i] = { status: 'fulfilled', value };
      } catch (reason: any) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

registerCommand('/batch', async (args, ctx) => {
  if (!args) {
    console.log(chalk.gray('  Usage: /batch <task description>'));
    console.log(chalk.gray('  Example: /batch add JSDoc to all exported functions'));
    console.log(chalk.gray('  Example: /batch convert var to const in src/**/*.js\n'));
    return;
  }

  const spinner = ora('Identifying target files...').start();

  // Step 1: Ask the model to identify files
  const discoveryPrompt = `I need to apply this change across multiple files: "${args}"

List ONLY the file paths that need this change, one per line. Use the glob and grep tools to find them. Output the final list as a simple newline-separated list of file paths with no other text, wrapped in <files> tags like:

<files>
src/foo.ts
src/bar.ts
</files>`;

  const tempMessages: import('ai').ModelMessage[] = [
    { role: 'user', content: discoveryPrompt },
  ];

  let fileList: string[] = [];
  try {
    const responseText = await ctx.runPrompt(discoveryPrompt, tempMessages);
    spinner.stop();

    // Extract file list from <files> tags
    const match = responseText.match(/<files>\s*([\s\S]*?)\s*<\/files>/);
    if (match) {
      fileList = match[1]!.split('\n').map((f) => f.trim()).filter(Boolean);
    }

    if (fileList.length === 0) {
      console.log(chalk.yellow('  No target files identified.\n'));
      return;
    }
  } catch (err: any) {
    spinner.fail(`Failed to identify files: ${err.message}`);
    return;
  }

  console.log(chalk.gray(`\n  Found ${fileList.length} file(s) to process:\n`));
  for (const f of fileList) {
    console.log(chalk.gray(`    • ${f}`));
  }
  console.log('');

  // Step 2: Process files in parallel
  const batchSpinner = ora(`Processing 0/${fileList.length} files...`).start();
  let completed = 0;

  const tasks = fileList.map((file) => async (): Promise<{ file: string; ok: boolean; error?: string }> => {
    const fileMessages: import('ai').ModelMessage[] = [
      {
        role: 'user',
        content: `Apply this change to the file "${file}": ${args}\n\nRead the file first, then make the change. Only modify this one file.`,
      },
    ];
    try {
      await ctx.runPrompt(fileMessages[0]!.content as string, fileMessages);
      completed++;
      batchSpinner.text = `Processing ${completed}/${fileList.length} files...`;
      return { file, ok: true };
    } catch (err: any) {
      completed++;
      batchSpinner.text = `Processing ${completed}/${fileList.length} files...`;
      return { file, ok: false, error: err.message };
    }
  });

  const results = await pLimit(tasks, MAX_CONCURRENT);
  batchSpinner.stop();

  // Step 3: Report results
  console.log(chalk.gray('\n  Batch Results:\n'));
  let successes = 0;
  let failures = 0;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.ok) {
        console.log(chalk.green(`  ✓ ${r.value.file}`));
        successes++;
      } else {
        console.log(chalk.red(`  ✗ ${r.value.file}: ${r.value.error}`));
        failures++;
      }
    } else {
      console.log(chalk.red(`  ✗ Unknown: ${r.reason?.message ?? 'failed'}`));
      failures++;
    }
  }

  console.log('');
  if (failures === 0) {
    console.log(chalk.green(`  ✓ All ${successes} file(s) processed successfully.\n`));
  } else {
    console.log(chalk.yellow(`  ${successes} succeeded, ${failures} failed.\n`));
  }
});
