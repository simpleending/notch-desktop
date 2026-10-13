/**
 * Notch CLI — Token Usage Tracking
 *
 * Tracks token consumption across the session for cost awareness.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  iterations: number;
}

export class UsageTracker {
  private turns: TurnUsage[] = [];

  record(usage: TurnUsage): void {
    this.turns.push(usage);
  }

  get sessionTotal(): TurnUsage {
    return this.turns.reduce(
      (acc, t) => ({
        promptTokens: acc.promptTokens + t.promptTokens,
        completionTokens: acc.completionTokens + t.completionTokens,
        totalTokens: acc.totalTokens + t.totalTokens,
        toolCalls: acc.toolCalls + t.toolCalls,
        iterations: acc.iterations + t.iterations,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCalls: 0, iterations: 0 },
    );
  }

  get turnCount(): number {
    return this.turns.length;
  }

  formatLast(): string {
    const last = this.turns[this.turns.length - 1];
    if (!last) return '';
    const t = last.totalTokens;
    const label = t > 10_000 ? chalk.yellow(`${(t / 1000).toFixed(1)}K`) : chalk.gray(`${t}`);
    return chalk.gray(`  [${label} tokens, ${last.toolCalls} tool calls, ${last.iterations} rounds]`);
  }

  formatSession(): string {
    const total = this.sessionTotal;
    return [
      chalk.gray(`\n  Session usage (${this.turnCount} turns):`),
      chalk.gray(`    Prompt:     ${total.promptTokens.toLocaleString()} tokens`),
      chalk.gray(`    Completion: ${total.completionTokens.toLocaleString()} tokens`),
      chalk.gray(`    Total:      ${total.totalTokens.toLocaleString()} tokens`),
      chalk.gray(`    Tool calls: ${total.toolCalls}`),
    ].join('\n');
  }
}
