/**
 * Notch CLI — /microcompact Command
 *
 * Manually run microcompact on the current session's message history.
 * Reports how many old tool-result payloads were cleared and roughly
 * how many characters that saved. Useful when you want to shrink
 * context NOW without waiting for the auto-run at the next iteration.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk from 'chalk';
import { registerCommand } from './registry.js';
import { microcompact } from '../agent/microcompact.js';
import { estimateTokens } from '../agent/compression.js';

registerCommand('/microcompact', async (args, ctx) => {
  // Parse optional args: "/microcompact keep=6 threshold=50"
  const opts: { keepLastN?: number; threshold?: number } = {};
  for (const tok of args.split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split('=');
    if (k === 'keep' && v) opts.keepLastN = Math.max(0, Number(v) || 0);
    if (k === 'threshold' && v) opts.threshold = Math.max(0, Number(v) || 0);
  }

  const before = ctx.messages.length;
  const beforeTokens = estimateTokens(ctx.messages);

  const result = microcompact(ctx.messages, opts);

  // Replace messages in place so the host session picks up the trimmed history.
  ctx.messages.splice(0, ctx.messages.length, ...result.messages);

  const afterTokens = estimateTokens(ctx.messages);
  const tokensSaved = Math.max(0, beforeTokens - afterTokens);

  if (result.cleared === 0) {
    ctx.log(
      chalk.gray(
        `  Microcompact: nothing to clear (${before} messages, threshold=${opts.threshold ?? 50}, keepLastN=${opts.keepLastN ?? 6}).\n`,
      ),
    );
    return;
  }

  ctx.log(
    [
      chalk.green(`  Microcompact: cleared ${result.cleared} old tool result${result.cleared === 1 ? '' : 's'}`),
      chalk.gray(
        `    chars saved: ~${result.savedChars.toLocaleString()}  |  tokens saved: ~${tokensSaved.toLocaleString()}  (${beforeTokens.toLocaleString()} -> ${afterTokens.toLocaleString()})`,
      ),
      '',
    ].join('\n'),
  );
});
