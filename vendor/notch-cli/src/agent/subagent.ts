import { toolOutput } from '../messages.js';
import { isStepCount } from 'ai';
/**
 * Notch CLI — Subagent System
 *
 * Spawns specialized worker agents that run independently for parallel task execution.
 * Modeled after Claude Code's Agent tool — supports explore, plan, and general-purpose types.
 *
 * Each subagent gets its own message history and tool context. The parent
 * can spawn multiple subagents concurrently and collect their results.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { streamText, generateText, type ModelMessage, type LanguageModel } from 'ai';
import { buildToolMap, describeToolSchemas, type ToolContext } from '../tools/index.js';
import { getBuiltinAgent, type BuiltinAgent } from './builtins/index.js';
import { Rollout } from '../session/rollout.js';
import { toolValidationFeedback, missingToolCallFeedback } from './tool-feedback.js';
import { withTaskWorkspace, openRouterTaskContext } from '../concurrency/task-workspace.js';

export type SubagentType = 'explore' | 'plan' | 'general' | 'builtin';

export interface SubagentConfig {
  /** Unique identifier for this subagent */
  id: string;
  /** Type determines system prompt and available tools */
  type: SubagentType;
  /** The task/prompt for the subagent */
  prompt: string;
  /** Model to use (can differ from parent) */
  model: LanguageModel;
  /** Tool context (shared with parent or isolated) */
  toolContext: ToolContext;
  /** Max iterations for this subagent */
  maxIterations?: number;
  /** Callback for status updates */
  onStatus?: (agentId: string, status: string) => void;
  /**
   * If set, the subagent writes an append-only JSONL sidechain transcript
   * at ~/.notch/rollouts/<parentSessionId>.sub.<subagentId>.jsonl so the
   * full trace is recoverable for debugging without inflating the parent
   * session context. Only the final summary is returned to the parent.
   */
  parentSessionId?: string;
}

// ---------------------------------------------------------------------------
// Sidechain rollout — append-only JSONL transcript per subagent, linked to
// the parent session but NOT merged into its context.
// ---------------------------------------------------------------------------

function subagentRolloutId(parentSessionId: string, subagentId: string): string {
  return `${parentSessionId}.sub.${subagentId}`;
}

async function openSubagentRollout(
  parentSessionId: string | undefined,
  subagentId: string,
  kind: string,
  prompt: string,
  model: LanguageModel,
): Promise<Rollout | null> {
  if (!parentSessionId) return null;
  try {
    const id = subagentRolloutId(parentSessionId, subagentId);
    const roll = new Rollout(id);
    await roll.openNew({
      project: `subagent:${kind}:parent=${parentSessionId}`,
      model: (model as unknown as { modelId?: string }).modelId ?? 'unknown',
    });
    // Record the initial prompt verbatim — this is the sole input from the
    // parent, so the transcript is self-contained for debugging.
    await roll.append({
      type: 'user-message',
      msgId: `${subagentId}.u0`,
      payload: { role: 'user', content: prompt },
    });
    return roll;
  } catch {
    // Sidechain writes must never block the subagent — if disk is full or
    // perms are wrong, we drop the transcript rather than fail the agent.
    return null;
  }
}

async function recordSubagentStep(
  roll: Rollout | null,
  subagentId: string,
  iteration: number,
  assistantText: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>,
): Promise<void> {
  if (!roll) return;
  try {
    await roll.append({
      type: 'assistant-message',
      msgId: `${subagentId}.a${iteration}`,
      payload: { text: assistantText, toolCallCount: toolCalls.length },
    });
    for (const tc of toolCalls) {
      await roll.append({
        type: 'tool-call',
        payload: { id: tc.toolCallId, name: tc.toolName, input: tc.args },
      });
    }
    for (const tr of toolResults) {
      await roll.append({
        type: 'tool-result',
        payload: { id: tr.toolCallId, name: tr.toolName, output: toolOutput(tr.result) },
      });
    }
  } catch {
    // Best-effort.
  }
}

async function closeSubagentRollout(
  roll: Rollout | null,
  outcome: 'complete' | 'max-iterations' | 'error',
  finalText: string,
  errorMsg?: string,
): Promise<void> {
  if (!roll) return;
  try {
    if (outcome === 'error') {
      await roll.append({ type: 'error', payload: { message: errorMsg ?? 'unknown' } });
    }
    await roll.append({
      type: 'turn-end',
      payload: { outcome, finalText, ts: new Date().toISOString() },
    });
    await roll.close();
  } catch {
    // Best-effort.
  }
}

export interface SubagentResult {
  id: string;
  type: SubagentType;
  text: string;
  toolCalls: number;
  iterations: number;
  error?: string;
}

const SUBAGENT_PROMPTS: Record<Exclude<SubagentType, 'builtin'>, string> = {
  explore: `You are an exploration agent. Your job is to quickly search and analyze a codebase to answer questions.
You have access to read, grep, and glob tools. Use them efficiently — search broadly first, then narrow down.
Be thorough but concise. Return your findings as a structured summary.
Do NOT modify any files. Only read and search.`,

  plan: `You are a planning agent. Your job is to design implementation strategies.
Analyze the codebase, identify the files that need changes, and produce a step-by-step plan.
Consider edge cases, existing patterns, and potential risks.
Do NOT implement anything. Only plan and recommend.
Output a structured plan with:
1. Summary of approach
2. Files to modify (with specific changes)
3. New files to create (if any)
4. Testing strategy
5. Risks and considerations`,

  general: `You are a general-purpose worker agent. Complete the task assigned to you.
You have full access to all tools. Work autonomously and return results when done.
Be efficient — use grep/glob to find things before reading entire files.
If you encounter errors, try to resolve them yourself before reporting back.`,
};

// Explore agents only get read-only tools
const EXPLORE_TOOL_FILTER = new Set(['read', 'grep', 'glob', 'web_fetch']);
// Plan agents get read-only tools plus git for context
const PLAN_TOOL_FILTER = new Set(['read', 'grep', 'glob', 'git', 'web_fetch']);

let subagentCounter = 0;

async function isolatedWorker(ctx: ToolContext, id: string, run: (ctx: ToolContext) => Promise<SubagentResult>) {
  let delivery: Parameters<NonNullable<ToolContext['onWorkspaceResult']>>[0] | undefined;
  let workerCwd: string | undefined;
  try {
    const result = await withTaskWorkspace({ ...ctx, taskWorkspace: undefined, workspaceCheckpoints: undefined,
      permissionSessionId: `${ctx.permissionSessionId}/${id}`, onWorkspaceResult: value => { delivery = value; } },
    child => { workerCwd = child.cwd; return run(child); });
    if (delivery && !delivery.applied) {
      result.error = `Worker changes need reconciliation: ${delivery.conflicts.join(', ')}. Files are preserved in ${delivery.cwd}.`;
      result.text += '\n' + result.error;
    }
    if (result.error) { await ctx.taskWorkspace?.retainForWorkers(); result.text += `\nUnfinished worker files: ${workerCwd}`; }
    return result;
  } catch (error) { await ctx.taskWorkspace?.retainForWorkers(); throw error; }
}

/**
 * Spawn a subagent that runs to completion and returns its result.
 */
export async function spawnSubagent(config: SubagentConfig): Promise<SubagentResult> {
  config = { ...config, toolContext: openRouterTaskContext(config.toolContext, config.model) };
  if (config.type === 'general' && config.toolContext.isolateTasks?.()) {
    return isolatedWorker(config.toolContext, config.id, toolContext => spawnSubagentInternal({ ...config, toolContext }));
  }
  return spawnSubagentInternal(config);
}

async function spawnSubagentInternal(config: SubagentConfig): Promise<SubagentResult> {
  const { id, type, prompt, model, toolContext, maxIterations = 15 } = config;

  // 'builtin' agents go through spawnBuiltinAgent; reject here defensively so
  // callers that wire type='builtin' into SubagentConfig fail loudly.
  if (type === 'builtin') {
    return {
      id,
      type,
      text: '',
      toolCalls: 0,
      iterations: 0,
      error: 'use spawnBuiltinAgent() for built-in agents, not spawnSubagent()',
    };
  }

  config.onStatus?.(id, `Starting ${type} agent...`);

  // Override permission surface for the subagent so the subagentHandler
  // kicks in — base `prompt` decisions become silent `deny`s with a tail
  // notification, because there is no UI to ask.
  const subagentCtx: ToolContext = {
    ...toolContext,
    permissionSurface: 'subagent',
    subagentId: id,
    requireConfirm: false,
  };

  // Build filtered tool map based on agent type
  const allTools = buildToolMap(subagentCtx);
  const tools: Record<string, any> = {};

  if (type === 'explore') {
    for (const [name, tool] of Object.entries(allTools)) {
      if (EXPLORE_TOOL_FILTER.has(name)) tools[name] = tool;
    }
  } else if (type === 'plan') {
    for (const [name, tool] of Object.entries(allTools)) {
      if (PLAN_TOOL_FILTER.has(name)) tools[name] = tool;
    }
  } else {
    Object.assign(tools, allTools);
  }

  const systemPrompt = `${SUBAGENT_PROMPTS[type]}

## Working Directory
${toolContext.cwd}

${describeToolSchemas(subagentCtx, { includeNames: Object.keys(tools) })}`;

  const messages: ModelMessage[] = [
    { role: 'user', content: prompt },
  ];

  const feedback = toolValidationFeedback(tools);

  let iterations = 0;
  let totalToolCalls = 0;

  const roll = await openSubagentRollout(config.parentSessionId, id, type, prompt, model);

  try {
    // Iterative tool loop (same pattern as main agent loop)
    while (iterations < maxIterations) {
      iterations++;
      config.onStatus?.(id, `Iteration ${iterations}/${maxIterations}...`);

      const result = streamText({
        abortSignal: toolContext.abortSignal,
        model,
        instructions: systemPrompt,
        messages,
        tools: feedback.tools,
        stopWhen: isStepCount(1),
        repairToolCall: feedback.repair,
      });

      let fullText = '';
      const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> = [];

      for await (const event of result.stream) {
        if (event.type === 'error') {
          throw event.error instanceof Error ? event.error : new Error(String(event.error));
        }
        if (event.type === 'text-delta') {
          fullText += event.text;
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.input as Record<string, unknown>,
          });
          config.onStatus?.(id, `${event.toolName}(...)`);
        }
        const evt = event as Record<string, unknown>;
        if (evt.type === 'tool-result' || evt.type === 'tool-error') {
          const output = evt.type === 'tool-error' ? { content: evt.error instanceof Error ? evt.error.message : String(evt.error), isError: true } : evt.output;
          toolResults.push({
            toolCallId: evt.toolCallId as string,
            toolName: toolCalls.find((tc) => tc.toolCallId === evt.toolCallId)?.toolName ?? 'unknown',
            result: output,
          });
        }
      }

      toolContext.abortSignal?.throwIfAborted();
      totalToolCalls += toolCalls.length;

      const missingCall = missingToolCallFeedback(await result.finishReason, toolCalls.length);
      if (missingCall) {
        messages.push({ role: 'user', content: missingCall });
        continue;
      }

      await recordSubagentStep(roll, id, iterations, fullText, toolCalls, toolResults);

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

      // No tool calls — done
      config.onStatus?.(id, 'Complete');
      await closeSubagentRollout(roll, 'complete', fullText);
      return {
        id,
        type,
        text: fullText,
        toolCalls: totalToolCalls,
        iterations,
      };
    }

    // Hit max iterations
    config.onStatus?.(id, 'Max iterations reached');
    await closeSubagentRollout(roll, 'max-iterations', '[Subagent reached max iterations]');
    return {
      id,
      type,
      text: '[Subagent reached max iterations]',
      error: 'Worker reached the iteration limit; its private files were preserved.',
      toolCalls: totalToolCalls,
      iterations,
    };
  } catch (err: any) {
    config.onStatus?.(id, `Error: ${err.message}`);
    await closeSubagentRollout(roll, 'error', '', err.message);
    return {
      id,
      type,
      text: '',
      toolCalls: totalToolCalls,
      iterations,
      error: err.message,
    };
  }
}

/**
 * Spawn multiple subagents in parallel and collect all results.
 */
export async function spawnParallel(configs: SubagentConfig[]): Promise<SubagentResult[]> {
  return Promise.all(configs.map(spawnSubagent));
}

/**
 * Generate a unique subagent ID.
 */
export function nextSubagentId(type: SubagentType): string {
  return `${type}-${++subagentCounter}`;
}

/**
 * Config for a built-in subagent spawn (does not carry type/prompt text for
 * the system prompt — those come from the TOML definition).
 */
export interface BuiltinSpawnConfig {
  /** Name of the built-in agent (must match a TOML file in builtins/). */
  agentName: string;
  /** The task/prompt for the agent to work on. */
  prompt: string;
  /** Model to use. */
  model: LanguageModel;
  /** Tool context (shared with parent or isolated). */
  toolContext: ToolContext;
  /** Optional override for max iterations; defaults to the TOML value. */
  maxIterations?: number;
  /** Optional explicit id; otherwise one is generated. */
  id?: string;
  /** Callback for status updates. */
  onStatus?: (agentId: string, status: string) => void;
  /** If set, write append-only JSONL sidechain transcript. See SubagentConfig. */
  parentSessionId?: string;
}

/**
 * Spawn a built-in subagent by name. Looks up the agent definition from the
 * TOML registry, filters the tool map to the agent's allowed tool names, and
 * runs the standard subagent tool loop with the agent's developer_instructions
 * as the system prompt.
 */
export async function spawnBuiltinAgent(config: BuiltinSpawnConfig): Promise<SubagentResult> {
  config = { ...config, toolContext: openRouterTaskContext(config.toolContext, config.model) };
  if (config.toolContext.isolateTasks?.()) {
    return isolatedWorker(config.toolContext, config.id ?? config.agentName, toolContext => spawnBuiltinAgentInternal({ ...config, toolContext }));
  }
  return spawnBuiltinAgentInternal(config);
}

async function spawnBuiltinAgentInternal(config: BuiltinSpawnConfig): Promise<SubagentResult> {
  const { agentName, prompt, model, toolContext } = config;
  const agent = getBuiltinAgent(agentName);
  const id = config.id ?? `${agentName.toLowerCase()}-${++subagentCounter}`;

  if (!agent) {
    return {
      id,
      type: 'builtin',
      text: '',
      toolCalls: 0,
      iterations: 0,
      error: `unknown built-in agent "${agentName}"`,
    };
  }

  const maxIterations = config.maxIterations ?? agent.maxIterations;
  config.onStatus?.(id, `Starting built-in agent ${agent.name}...`);

  // Override permission surface for the built-in subagent (see spawnSubagent
  // for rationale — no interactive UI to prompt).
  const subagentCtx: ToolContext = {
    ...toolContext,
    permissionSurface: 'subagent',
    subagentId: id,
    requireConfirm: false,
  };

  // Filter the full tool map down to the agent's allowed tool names.
  const allTools = buildToolMap(subagentCtx);
  const allowed = new Set(agent.tools);
  const tools: Record<string, any> = {};
  for (const [name, t] of Object.entries(allTools)) {
    if (allowed.has(name)) tools[name] = t;
  }

  const systemPrompt = `${agent.prompt}

## Working Directory
${toolContext.cwd}

${describeToolSchemas(subagentCtx, { includeNames: Object.keys(tools) })}`;

  const messages: ModelMessage[] = [{ role: 'user', content: prompt }];

  let iterations = 0;
  let totalToolCalls = 0;

  const roll = await openSubagentRollout(config.parentSessionId, id, `builtin:${agentName}`, prompt, model);

  try {
    while (iterations < maxIterations) {
      iterations++;
      config.onStatus?.(id, `Iteration ${iterations}/${maxIterations}...`);

      const result = streamText({
        model,
        instructions: systemPrompt,
        messages,
        tools,
        abortSignal: toolContext.abortSignal,
        stopWhen: isStepCount(1),
      });

      let fullText = '';
      const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> = [];

      for await (const event of result.stream) {
        if (event.type === 'error') throw event.error instanceof Error ? event.error : new Error(String(event.error));

        if (event.type === 'text-delta') {
          fullText += event.text;
        } else if (event.type === 'tool-call') {
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.input as Record<string, unknown>,
          });
          config.onStatus?.(id, `${event.toolName}(...)`);
        }
        const evt = event as Record<string, unknown>;
        if (evt.type === 'tool-result' || evt.type === 'tool-error') {
          const output = evt.type === 'tool-error' ? { content: evt.error instanceof Error ? evt.error.message : String(evt.error), isError: true } : evt.output;
          toolResults.push({
            toolCallId: evt.toolCallId as string,
            toolName: toolCalls.find((tc) => tc.toolCallId === evt.toolCallId)?.toolName ?? 'unknown',
            result: output,
          });
        }
      }

      toolContext.abortSignal?.throwIfAborted();
      totalToolCalls += toolCalls.length;

      await recordSubagentStep(roll, id, iterations, fullText, toolCalls, toolResults);

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

      config.onStatus?.(id, 'Complete');
      await closeSubagentRollout(roll, 'complete', fullText);
      return {
        id,
        type: 'builtin',
        text: fullText,
        toolCalls: totalToolCalls,
        iterations,
      };
    }

    config.onStatus?.(id, 'Max iterations reached');
    await closeSubagentRollout(roll, 'max-iterations', '[Built-in agent reached max iterations]');
    return {
      id,
      type: 'builtin',
      text: '[Built-in agent reached max iterations]',
      error: 'Worker reached the iteration limit; its private files were preserved.',
      toolCalls: totalToolCalls,
      iterations,
    };
  } catch (err: any) {
    config.onStatus?.(id, `Error: ${err.message}`);
    await closeSubagentRollout(roll, 'error', '', err.message);
    return {
      id,
      type: 'builtin',
      text: '',
      toolCalls: totalToolCalls,
      iterations,
      error: err.message,
    };
  }
}
