/**
 * Notch CLI — /tasks Command
 *
 * Display and manage the agent's task list.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { getAllTasks, formatTasksDisplay } from '../tools/task.js';

registerCommand('/tasks', async (_args, _ctx) => {
  const tasks = getAllTasks();
  if (tasks.length === 0) {
    console.log(chalk.gray('  No tasks. The agent will create tasks automatically during complex work.\n'));
    return;
  }

  console.log(chalk.gray('\n  Task List:\n'));
  console.log('  ' + formatTasksDisplay().split('\n').join('\n  '));

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  console.log(chalk.gray(`\n  Progress: ${completed}/${total} (${pct}%)\n`));
});
