/**
 * Notch CLI — /agents Command
 *
 * Lists and spawns built-in scholar-themed subagents loaded from TOML
 * specs under src/agent/builtins/.
 *
 *   /agents                        — list all built-in agents
 *   /agents <name> <prompt...>     — spawn a built-in agent with a prompt
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { listBuiltinAgents, getBuiltinAgent } from '../agent/builtins/index.js';
import { spawnBuiltinAgent } from '../agent/subagent.js';

function printAgentList(): void {
  const agents = listBuiltinAgents();
  if (agents.length === 0) {
    console.log(chalk.yellow('  No built-in agents registered.\n'));
    return;
  }
  const pad = Math.max(...agents.map((a) => a.name.length));
  console.log(chalk.gray(`\n  Built-in agents (${agents.length}):\n`));
  for (const a of agents) {
    const tools = a.tools.join(', ');
    console.log(
      `  ${chalk.cyan(a.name.padEnd(pad))}  ${chalk.gray(a.description)}`,
    );
    console.log(
      `  ${' '.repeat(pad)}  ${chalk.gray(`tools: ${tools}  |  max_iters: ${a.maxIterations}`)}`,
    );
  }
  console.log(chalk.gray('\n  Usage: /agents <name> <prompt>\n'));
}

registerCommand('/agents', async (args, ctx) => {
  const trimmed = args.trim();

  // No args → list
  if (!trimmed) {
    printAgentList();
    return;
  }

  // Parse "<name> <prompt...>"
  const firstSpace = trimmed.indexOf(' ');
  const name = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const prompt = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  const agent = getBuiltinAgent(name);
  if (!agent) {
    console.log(chalk.red(`  Unknown built-in agent: "${name}"\n`));
    console.log(chalk.gray('  Run /agents to see available agents.\n'));
    return;
  }

  if (!prompt) {
    console.log(chalk.gray(`\n  ${chalk.cyan(agent.name)} — ${agent.description}`));
    console.log(chalk.gray(`  tools: ${agent.tools.join(', ')}`));
    console.log(chalk.gray(`  max_iterations: ${agent.maxIterations}`));
    console.log(chalk.gray('\n  Usage: /agents ' + agent.name + ' <prompt>\n'));
    return;
  }

  if (!ctx.model || !ctx.toolContext) {
    console.log(
      chalk.red('  /agents requires an active model and tool context (run from an interactive session).\n'),
    );
    return;
  }

  console.log(
    chalk.cyan(`\n  Spawning ${agent.name} — ${agent.description}\n`),
  );

  const result = await spawnBuiltinAgent({
    agentName: agent.name,
    prompt,
    model: ctx.model,
    toolContext: ctx.toolContext,
    onStatus: (id, status) => {
      console.log(chalk.gray(`    [${id}] ${status}`));
    },
  });

  if (result.error) {
    console.log(chalk.red(`\n  ${agent.name} failed: ${result.error}\n`));
    return;
  }

  console.log(
    chalk.green(
      `\n  ${agent.name} finished — ${result.iterations} iteration(s), ${result.toolCalls} tool call(s).\n`,
    ),
  );
  if (result.text) {
    console.log(result.text + '\n');
  }
});
