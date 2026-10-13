/**
 * Notch CLI — Coordinator Tools
 *
 * Three tools exposed to the top-level agent when coordinator mode is active:
 *   - agent_spawn        — start a worker, return its id immediately
 *   - agent_send_message — continue an existing worker (no-op for one-shot workers)
 *   - agent_stop         — abort a running worker
 *
 * All three tools share the module-scoped registry exported from runtime.ts
 * so the loop's pollPendingAgents() hook can see in-flight completions.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult } from '../tools/types.js';
import {
  spawnSubagent,
  spawnBuiltinAgent,
  nextSubagentId,
  type SubagentResult,
  type SubagentType,
} from '../agent/subagent.js';
import {
  getAgent,
  registerAgent,
  type AgentRegistryEntry,
} from './runtime.js';
import { resolveAgent } from './agent-resolver.js';

// ---------------------------------------------------------------------------
// agent_spawn
// ---------------------------------------------------------------------------

const spawnParameters = z.object({
  subagent_type: z
    .enum(['explore', 'plan', 'general', 'builtin'])
    .describe(
      'Worker profile: explore (read-only recon), plan (planning without edits), general (full tool access), builtin (named TOML-defined agent — provide builtin_name).',
    ),
  prompt: z
    .string()
    .describe(
      'Self-contained spec for the worker. Include purpose, file paths, acceptance criteria, and what to report back. Workers cannot see this conversation.',
    ),
  description: z
    .string()
    .describe(
      'Short human-readable label for this worker, shown in status updates and in <task-notification> summaries.',
    ),
  builtin_name: z
    .string()
    .optional()
    .describe('Required when subagent_type is "builtin" — the name of the TOML-defined built-in agent to run.'),
});

export const agentSpawnTool: NotchTool<typeof spawnParameters> = {
  name: 'agent_spawn',
  description:
    'Spawn a worker agent to execute a delegated task. Returns { agent_id, status: "spawned" } immediately — the worker runs in the background and eventually reports back via a <task-notification> user message. Use subagent_type to pick the worker profile.',
  parameters: spawnParameters,
  async execute(params, ctx): Promise<ToolResult> {
    if (!ctx.coordinatorWorkerModel) {
      return {
        content:
          'agent_spawn is unavailable: coordinator mode is active but no worker model was supplied to the tool context. This is a configuration bug — coordinator mode must set coordinatorWorkerModel.',
        isError: true,
      };
    }

    const { subagent_type, prompt, description, builtin_name } = params;

    if (subagent_type === 'builtin' && !builtin_name) {
      // Use the resolver to suggest a matching specialist so the coordinator
      // can retry with a concrete builtin_name. Doesn't auto-route — that
      // would change behavior silently — just surfaces the hint in the
      // error message.
      const hint = resolveAgent(`${description}\n${prompt}`);
      const suggestion = hint.confident
        ? ` Suggested: builtin_name="${hint.best!.agent.name}" (matched ${hint.best!.reasons.slice(0, 2).join(', ')}).`
        : '';
      return {
        content: `agent_spawn: builtin_name is required when subagent_type is "builtin".${suggestion}`,
        isError: true,
      };
    }

    const agentId =
      subagent_type === 'builtin'
        ? `${(builtin_name ?? 'builtin').toLowerCase()}-${nextSubagentId('general').split('-')[1]}`
        : nextSubagentId(subagent_type);

    const abortController = new AbortController();
    // Build a fresh tool context for the worker — coordinator mode is NOT
    // inherited, so workers get their full tool map.
    const workerCtx = { ...ctx, coordinatorMode: false };

    const completionPromise: Promise<SubagentResult> =
      subagent_type === 'builtin'
        ? spawnBuiltinAgent({
            id: agentId,
            agentName: builtin_name as string,
            prompt,
            model: ctx.coordinatorWorkerModel,
            toolContext: workerCtx,
          })
        : spawnSubagent({
            id: agentId,
            type: subagent_type as Exclude<SubagentType, 'builtin'>,
            prompt,
            model: ctx.coordinatorWorkerModel,
            toolContext: workerCtx,
          });

    // We use a synthetic tool-use id derived from the agent id. The real
    // Vercel AI tool-call id isn't surfaced to execute(), which is fine —
    // the coordinator prompt only uses <tool-use-id> for display, and the
    // authoritative handle is the agent id itself.
    const toolUseId = `spawn-${agentId}`;

    const entry: AgentRegistryEntry = {
      agentId,
      toolUseId,
      description,
      completionPromise,
      abortController,
      status: 'spawned',
      delivered: false,
      startedAt: Date.now(),
    };
    registerAgent(entry);

    // Wire the promise so the registry reflects final state when it settles.
    // Errors thrown by the subagent implementation become a 'failed' status;
    // normal SubagentResult with .error populated is also 'failed'. Kill via
    // abort marks as 'killed'.
    completionPromise
      .then((result) => {
        entry.result = result;
        if (abortController.signal.aborted) {
          entry.status = 'killed';
        } else if (result.error) {
          entry.status = 'failed';
        } else {
          entry.status = 'completed';
        }
      })
      .catch((err: Error) => {
        entry.result = {
          id: agentId,
          type: (subagent_type === 'builtin' ? 'builtin' : subagent_type) as SubagentType,
          text: '',
          toolCalls: 0,
          iterations: 0,
          error: err?.message ?? String(err),
        };
        entry.status = abortController.signal.aborted ? 'killed' : 'failed';
      });

    return {
      content: JSON.stringify({
        agent_id: agentId,
        status: 'spawned',
        description,
        note: 'Worker is running. You will receive a <task-notification> when it finishes.',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// agent_send_message
// ---------------------------------------------------------------------------

const sendMessageParameters = z.object({
  to: z.string().describe('The agent_id returned by agent_spawn.'),
  message: z.string().describe('Follow-up instructions for the worker.'),
});

export const agentSendMessageTool: NotchTool<typeof sendMessageParameters> = {
  name: 'agent_send_message',
  description:
    'Continue an existing worker with a follow-up message. NOTE: Notch workers are currently one-shot — once a worker has finished, this tool cannot resume it. For follow-up work, spawn a fresh worker with a synthesized prompt that includes the previous worker\'s findings.',
  parameters: sendMessageParameters,
  async execute(params, _ctx): Promise<ToolResult> {
    const { to, message: _message } = params;
    const entry = getAgent(to);
    if (!entry) {
      return {
        content: `agent_send_message: no agent with id "${to}" in the registry. Check the agent_id you got back from agent_spawn.`,
        isError: true,
      };
    }

    // Worker already finished — cannot continue (one-shot runtime).
    if (
      entry.status === 'completed' ||
      entry.status === 'failed' ||
      entry.status === 'killed'
    ) {
      return {
        content: JSON.stringify({
          status: 'unsupported',
          agent_id: to,
          agent_status: entry.status,
          reason:
            'Notch workers are one-shot. This agent has already finished and cannot be continued. Spawn a fresh worker with a prompt that carries forward the relevant context from the previous worker\'s result.',
        }),
        isError: true,
      };
    }

    // Worker is still running but we cannot inject messages mid-flight today.
    // Be explicit about the limitation rather than silently queueing something
    // that will never be delivered.
    return {
      content: JSON.stringify({
        status: 'unsupported',
        agent_id: to,
        agent_status: entry.status,
        reason:
          'Notch workers cannot receive mid-flight messages in the current runtime. Wait for the <task-notification> for this worker, then spawn a fresh worker with a synthesized follow-up prompt. Alternatively, call agent_stop and respawn with the corrected instructions.',
      }),
      isError: true,
    };
  },
};

// ---------------------------------------------------------------------------
// agent_stop
// ---------------------------------------------------------------------------

const stopParameters = z.object({
  id: z.string().describe('The agent_id of the worker to stop.'),
});

export const agentStopTool: NotchTool<typeof stopParameters> = {
  name: 'agent_stop',
  description:
    'Abort a running worker. Use when you realize a worker is going in the wrong direction or the user has changed requirements. The worker will still emit a <task-notification> with status="killed".',
  parameters: stopParameters,
  async execute(params, _ctx): Promise<ToolResult> {
    const entry = getAgent(params.id);
    if (!entry) {
      return {
        content: `agent_stop: no agent with id "${params.id}" in the registry.`,
        isError: true,
      };
    }
    if (
      entry.status === 'completed' ||
      entry.status === 'failed' ||
      entry.status === 'killed'
    ) {
      return {
        content: JSON.stringify({
          status: 'already_finished',
          agent_id: params.id,
          agent_status: entry.status,
        }),
      };
    }
    entry.abortController.abort();
    // The subagent runtime does not currently honor AbortController during a
    // model stream — the signal is still raised so callers can observe
    // cancellation intent, and the final status will flip to 'killed' once
    // the worker's promise settles.
    return {
      content: JSON.stringify({
        status: 'abort_signaled',
        agent_id: params.id,
        note: 'Abort signal sent. The worker will finish its current step and then report back with status="killed".',
      }),
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COORDINATOR_TOOLS: ReadonlyArray<NotchTool<any>> = [
  agentSpawnTool,
  agentSendMessageTool,
  agentStopTool,
];

export const COORDINATOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  COORDINATOR_TOOLS.map((t) => t.name),
);

/** Names of tools the coordinator is allowed to call (3 coordinator + 3 recon). */
export const COORDINATOR_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...COORDINATOR_TOOL_NAMES,
  'read',
  'grep',
  'glob',
]);
