/**
 * Notch CLI — Context Window Meter
 *
 * Visual bar showing how much of the context window is used.
 * Theme-aware colors.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { theme } from './themes.js';

/**
 * Render a context window usage bar.
 *
 * Example output:
 *   Context: [████████░░░░░░░░░░░░] 42% (54K / 128K tokens)
 */
export function renderContextMeter(
  usedTokens: number,
  maxTokens: number,
  width: number = 30,
): string {
  const t = theme();
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const percent = Math.round(ratio * 100);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  // Color based on usage thresholds
  const barColor = ratio < 0.5 ? t.meterLow : ratio < 0.75 ? t.meterMid : t.meterHigh;

  const bar = barColor('\u2588'.repeat(filled)) + t.border('\u2591'.repeat(empty));
  const used = formatTokens(usedTokens);
  const max = formatTokens(maxTokens);

  return `  Context: [${bar}] ${percent}% (${used} / ${max} tokens)`;
}

/**
 * Compact context indicator for the prompt line.
 * Returns something like "[42%]" colored by usage.
 */
export function compactContextIndicator(usedTokens: number, maxTokens: number): string {
  const t = theme();
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const percent = Math.round(ratio * 100);

  if (ratio < 0.5) return t.meterLow(`[${percent}%]`);
  if (ratio < 0.75) return t.meterMid(`[${percent}%]`);
  return t.meterHigh(`[${percent}%]`);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
