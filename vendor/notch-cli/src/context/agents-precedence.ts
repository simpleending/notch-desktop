/**
 * Notch CLI — AGENTS.md Precedence Formatter
 *
 * Pure helper that takes an ordered list of AGENTS.md sections (shallow →
 * deep) and produces the final formatted block for the system prompt.
 *
 * Codex policy, paraphrased into Notch's voice:
 *   "Each AGENTS.md governs the directory that contains it and every child
 *    directory beneath it. When two files disagree, the one closer to the
 *    working directory wins. Direct system / developer / user prompts still
 *    outrank every AGENTS.md."
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { AgentsMdSection } from './agents-md.js';

/** Max size (chars) of the combined formatted block. */
export const DEFAULT_MAX_BLOCK_CHARS = 24 * 1024;

export interface ApplyAgentsPrecedenceOptions {
  /** Hard cap on the combined block size. Defaults to 24KB. */
  maxChars?: number;
  /** If set, rewrite absolute paths relative to this root in headers (for cleaner output). */
  relativeTo?: string;
}

/**
 * Format the AGENTS.md hierarchy into a single Markdown block suitable for
 * injection into the system prompt.
 *
 * - Sections are rendered in input order (shallow → deep) so the model sees
 *   the most-specific guidance LAST, matching the "later wins" convention
 *   used throughout Notch prompts.
 * - If the combined block exceeds `maxChars`, we drop the OLDEST / least
 *   specific sections first (from the front of the array) until it fits.
 *   We never truncate a single section mid-content — we drop it whole, with
 *   a note telling the model it was elided.
 */
export function applyAgentsPrecedence(
  sections: AgentsMdSection[],
  options: ApplyAgentsPrecedenceOptions = {},
): string {
  if (sections.length === 0) return '';

  const maxChars = options.maxChars ?? DEFAULT_MAX_BLOCK_CHARS;
  const relativeTo = options.relativeTo;

  const renderHeader = (p: string): string => {
    if (!relativeTo) return p;
    try {
      // Use Node's path in the caller; here we do a simple prefix strip so
      // this module stays dependency-free.
      if (p.startsWith(relativeTo)) {
        const rest = p.slice(relativeTo.length).replace(/^[\\/]+/, '');
        return rest || p;
      }
    } catch {
      // fall through
    }
    return p;
  };

  const renderSection = (s: AgentsMdSection, idx: number, total: number): string => {
    const precedence =
      total === 1
        ? '(sole AGENTS.md in scope)'
        : idx === total - 1
          ? '(most specific — highest precedence)'
          : idx === 0
            ? '(least specific — lowest precedence)'
            : `(precedence ${idx + 1} of ${total})`;
    return `### ${renderHeader(s.path)} ${precedence}\n\n${s.content}`;
  };

  const preamble =
    '## Project Instructions (AGENTS.md hierarchy)\n' +
    'Each AGENTS.md governs the directory that contains it and every directory beneath it. ' +
    'When two files disagree, the one closer to the working directory wins. ' +
    'Direct instructions from the user or system prompt still outrank every AGENTS.md.\n';

  // Start with everything; drop oldest entries until we fit.
  let included = [...sections];
  let dropped = 0;

  const build = (): string => {
    const body = included.map((s, i) => renderSection(s, i, included.length)).join('\n\n');
    const notice =
      dropped > 0
        ? `\n\n_Note: ${dropped} higher-level AGENTS.md file${dropped === 1 ? '' : 's'} omitted to fit the context budget._`
        : '';
    return `${preamble}${notice}\n\n${body}`;
  };

  let out = build();
  while (out.length > maxChars && included.length > 1) {
    included.shift();
    dropped++;
    out = build();
  }

  // If a single section still exceeds the limit, truncate its body.
  if (out.length > maxChars && included.length === 1) {
    const only = included[0]!;
    const headroom = Math.max(
      512,
      maxChars - preamble.length - 200 /* header + truncation notice slack */,
    );
    const truncated: AgentsMdSection = {
      ...only,
      content:
        only.content.slice(0, headroom) +
        `\n\n… [truncated ${only.content.length - headroom} chars to fit context budget]`,
    };
    included = [truncated];
    out = build();
  }

  return out;
}
