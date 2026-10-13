/**
 * Notch CLI — Plan Mode
 *
 * Structured planning before execution. The model generates a step-by-step plan,
 * the user approves/modifies, then Notch executes it. Prevents wasted tool calls
 * on wrong approaches.
 *
 * Modeled after Claude Code's Plan mode — enter with /plan, approve with /execute.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import chalk from 'chalk';
import { estimateTokens } from './compression.js';

export interface PlanStep {
  /** Step number */
  index: number;
  /** What to do */
  action: string;
  /** Files involved */
  files: string[];
  /** Status: pending, in_progress, done, skipped */
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';
}

export interface Plan {
  /** High-level summary */
  summary: string;
  /** Ordered steps */
  steps: PlanStep[];
  /** Risks and considerations */
  risks: string[];
  /** Current step index (-1 = not started) */
  currentStep: number;
  /** Whether the plan has been approved */
  approved: boolean;
}

const PLAN_SYSTEM_PROMPT = `You are a planning assistant. Given a task, produce a structured implementation plan.

Respond in EXACTLY this format (no other text):

SUMMARY: <one sentence summary of the approach>

STEPS:
1. <action description> | FILES: <comma-separated file paths>
2. <action description> | FILES: <comma-separated file paths>
...

RISKS:
- <risk or consideration>
- <risk or consideration>

Rules:
- Be specific about which files to modify and what changes to make
- Order steps logically (read before edit, create before use)
- Include testing steps
- Keep it concise — no more than 10 steps
- Files should be relative paths`;

/**
 * Generate a plan from a user request.
 */
export async function generatePlan(
  request: string,
  model: LanguageModel,
  context: { cwd: string; repoMap?: string; history?: ModelMessage[] },
): Promise<Plan> {
  const messages: ModelMessage[] = [];

  // Include recent history for context
  if (context.history && context.history.length > 0) {
    const recentUser = context.history
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .slice(-3);
    if (recentUser.length > 0) {
      messages.push({
        role: 'user',
        content: `Recent conversation context:\n${recentUser.map((m) => `- ${String(m.content).slice(0, 100)}`).join('\n')}`,
      });
      messages.push({
        role: 'assistant',
        content: 'Understood, I have the conversation context.',
      });
    }
  }

  let prompt = `Task: ${request}\n\nWorking directory: ${context.cwd}`;
  if (context.repoMap) {
    prompt += `\n\nRepository structure:\n${context.repoMap.slice(0, 4000)}`;
  }

  messages.push({ role: 'user', content: prompt });

  const result = await generateText({
    model,
    instructions: PLAN_SYSTEM_PROMPT,
    messages,
    maxOutputTokens: 2048,
  });

  return parsePlan(result.text);
}

/**
 * Parse structured plan text into a Plan object.
 */
function parsePlan(text: string): Plan {
  const summary = text.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() ?? 'Implementation plan';

  const steps: PlanStep[] = [];
  const stepMatches = text.matchAll(/(\d+)\.\s*(.+?)(?:\s*\|\s*FILES:\s*(.+))?$/gm);
  let idx = 0;
  for (const match of stepMatches) {
    const action = match[2]?.trim() ?? '';
    const filesStr = match[3]?.trim() ?? '';
    const files = filesStr ? filesStr.split(',').map((f) => f.trim()).filter(Boolean) : [];
    steps.push({ index: idx++, action, files, status: 'pending' });
  }

  // If no structured steps found, treat each line as a step
  if (steps.length === 0) {
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('SUMMARY') && !l.startsWith('RISKS'));
    for (const line of lines.slice(0, 10)) {
      steps.push({ index: idx++, action: line.trim(), files: [], status: 'pending' });
    }
  }

  const risks: string[] = [];
  const riskSection = text.match(/RISKS:\n([\s\S]*?)(?:\n\n|$)/);
  if (riskSection) {
    const riskLines = riskSection[1]!.split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of riskLines) {
      risks.push(line.replace(/^-\s*/, '').trim());
    }
  }

  return {
    summary,
    steps,
    risks,
    currentStep: -1,
    approved: false,
  };
}

/**
 * Format a plan for terminal display.
 */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold.white(`  Plan: ${plan.summary}`));
  lines.push('');

  for (const step of plan.steps) {
    const icon = step.status === 'done' ? chalk.green('\u2713')
      : step.status === 'in_progress' ? chalk.yellow('\u25b6')
      : step.status === 'failed' ? chalk.red('\u2717')
      : step.status === 'skipped' ? chalk.gray('\u2013')
      : chalk.gray('\u25cb');

    const num = chalk.gray(`${step.index + 1}.`);
    const action = step.status === 'done' ? chalk.gray(step.action) : chalk.white(step.action);
    const files = step.files.length > 0
      ? chalk.cyan(` [${step.files.join(', ')}]`)
      : '';

    lines.push(`  ${icon} ${num} ${action}${files}`);
  }

  if (plan.risks.length > 0) {
    lines.push('');
    lines.push(chalk.yellow('  Risks:'));
    for (const risk of plan.risks) {
      lines.push(chalk.yellow(`    \u26a0 ${risk}`));
    }
  }

  lines.push('');
  if (!plan.approved) {
    lines.push(chalk.gray('  Approve: /plan approve  |  Modify: /plan edit  |  Cancel: /plan cancel'));
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Get the current step's description for the agent to execute.
 */
export function currentStepPrompt(plan: Plan): string | null {
  const step = plan.steps[plan.currentStep];
  if (!step) return null;

  let prompt = `Execute step ${step.index + 1} of the plan: ${step.action}`;
  if (step.files.length > 0) {
    prompt += `\nRelevant files: ${step.files.join(', ')}`;
  }
  prompt += '\n\nComplete this step, then report what you did.';

  return prompt;
}

/**
 * Advance the plan to the next pending step.
 * Returns true if there's a next step, false if plan is complete.
 */
export function advancePlan(plan: Plan): boolean {
  // Mark current step done if it was in progress
  if (plan.currentStep >= 0 && plan.steps[plan.currentStep]?.status === 'in_progress') {
    plan.steps[plan.currentStep]!.status = 'done';
  }

  // Find next pending step
  const next = plan.steps.findIndex((s) => s.status === 'pending');
  if (next === -1) return false;

  plan.currentStep = next;
  plan.steps[next]!.status = 'in_progress';
  return true;
}

/**
 * Check if the plan is fully completed.
 */
export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.every((s) => s.status === 'done' || s.status === 'skipped');
}

// ---------------------------------------------------------------------------
// Fresh-context handoff (Codex Plan Mode pattern)
// ---------------------------------------------------------------------------

/**
 * Build a minimal message history that carries ONLY the plan and the
 * original task forward. Used when the user opts to execute a plan in a
 * fresh context — the chatter from the planning phase is dropped so
 * execution turns start with a clean token budget.
 */
export function buildPlanHandoffMessages(
  plan: Plan,
  originalTask: string,
): ModelMessage[] {
  const summary = formatPlanAsText(plan);
  return [
    { role: 'user', content: `Task: ${originalTask}` },
    {
      role: 'assistant',
      content:
        `Here is the approved implementation plan. I will execute it step by step.\n\n${summary}`,
    },
  ];
}

/**
 * Plain-text plan summary used in handoff and exports (no ANSI escapes).
 */
function formatPlanAsText(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Plan: ${plan.summary}`);
  lines.push('');
  lines.push('Steps:');
  for (const step of plan.steps) {
    const files = step.files.length > 0 ? ` [${step.files.join(', ')}]` : '';
    lines.push(`  ${step.index + 1}. ${step.action}${files}`);
  }
  if (plan.risks.length > 0) {
    lines.push('');
    lines.push('Risks:');
    for (const risk of plan.risks) {
      lines.push(`  - ${risk}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Context-usage preview
// ---------------------------------------------------------------------------

export interface ContextUsage {
  tokensUsed: number;
  contextWindow: number;
  percentUsed: number;
  /** Actionable suggestion: 'fresh' when >= 60% so handoff saves real space. */
  recommendation: 'continue' | 'fresh';
}

/**
 * Snapshot how much context the current conversation is consuming. Used
 * before executing an approved plan so the user can make an informed choice
 * between `/plan approve` (continue in thread) and `/plan approve --fresh`
 * (handoff to a clean context).
 */
export function contextUsagePreview(
  messages: ModelMessage[],
  contextWindow: number,
): ContextUsage {
  const tokensUsed = estimateTokens(messages);
  const percentUsed = contextWindow > 0 ? (tokensUsed / contextWindow) * 100 : 0;
  const recommendation: ContextUsage['recommendation'] = percentUsed >= 60 ? 'fresh' : 'continue';
  return { tokensUsed, contextWindow, percentUsed, recommendation };
}

/**
 * Format a context-usage snapshot for REPL display.
 */
export function formatContextUsage(usage: ContextUsage): string {
  const pct = usage.percentUsed.toFixed(1);
  const barWidth = 20;
  const filled = Math.min(barWidth, Math.round((usage.percentUsed / 100) * barWidth));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
  const color =
    usage.percentUsed >= 80 ? chalk.red
    : usage.percentUsed >= 60 ? chalk.yellow
    : chalk.green;
  const line1 = `  Context: ${color(bar)} ${pct}%  (${usage.tokensUsed.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens)`;
  const tip =
    usage.recommendation === 'fresh'
      ? chalk.yellow('  Tip: context is >= 60% full. Consider /plan approve --fresh to execute in a clean window.')
      : chalk.gray('  /plan approve to continue in this thread, or /plan approve --fresh for a clean execution context.');
  return `${line1}\n${tip}`;
}
