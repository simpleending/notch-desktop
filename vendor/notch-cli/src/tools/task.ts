/**
 * Notch CLI — Task Management Tool
 *
 * Lets the agent create, update, and track tasks within a session.
 * Tasks are displayed to the user and help organize complex multi-step work.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import chalk from 'chalk';
import type { NotchTool, ToolResult } from './types.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  id: number;
  subject: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

/** Global task store — persists for the session */
const tasks: Task[] = [];
let nextId = 1;

const parameters = z.object({
  action: z.enum(['create', 'update', 'list', 'get'])
    .describe('Action: create (new task), update (change status/subject), list (show all), get (show one)'),
  subject: z.string().optional().describe('Task title — for create action'),
  description: z.string().optional().describe('Task details — for create action'),
  task_id: z.number().int().positive().optional().describe('Task ID — for update/get actions'),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional()
    .describe('New status — for update action'),
});

function formatTask(t: Task): string {
  const icons: Record<TaskStatus, string> = {
    pending: '○',
    in_progress: '◐',
    completed: '●',
    failed: '✗',
  };
  const colors: Record<TaskStatus, (s: string) => string> = {
    pending: chalk.gray,
    in_progress: chalk.yellow,
    completed: chalk.green,
    failed: chalk.red,
  };
  return `${colors[t.status](icons[t.status])} #${t.id} ${colors[t.status](t.subject)} [${t.status}]`;
}

function formatTaskList(): string {
  if (tasks.length === 0) return 'No tasks.';
  return tasks.map(formatTask).join('\n');
}

export const taskTool: NotchTool<typeof parameters> = {
  name: 'task',
  description:
    'Manage tasks within the current session. Use this to break complex work into tracked steps. ' +
    'Actions: create (new task), update (change status), list (show all tasks), get (show one task). ' +
    'Mark tasks as in_progress when starting and completed when done.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    switch (params.action) {
      case 'create': {
        if (!params.subject) {
          return { content: 'subject is required for create action.', isError: true };
        }
        const task: Task = {
          id: nextId++,
          subject: params.subject,
          description: params.description,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tasks.push(task);
        // Print to terminal
        ctx.log(formatTask(task));
        return { content: `Task #${task.id} created: ${task.subject}` };
      }

      case 'update': {
        if (params.task_id === undefined) {
          return { content: 'task_id is required for update action.', isError: true };
        }
        const task = tasks.find((t) => t.id === params.task_id);
        if (!task) {
          return { content: `Task #${params.task_id} not found.`, isError: true };
        }
        if (params.status) task.status = params.status;
        if (params.subject) task.subject = params.subject;
        task.updatedAt = Date.now();
        ctx.log(formatTask(task));
        return { content: `Task #${task.id} updated: ${task.subject} [${task.status}]` };
      }

      case 'list': {
        const output = formatTaskList();
        return { content: output };
      }

      case 'get': {
        if (params.task_id === undefined) {
          return { content: 'task_id is required for get action.', isError: true };
        }
        const task = tasks.find((t) => t.id === params.task_id);
        if (!task) {
          return { content: `Task #${params.task_id} not found.`, isError: true };
        }
        const details = [
          formatTask(task),
          task.description ? `  ${task.description}` : '',
          `  Created: ${new Date(task.createdAt).toLocaleTimeString()}`,
          `  Updated: ${new Date(task.updatedAt).toLocaleTimeString()}`,
        ].filter(Boolean).join('\n');
        return { content: details };
      }

      default:
        return { content: `Unknown action: ${params.action}`, isError: true };
    }
  },
};

/** Get all tasks (for /tasks command) */
export function getAllTasks(): Task[] {
  return [...tasks];
}

/** Format task list for display (for /tasks command) */
export function formatTasksDisplay(): string {
  return formatTaskList();
}
