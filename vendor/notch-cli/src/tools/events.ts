/**
 * Notch CLI — Events tool
 *
 * Agent-facing access to the event router (see ../events/router.ts).
 * The agent uses this when it wants to explicitly check for out-of-band
 * events queued by background sources (git state changes, GitHub
 * notifications, CI completions, custom webhooks) WITHOUT those events
 * being injected into its conversation context directly.
 *
 * Two subcommands:
 *   - list : peek at pending events, optionally filtered, without acking
 *   - drain: acknowledge (consume) events so they stop appearing
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';
import { getGlobalRouter, type AgentEvent, type EventSeverity } from '../events/router.js';

const parameters = z.object({
  mode: z
    .enum(['list', 'drain'])
    .describe('`list` peeks at pending events. `drain` acknowledges + returns them.'),
  sources: z
    .array(z.string())
    .optional()
    .describe('Only include events from these sources (e.g. ["git", "ci"]).'),
  types: z
    .array(z.string())
    .optional()
    .describe('Only include events of these types (e.g. ["new-commit"]).'),
  min_severity: z
    .enum(['info', 'success', 'warn', 'error'])
    .optional()
    .describe('Only include events at or above this severity.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe('Max number of events to return (1-50, default 20).'),
});

function formatEvent(ev: AgentEvent): string {
  const when = new Date(ev.ts).toISOString();
  const sev = ev.severity.toUpperCase().padEnd(7);
  const title = ev.title.replace(/\n/g, ' ').slice(0, 200);
  const body = ev.payload
    ? ` \u2014 ${JSON.stringify(ev.payload).slice(0, 180)}`
    : '';
  return `[${when}] [${sev}] ${ev.source}/${ev.type}: ${title}${body}`;
}

export const eventsTool: NotchTool<typeof parameters> = {
  name: 'events',
  description:
    'Inspect or consume queued out-of-band events (git state, GitHub notifications, CI, custom webhooks). ' +
    'Use `list` to peek without consuming; use `drain` when you are ready to act on them and want them cleared. ' +
    'Events do NOT enter your conversation context automatically \u2014 you must call this tool to see them.',
  parameters,
  async execute(params): Promise<ToolResult> {
    const router = getGlobalRouter();
    const filter = {
      sources: params.sources,
      types: params.types,
      minSeverity: params.min_severity as EventSeverity | undefined,
    };
    const events = params.mode === 'drain' ? router.drain(filter) : router.pending(filter);
    const limited = events.slice(0, params.limit);

    if (limited.length === 0) {
      const verb = params.mode === 'drain' ? 'drained' : 'pending';
      return { content: `No ${verb} events matching filter.` };
    }

    const header =
      params.mode === 'drain'
        ? `Drained ${limited.length} event(s) (cleared from pending queue):`
        : `${limited.length} pending event(s) (NOT yet acknowledged \u2014 call again with mode=drain to clear):`;

    const body = limited.map(formatEvent).join('\n');
    return { content: `${header}\n${body}` };
  },
};
