import { toolOutput } from '../messages.js';
import { isStepCount } from 'ai';
/**
 * Notch CLI — Ralph Wiggum Mode
 *
 * Continuous autonomous loop where the agent works through a task list,
 * restarting with a fresh context window between each task. State lives
 * on disk (plan file + git), not in context.
 *
 * Named after the viral agentic pattern: iteration beats perfection.
 * Each cycle: read plan → pick task → implement → commit → exit → restart.
 *
 * Usage:
 *   notch ralph plan "build a REST API with auth"   — Generate task plan
 *   notch ralph run                                  — Execute tasks autonomously
 *   notch ralph status                               — Show plan progress
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import ora from '../ui/spinner.js';
import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai';
import { buildToolMap, describeToolSchemas, type ToolContext } from '../tools/index.js';
import { buildRepoMap, condensedRepoMap } from '../context/repo-map.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RalphTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  attempts: number;
  error?: string;
  commitHash?: string;
}

export interface RalphPlan {
  goal: string;
  created: string;
  updated: string;
  tasks: RalphTask[];
  completedCount: number;
  totalCount: number;
}

const PLAN_FILE = '.notch-ralph-plan.json';
const MAX_TASK_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Plan Generation
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `You are a senior software architect. Given a high-level goal, break it into discrete, ordered implementation tasks.

Output EXACTLY this JSON format (no markdown, no explanation):
{
  "tasks": [
    {
      "title": "Short task name",
      "description": "Detailed description of what to implement and how",
      "files": ["path/to/file1.ts", "path/to/file2.ts"]
    }
  ]
}

Rules:
- Each task should be completable in one focused session (5-15 min of agent work)
- Order tasks so dependencies come first (create before use)
- Include a testing/verification task at the end
- Be specific about file paths and changes
- 3-12 tasks typical. No more than 15.
- Each task should commit its own changes`;

/**
 * Generate a Ralph plan from a high-level goal.
 */
export async function generateRalphPlan(
  goal: string,
  model: LanguageModel,
  cwd: string,
): Promise<RalphPlan> {
  // Get repo context
  let repoContext = '';
  try {
    const repoMap = await buildRepoMap(cwd);
    repoContext = condensedRepoMap(repoMap, 4000);
  } catch {
    // No repo map available
  }

  const prompt = `Goal: ${goal}\n\nRepository (${cwd}):\n${repoContext || '(empty project)'}`;

  const result = await generateText({
    model,
    instructions: PLAN_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 4096,
  });

  // Parse the JSON response
  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to generate structured plan');
  }

  const parsed = JSON.parse(jsonMatch[0]) as { tasks: Array<{ title: string; description: string; files: string[] }> };

  const plan: RalphPlan = {
    goal,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    tasks: parsed.tasks.map((t, i) => ({
      id: i + 1,
      title: t.title,
      description: t.description,
      files: t.files ?? [],
      status: 'pending',
      attempts: 0,
    })),
    completedCount: 0,
    totalCount: parsed.tasks.length,
  };

  return plan;
}

// ---------------------------------------------------------------------------
// Plan Persistence
// ---------------------------------------------------------------------------

export async function savePlan(plan: RalphPlan, cwd: string): Promise<void> {
  plan.updated = new Date().toISOString();
  plan.completedCount = plan.tasks.filter((t) => t.status === 'done').length;
  await fs.writeFile(path.join(cwd, PLAN_FILE), JSON.stringify(plan, null, 2), 'utf-8');
}

export async function loadPlan(cwd: string): Promise<RalphPlan | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, PLAN_FILE), 'utf-8');
    return JSON.parse(raw) as RalphPlan;
  } catch {
    return null;
  }
}

export async function deletePlan(cwd: string): Promise<void> {
  try {
    await fs.unlink(path.join(cwd, PLAN_FILE));
  } catch {
    // Already gone
  }
}

// ---------------------------------------------------------------------------
// Task Execution (one fresh agent per task)
// ---------------------------------------------------------------------------

/**
 * Execute a single task with a fresh context window.
 * This is the core of Ralph mode — clean slate per task.
 */
export async function executeTask(
  task: RalphTask,
  plan: RalphPlan,
  model: LanguageModel,
  toolContext: ToolContext,
  callbacks: {
    onStatus?: (msg: string) => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string, isError: boolean) => void;
    onText?: (chunk: string) => void;
  },
): Promise<{ success: boolean; error?: string; text: string }> {
  const tools = buildToolMap(toolContext);
  const maxIter = 20;

  // Build a focused system prompt for this specific task
  let repoContext = '';
  try {
    const repoMap = await buildRepoMap(toolContext.cwd);
    repoContext = condensedRepoMap(repoMap, 3000);
  } catch {
    // Skip
  }

  const systemPrompt = `You are Notch, an AI coding agent executing a specific task from a plan.

## Your Task
Task ${task.id}/${plan.totalCount}: ${task.title}

${task.description}

${task.files.length > 0 ? `Target files: ${task.files.join(', ')}` : ''}

## Full Plan Context
Goal: ${plan.goal}
Completed: ${plan.completedCount}/${plan.totalCount} tasks

Previous tasks (already done):
${plan.tasks.filter((t) => t.status === 'done').map((t) => `  ✓ ${t.title}`).join('\n') || '  (none yet)'}

## Working Directory
${toolContext.cwd}

## Repository
${repoContext}

${describeToolSchemas(toolContext)}

## Instructions
1. Read relevant files to understand the current state
2. Implement the changes described in your task
3. Verify your changes work (run tests if applicable)
4. Commit your changes with a descriptive message
5. Respond with a brief summary of what you did

Be focused. Only implement what this task requires. Do not scope-creep into other tasks.`;

  // Fresh message history — THIS IS THE KEY INNOVATION
  // No prior conversation, no accumulated context, clean slate
  const messages: ModelMessage[] = [
    { role: 'user', content: `Execute task ${task.id}: ${task.title}\n\n${task.description}` },
  ];

  let iterations = 0;
  let totalText = '';

  try {
    while (iterations < maxIter) {
      iterations++;

      const result = streamText({
        onError() {}, // The stream consumer reports the failure; avoid dumping raw provider requests.
        model,
        abortSignal: toolContext.abortSignal,
        instructions: systemPrompt,
        messages,
        tools,
        stopWhen: isStepCount(1),
      });

      let fullText = '';
      const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> = [];

      for await (const event of result.stream) {
        if (event.type === 'error') throw event.error instanceof Error ? event.error : new Error(String(event.error));

        if (event.type === 'text-delta') {
          fullText += event.text;
          callbacks.onText?.(event.text);
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.input as Record<string, unknown>,
          });
          callbacks.onToolCall?.(event.toolName, event.input as Record<string, unknown>);
        }
        const evt = event as Record<string, unknown>;
        if (evt.type === 'tool-result' || evt.type === 'tool-error') {
          const output = evt.type === 'tool-error' ? { content: evt.error instanceof Error ? evt.error.message : String(evt.error), isError: true } : evt.output;
          const res = output as { content: string; isError?: boolean } | undefined;
          toolResults.push({
            toolCallId: evt.toolCallId as string,
            toolName: toolCalls.find((tc) => tc.toolCallId === evt.toolCallId)?.toolName ?? 'unknown',
            result: output,
          });
          callbacks.onToolResult?.(
            toolCalls.find((tc) => tc.toolCallId === evt.toolCallId)?.toolName ?? 'unknown',
            res?.content ?? String(output),
            res?.isError ?? false,
          );
        }
      }

      toolContext.abortSignal?.throwIfAborted();
      if (toolCalls.length > 0) {
        messages.push(...(await result.responseMessages).filter(message => message.role === 'assistant'));
        messages.push({
          role: 'tool',
          content: toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: toolOutput(tr.result),
          })),
        });
        continue;
      }

      toolContext.abortSignal?.throwIfAborted();
      // No tool calls — task complete
      return { success: true, text: fullText };
    }

    return { success: false, error: 'Task reached its iteration limit before completion.', text: totalText };
  } catch (err: any) {
    return { success: false, error: err.message, text: totalText };
  }
}

// ---------------------------------------------------------------------------
// The Ralph Loop — orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full Ralph loop: iterate through tasks with fresh context per task.
 */
export async function runRalphLoop(
  plan: RalphPlan,
  model: LanguageModel,
  toolContext: ToolContext,
  cwd: string,
  callbacks: {
    onTaskStart?: (task: RalphTask) => void;
    onTaskEnd?: (task: RalphTask, result: { success: boolean; error?: string }) => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string, isError: boolean) => void;
    onText?: (chunk: string) => void;
    onComplete?: (plan: RalphPlan) => void;
  },
): Promise<RalphPlan> {
  for (const task of plan.tasks) {
    if (task.status === 'done' || task.status === 'skipped') continue;

    task.status = 'in_progress';
    task.attempts++;
    callbacks.onTaskStart?.(task);

    // Save progress before each task
    await savePlan(plan, cwd);

    const result = await executeTask(task, plan, model, toolContext, {
      onToolCall: callbacks.onToolCall,
      onToolResult: callbacks.onToolResult,
      onText: callbacks.onText,
    });

    if (result.success) {
      task.status = 'done';
      callbacks.onTaskEnd?.(task, result);
    } else {
      if (task.attempts >= MAX_TASK_ATTEMPTS) {
        task.status = 'failed';
        task.error = result.error;
        callbacks.onTaskEnd?.(task, result);
        // Continue to next task — don't block the whole plan
      } else {
        task.status = 'pending'; // Will retry on next loop
        task.error = result.error;
        callbacks.onTaskEnd?.(task, result);
      }
    }

    // Save after each task
    await savePlan(plan, cwd);
  }

  callbacks.onComplete?.(plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatRalphStatus(plan: RalphPlan): string {
  const lines: string[] = [];

  const done = plan.tasks.filter((t) => t.status === 'done').length;
  const failed = plan.tasks.filter((t) => t.status === 'failed').length;
  const pending = plan.tasks.filter((t) => t.status === 'pending').length;
  const progress = plan.totalCount > 0 ? Math.round((done / plan.totalCount) * 100) : 0;

  const barWidth = 25;
  const filled = Math.round((done / plan.totalCount) * barWidth);
  const bar = chalk.green('\u2588'.repeat(filled)) + chalk.gray('\u2591'.repeat(barWidth - filled));

  lines.push('');
  lines.push(chalk.bold.white(`  Ralph Mode: ${plan.goal}`));
  lines.push(`  [${bar}] ${progress}% (${done}/${plan.totalCount} tasks)`);
  if (failed > 0) lines.push(chalk.red(`  ${failed} failed`));
  lines.push('');

  for (const task of plan.tasks) {
    const icon = task.status === 'done' ? chalk.green('\u2713')
      : task.status === 'failed' ? chalk.red('\u2717')
      : task.status === 'in_progress' ? chalk.yellow('\u25b6')
      : task.status === 'skipped' ? chalk.gray('\u2013')
      : chalk.gray('\u25cb');

    const title = task.status === 'done'
      ? chalk.gray(task.title)
      : task.status === 'failed'
      ? chalk.red(task.title)
      : chalk.white(task.title);

    const files = task.files.length > 0 ? chalk.cyan(` [${task.files.join(', ')}]`) : '';
    const err = task.error ? chalk.red(` — ${task.error.slice(0, 60)}`) : '';
    const attempts = task.attempts > 1 ? chalk.yellow(` (${task.attempts} attempts)`) : '';

    lines.push(`  ${icon} ${chalk.gray(`${task.id}.`)} ${title}${files}${attempts}${err}`);
  }

  lines.push('');
  return lines.join('\n');
}
