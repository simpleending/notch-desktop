/**
 * Notch CLI — /agents-md Command
 *
 * Prints the AGENTS.md hierarchy that Notch currently loads into the system
 * prompt. Useful for verifying what guidance the agent is actually seeing,
 * and which file wins on precedence.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import path from 'node:path';
import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { loadAgentsMdHierarchy, type AgentsMdSection } from '../context/agents-md.js';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

registerCommand('/agents-md', async (_args, ctx) => {
  let sections: AgentsMdSection[];
  try {
    sections = await loadAgentsMdHierarchy(ctx.cwd);
  } catch (err) {
    ctx.log(chalk.red(`Failed to load AGENTS.md hierarchy: ${(err as Error).message}`));
    return;
  }

  if (sections.length === 0) {
    ctx.log(
      chalk.gray(
        'No AGENTS.md files found in scope. Drop one into the project root to get started — ' +
          'see https://agents.md for the convention.',
      ),
    );
    return;
  }

  ctx.log(chalk.bold(`AGENTS.md hierarchy (${sections.length} file${sections.length === 1 ? '' : 's'}):`));
  ctx.log(chalk.gray('Listed from least specific to most specific. The LAST entry wins on conflict.\n'));

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    const rel = path.relative(ctx.cwd, s.path) || s.path;
    const tag =
      i === sections.length - 1
        ? chalk.green('[winner]')
        : i === 0 && sections.length > 1
          ? chalk.dim('[base]')
          : chalk.dim(`[${i + 1}/${sections.length}]`);
    ctx.log(`  ${tag} ${chalk.cyan(rel)} ${chalk.gray(`(${formatBytes(s.size)}, depth ${s.depth})`)}`);
  }
});
