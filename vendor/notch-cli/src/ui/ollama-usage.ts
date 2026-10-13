/**
 * Notch CLI — Ollama Cloud usage tracker
 *
 * Ollama Cloud's pricing is quota-driven (free / $20 Pro / $100 Max,
 * with 5-hour session and 7-day weekly limits) and the server does NOT
 * return a per-request spend figure. The best we can honestly show the
 * user is the per-session token counter we already collect in
 * UsageTracker, decorated with the model-specific cloud flag.
 *
 * This module wraps UsageTracker so cloud usage is segmented from local
 * / Notch usage. `formatCloudBanner` renders a one-line footer the TUI
 * appends after every turn.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import type { TurnUsage } from '../agent/usage.js';
import { isCloudModel } from '../providers/ollama.js';

export interface CloudTurn extends TurnUsage {
  /** Model id as reported by the config (used to tell cloud vs local apart). */
  modelId: string;
  /** When the turn was recorded — ms since epoch. */
  ts: number;
}

/**
 * Keep a running total of Ollama Cloud token usage for the current REPL
 * session. Separate from the generic UsageTracker so the TUI can render
 * a "cloud" vs "local" split without re-walking the main turn array.
 */
export class OllamaCloudUsageTracker {
  private turns: CloudTurn[] = [];

  /**
   * Record a turn. The tracker auto-filters: only entries whose modelId
   * looks like an Ollama Cloud model are kept. Non-cloud turns are
   * silently ignored so callers can fire this once per turn without
   * conditionals.
   */
  record(turn: CloudTurn): void {
    if (!this.isCloudTurn(turn.modelId)) return;
    this.turns.push(turn);
  }

  private isCloudTurn(modelId: string): boolean {
    if (!modelId) return false;
    if (modelId.startsWith('ollama-cloud:')) return true;
    return isCloudModel(modelId);
  }

  get turnCount(): number {
    return this.turns.length;
  }

  get sessionTotals(): TurnUsage {
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

  /**
   * One-line footer rendered after every turn when the active model is
   * an Ollama Cloud alias. Kept intentionally short — it sits beside
   * the existing UsageTracker.formatLast() output.
   */
  formatFooter(activeModelId: string): string {
    if (!this.isCloudTurn(activeModelId) || this.turnCount === 0) return '';
    const total = this.sessionTotals;
    const totalK = (total.totalTokens / 1000).toFixed(1);
    return chalk.gray(`  [cloud: ${this.turnCount} turns, ${totalK}K tokens]`);
  }

  /**
   * Multi-line breakdown for `/usage cloud` / `/status` style surfaces.
   */
  formatDetail(): string {
    if (this.turnCount === 0) {
      return chalk.gray('  No Ollama Cloud traffic this session.');
    }
    const total = this.sessionTotals;
    return [
      chalk.gray('  Ollama Cloud'),
      chalk.gray(`    turns      ${this.turnCount}`),
      chalk.gray(`    prompt     ${total.promptTokens.toLocaleString()} tokens`),
      chalk.gray(`    completion ${total.completionTokens.toLocaleString()} tokens`),
      chalk.gray(`    total      ${total.totalTokens.toLocaleString()} tokens`),
    ].join('\n');
  }
}
