/**
 * Notch CLI — /skill Command
 *
 * Drives the bundled-skill registry:
 *   /skill list                       — list all registered skills
 *   /skill run <id> [args...]         — load the skill (extracts its files
 *                                       on first run), then spawn a general
 *                                       subagent with the skill's prompt
 *                                       (prefixed with the base-dir line)
 *                                       plus any args appended.
 *   /skill show <id>                  — dump the skill's prompt for review
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import ora from '../ui/spinner.js';
import { registerCommand } from './registry.js';
import { listSkills, getSkill, loadSkill, composeSkillPrompt } from '../skills/index.js';
import { spawnSubagent, nextSubagentId } from '../agent/subagent.js';

function printSkillList(): void {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log(chalk.gray('  No skills registered.\n'));
    return;
  }
  console.log(chalk.gray('\n  Bundled skills:\n'));
  const idWidth = Math.max(...skills.map((s) => s.id.length));
  for (const s of skills) {
    const id = chalk.cyan(s.id.padEnd(idWidth));
    const files = s.files ? chalk.gray(` [${Object.keys(s.files).length} file${Object.keys(s.files).length === 1 ? '' : 's'}]`) : '';
    console.log(`    ${id}  ${s.description}${files}`);
  }
  console.log(chalk.gray('\n  Run with:  /skill run <id> [args...]\n'));
}

registerCommand('/skill', async (args, ctx) => {
  const trimmed = args.trim();

  // No args, or `/skill list` — show catalog.
  if (!trimmed || trimmed === 'list') {
    printSkillList();
    return;
  }

  // `/skill show <id>` — print the skill prompt so the user can inspect it
  // before running.
  if (trimmed.startsWith('show ')) {
    const id = trimmed.slice('show '.length).trim();
    const skill = getSkill(id);
    if (!skill) {
      console.log(chalk.red(`  Unknown skill: ${id}\n`));
      return;
    }
    console.log(chalk.cyan(`\n  ${skill.name} (${skill.id})`));
    console.log(chalk.gray(`  ${skill.description}`));
    if (skill.files) {
      console.log(chalk.gray(`  Files: ${Object.keys(skill.files).join(', ')}`));
    }
    console.log(chalk.gray('\n  Prompt:\n'));
    console.log(skill.prompt);
    console.log();
    return;
  }

  // `/skill run <id> [args...]`
  if (trimmed.startsWith('run ')) {
    const rest = trimmed.slice('run '.length).trim();
    if (!rest) {
      console.log(chalk.red('  Usage: /skill run <id> [args...]\n'));
      return;
    }
    const spaceIdx = rest.indexOf(' ');
    const id = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const userArgs = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

    const skill = getSkill(id);
    if (!skill) {
      console.log(chalk.red(`  Unknown skill: ${id}`));
      console.log(chalk.gray('  Run /skill list to see available skills.\n'));
      return;
    }

    const spinner = ora(`Loading skill '${id}'...`).start();
    let loaded;
    try {
      loaded = await loadSkill(id);
    } catch (err: any) {
      spinner.fail(`Failed to load skill: ${err.message}`);
      return;
    }

    const fileCount = loaded.files ? Object.keys(loaded.files).length : 0;
    spinner.succeed(
      fileCount > 0
        ? `Skill '${id}' ready (${fileCount} file${fileCount === 1 ? '' : 's'} at ${loaded.extractDir})`
        : `Skill '${id}' ready`,
    );

    const prompt = composeSkillPrompt(loaded, userArgs);

    // Need the model + toolContext to actually spawn. These come from the
    // REPL context; if we're being dispatched programmatically (no model),
    // fall back to runPrompt on the current conversation instead.
    if (!ctx.model || !ctx.toolContext) {
      console.log(chalk.gray('  (no live model context — running via main agent)\n'));
      const text = await ctx.runPrompt(prompt, [{ role: 'user', content: prompt }]);
      console.log(chalk.white(`\n${text}\n`));
      return;
    }

    const agentId = nextSubagentId('general');
    console.log(chalk.cyan(`\n  Spawning skill-subagent #${agentId} (${skill.name})\n`));

    try {
      const result = await spawnSubagent({
        id: agentId,
        type: 'general',
        prompt,
        model: ctx.model,
        toolContext: ctx.toolContext,
        onStatus: (sid, status) => {
          console.log(chalk.gray(`  [${sid}] ${status}`));
        },
      });

      if (result.error) {
        console.log(chalk.red(`\n  #${agentId} failed: ${result.error}\n`));
        return;
      }

      console.log(chalk.green(`\n  #${agentId} finished (${result.iterations} iter, ${result.toolCalls} tool calls):\n`));
      console.log(result.text);
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`\n  Skill run failed: ${err.message}\n`));
    }
    return;
  }

  // Anything else — print usage.
  console.log(chalk.gray('  Usage:'));
  console.log(chalk.gray('    /skill list              — list bundled skills'));
  console.log(chalk.gray('    /skill show <id>         — print a skill\'s prompt'));
  console.log(chalk.gray('    /skill run <id> [args]   — run a skill as a subagent\n'));
});
