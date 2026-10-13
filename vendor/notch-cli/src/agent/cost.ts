/**
 * Notch CLI — Cost Tracking
 *
 * Estimates API costs based on token usage and model pricing.
 * Displays per-turn and session costs.
 *
 * Note on vision calls: when a turn includes image content blocks, the
 * provider tokenises each image into a handful of "image tokens" (rate varies
 * 1.5–3× per-model, and depends on image dimensions). We do NOT attempt to
 * estimate image-token counts locally — we trust whatever `usage` the
 * provider reports. Costs shown for image-bearing turns are therefore
 * approximate, but match what the upstream will actually bill.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import type { NotchModelId } from '../providers/types.js';

// Cost per 1M tokens (USD, before tier overhead) — matches notchTransparentPricing.ts
const MODEL_COSTS: Record<NotchModelId, { input: number; output: number }> = {
  'notch-pyre':       { input: 4.34, output: 15.42 },   // A100-80GB (benchmarked 2026-04-02)
  'notch-ignis':      { input: 2.86, output: 25.70 },   // A100-80GB (benchmarked 2026-04-02)
  'notch-solace':     { input: 4.63, output: 36.15 },   // A100-80GB (benchmarked 2026-04-06)
  'notch-solace-lite':{ input: 1.11, output: 10.28 },   // L4 (benchmarked 2026-04-05)
};

export interface CostEntry {
  /** Notch id for catalog-priced turns; BYOK ref (e.g. "openrouter:...") otherwise. */
  model: NotchModelId | string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  /**
   * Record a turn's token usage.
   *
   * Pricing rules:
   *   - Exact Notch-catalog match     -> use that row's rates.
   *   - Unknown `notch-*` id (forward compat for in-flight releases)
   *                                   -> fall back to Pyre rates (matches pre-BYOK behaviour).
   *   - BYOK ref (contains `:`) or
   *     any other unknown string      -> cost is 0; we can't price
   *     arbitrary upstreams and a fake number would be misleading.
   *     Raw token counts are still tracked for session summaries.
   */
  record(model: NotchModelId | string, promptTokens: number, completionTokens: number): CostEntry {
    let rates: { input: number; output: number } | null = null;
    if (model in MODEL_COSTS) {
      rates = MODEL_COSTS[model as NotchModelId];
    } else if (typeof model === 'string' && model.startsWith('notch-') && !model.includes(':')) {
      rates = MODEL_COSTS['notch-pyre'];
    }
    const cost = rates
      ? (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output
      : 0;

    const entry: CostEntry = { model, promptTokens, completionTokens, cost };
    this.entries.push(entry);
    return entry;
  }

  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost, 0);
  }

  get totalTokens(): { prompt: number; completion: number } {
    return this.entries.reduce(
      (acc, e) => ({
        prompt: acc.prompt + e.promptTokens,
        completion: acc.completion + e.completionTokens,
      }),
      { prompt: 0, completion: 0 },
    );
  }

  formatLastCost(): string {
    const last = this.entries[this.entries.length - 1];
    if (!last) return '';
    return chalk.gray(`$${last.cost.toFixed(4)}`);
  }

  formatSession(): string {
    if (this.entries.length === 0) return chalk.gray('  No cost data.');

    const total = this.totalCost;
    const tokens = this.totalTokens;

    return [
      chalk.gray(`\n  Session cost estimate:`),
      chalk.gray(`    Input:      ${tokens.prompt.toLocaleString()} tokens`),
      chalk.gray(`    Output:     ${tokens.completion.toLocaleString()} tokens`),
      chalk.gray(`    Est. cost:  `) + chalk.white(`$${total.toFixed(4)}`),
      chalk.gray(`    (${this.entries.length} turns)`),
    ].join('\n');
  }

  /** Alias for formatSession */
  formatTotal(): string {
    return this.formatSession();
  }

  /** Breakdown cost by model */
  formatByModel(): string {
    if (this.entries.length === 0) return '';

    const byModel = new Map<string, { prompt: number; completion: number; cost: number; turns: number }>();
    for (const e of this.entries) {
      const existing = byModel.get(e.model) ?? { prompt: 0, completion: 0, cost: 0, turns: 0 };
      existing.prompt += e.promptTokens;
      existing.completion += e.completionTokens;
      existing.cost += e.cost;
      existing.turns += 1;
      byModel.set(e.model, existing);
    }

    const lines = [chalk.gray('\n  Cost by model:')];
    for (const [modelId, data] of byModel) {
      lines.push(
        chalk.gray(`    ${modelId.padEnd(14)} ${data.turns} turns  `) +
        chalk.white(`$${data.cost.toFixed(4)}`) +
        chalk.gray(` (${(data.prompt + data.completion).toLocaleString()} tokens)`)
      );
    }
    return lines.join('\n');
  }
}

/**
 * Format model cost rates for display.
 */
export function formatCostRates(): string {
  const lines = [chalk.gray('\n  Model cost estimates (per 1M tokens):\n')];

  for (const [id, rates] of Object.entries(MODEL_COSTS)) {
    lines.push(
      chalk.gray(`    ${id.padEnd(14)}  in: $${rates.input.toFixed(2)}  out: $${rates.output.toFixed(2)}`)
    );
  }
  lines.push('');

  return lines.join('\n');
}
