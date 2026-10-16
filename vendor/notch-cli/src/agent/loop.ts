import { toolOutput } from '../messages.js';
import { executionContext } from '../concurrency/local-inference.js';
import { withTaskWorkspace, openRouterTaskContext } from '../concurrency/task-workspace.js';
import { isStepCount, asSchema } from 'ai';
/**
 * Notch CLI — Agent Loop
 *
 * Core agentic loop that drives conversation between the user and the model.
 * Handles tool calls, streaming, multi-turn context, context compression,
 * retry with backoff, and repeated-error detection.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { ToolLoopAgent, type ModelMessage, type LanguageModel, type ToolModelMessage } from 'ai';
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import { buildToolMap, type ToolContext } from '../tools/index.js';
import { autoCompress, estimateTokens } from './compression.js';
import { contextBudget, estimateTextTokens } from './context-budget.js';
import { loadProjectInstructions } from '../context/project-instructions.js';
import { formatMemoriesForPrompt } from '../memory/index.js';
import { listBuiltinAgents } from './builtins/index.js';
import {
  composeSystemPrompt,
  safeSection,
  DANGEROUS_uncachedSystemPromptSection,
  type PromptSection,
} from './prompt-sections.js';
import { fenceUntrustedContext } from './untrusted-context.js';
import { microcompact } from './microcompact.js';
import { pollPendingAgents } from '../coordinator/runtime.js';
import {
  type CorrectionConfig,
  looksLikeFailedToolCall,
  extractToolCallsFromText,
  extractTemplateToolCalls,
  correctionPass,
  intentGate,
  autoDetectPreset,
} from './correction.js';
import { recordShadowUsage } from '../providers/pi-ai-adapter.js';
import { toolValidationFeedback, missingToolCallFeedback } from './tool-feedback.js';

export interface AgentConfig {
  model: LanguageModel;
  systemPrompt: string;
  toolContext: ToolContext;
  /** Maximum tool-call rounds before forcing a text response */
  maxIterations?: number;
  /** Context window size for compression decisions */
  contextWindow?: number;
  maxOutputTokens?: number;
  onCompact?: (messages: ModelMessage[]) => Promise<void>;
  /** Correction pipeline config — auto-detected from model ID if omitted */
  correction?: CorrectionConfig;
  /** Model ID string for auto-detecting correction preset */
  modelId?: string;
  /** Callback for each streamed text chunk */
  onTextChunk?: (chunk: string) => void;
  /** Callback when a tool is invoked */
  onToolCall?: (name: string, args: Record<string, unknown>, toolCallId?: string) => void;
  /** Callback when a tool returns a result */
  onToolResult?: (name: string, result: string, isError: boolean, toolCallId?: string) => void;
  /** Callback when context is compressed */
  onCompress?: () => void;
  /** Callback when microcompact clears old tool results. `cleared` = results cleared. */
  onMicrocompact?: (cleared: number, savedChars: number) => void;
  /** Callback when the correction pipeline fires */
  onCorrection?: (attempt: number, success: boolean) => void;
  /** Counts from the latest provider request, rather than cumulative turn usage. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; contextWindow: number }) => void;
}

export interface AgentResponse {
  workspace?: Parameters<NonNullable<ToolContext['onWorkspaceResult']>>[0];
  status?: 'completed' | 'max-iterations';
  /** Final assistant text (after all tool rounds complete) */
  text: string;
  /** Full message history including tool calls */
  messages: ModelMessage[];
  /** Number of tool-call rounds executed */
  iterations: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Whether context was compressed during this turn */
  compressed: boolean;
  /** Number of correction attempts made */
  correctionAttempts: number;
  /** Token usage (if available from the provider) */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ---------------------------------------------------------------------------
// Repeated-error detection
// ---------------------------------------------------------------------------

interface ErrorSignature {
  toolName: string;
  errorPrefix: string;
}

function getErrorSignature(toolName: string, result: string): ErrorSignature {
  return {
    toolName,
    errorPrefix: result.slice(0, 120),
  };
}

function signaturesMatch(a: ErrorSignature, b: ErrorSignature): boolean {
  return a.toolName === b.toolName && a.errorPrefix === b.errorPrefix;
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

/**
 * Run the agent loop for a single user turn.
 *
 * Flow:
 * 1. Auto-compress history if nearing context limit
 * 2. Send messages + tools to model (with retry on transient failures)
 * 3. Stream the response text
 * 4. If model made tool calls, execute them and loop back to step 2
 * 5. Detect repeated errors — inject a hint after 2 consecutive identical failures
 * 6. When model returns text with no tool calls, return final response
 */
export async function runAgentLoop(
  messages: ModelMessage[],
  config: AgentConfig,
): Promise<AgentResponse> {
  let delivery: Parameters<NonNullable<ToolContext['onWorkspaceResult']>>[0] | undefined;
  const result = await withTaskWorkspace({ ...openRouterTaskContext(config.toolContext, config.model), onWorkspaceResult: value => { delivery = value; config.toolContext.onWorkspaceResult?.(value); } }, ctx => executionContext.run(ctx, () => runAgentLoopInternal(messages, {
    ...config, toolContext: ctx,
    systemPrompt: config.systemPrompt + (ctx.taskWorkspace ? `\n\n## Private task workspace\nRun every file operation and shell command in ${ctx.cwd}. Earlier workspace paths refer to this checkout. Do not change the source project directly. Changes return automatically if the source has not changed. Use task_changes to inspect conflicts and read the latest source before reconciling them in this checkout. Shared plugin and MCP tools are unavailable here.` : ''),
  })));
  if (delivery && !delivery.applied) {
    const notice = `\n\nTask changes are saved separately because these project files changed: ${delivery.conflicts.join(', ')}. Ask notch to reconcile them; no project files were overwritten.`;
    config.onTextChunk?.(notice); result.text += notice;
    result.messages.push({ role: 'user', content: `Task delivery status: ${notice.trim()} The next turn will resume the saved private checkout. Use task_changes read_source on each conflicting file and reconcile its current source contents before finishing.` });
  }
  if (delivery) result.workspace = delivery;
  return result;
}

async function runAgentLoopInternal(messages: ModelMessage[], config: AgentConfig): Promise<AgentResponse> {
  // Build tools with read cache for this turn (prevents redundant file reads)
  const readCache = new Map<string, string>();
  const toolCtxWithCache = {
    ...config.toolContext,
    _readCache: readCache,
    _fileVersions: new Map<string, string | null>(),
  };
  const feedback = toolValidationFeedback(buildToolMap(toolCtxWithCache));
  const tools = feedback.tools;
  const maxIter = config.maxIterations ?? 25;
  const contextWindow = config.contextWindow ?? 131_072;
  let iterations = 0;
  let totalToolCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let wasCompressed = false;

  // Repeated-error tracking
  const recentErrors: ErrorSignature[] = [];
  const MAX_REPEATED_ERRORS = 3;

  // Correction pipeline setup
  const correctionCfg = config.correction ?? autoDetectPreset(config.modelId ?? '');
  let totalCorrectionAttempts = 0;
  let intentResult: 'yes' | 'no' | 'unclear' = 'unclear';

  // Working copy of messages — we append tool results as we go
  let history: ModelMessage[] = [...messages];
  const toolNames = Object.keys(tools);
  const templateFormatHint = correctionCfg.useTemplateFormat && toolNames.length > 0
    ? [
        '',
        'If native tool calling fails, use this fallback format with no extra prose:',
        'TOOL: <tool name>',
        'ARG_<argument_name>: <argument value>',
        `Available tool names: ${toolNames.join(', ')}`,
      ].join('\n')
    : '';

  const schemaText = JSON.stringify(await Promise.all(Object.entries(tools).map(async ([name, value]) => ({ name, description: value.description, schema: await asSchema(value.inputSchema).jsonSchema }))));
  const overhead = estimateTextTokens(`${config.systemPrompt}${templateFormatHint}${schemaText}`) + 256;
  const budget = contextBudget(contextWindow, overhead, config.maxOutputTokens);
  let tokenRatio = 1;
  const compact = async () => {
    const estimated = estimateTokens(history);
    if (estimated * tokenRatio < budget.compactAt) return;
    await config.onCompact?.(history);
    await config.toolContext.runHook?.('pre-compact', { messageCount: history.length });
    history = await autoCompress(history, config.model, contextWindow, () => {
      wasCompressed = true;
      config.onCompress?.();
    }, config.toolContext.abortSignal, Math.floor(budget.history / tokenRatio));
    if (estimateTokens(history) * tokenRatio > budget.history) throw new Error('The current request or tool results exceed the selected context. Increase context or split the request; the transcript has been saved.');
    await config.toolContext.runHook?.('post-compact', { messageCount: history.length });
  };

  // Pre-loop compression check
  await compact();

  // Intent gate: cheap classification pass before the main loop.
  // When the gate says YES but the model produces no tool calls,
  // we know it's a format failure and route to correction with
  // higher confidence.
  if (correctionCfg.intentGate && toolNames.length > 0) {
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    const userText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : '';
    if (userText) {
      intentResult = await intentGate(config.model, userText, toolNames);
    }
  }

  while (iterations < maxIter) {
    config.toolContext.abortSignal?.throwIfAborted();
    iterations++;

    // --- Microcompact: cheap first-line defense against tool-result bloat.
    // Zero model cost. Runs before every model call. Only fires once the
    // conversation is past threshold; preserves last 6 tool messages.
    const mc = microcompact(history, { keepLastN: 6, threshold: 50 });
    if (mc.cleared > 0) {
      history = mc.messages;
      config.onMicrocompact?.(mc.cleared, mc.savedChars);
    }
    await compact();

    // --- Stream (retry is handled by outer withRetry in index.ts) ---
    let fullText = '';
    const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
    const toolResults: Array<{ toolCallId: string; result: unknown }> = [];
    let streamUsage: { promptTokens?: number; completionTokens?: number } | null = null;

    const agent = new ToolLoopAgent({
      model: config.model,
      instructions: `${config.systemPrompt}${templateFormatHint}`,
      tools,
      stopWhen: isStepCount(1),
      repairToolCall: feedback.repair,
      maxRetries: 0,
      maxOutputTokens: budget.output,
    });
    const result = await agent.stream({ messages: history, abortSignal: config.toolContext.abortSignal });

    for await (const event of result.stream) {
      if (event.type === 'error') {
        const error = event.error instanceof Error ? event.error : new Error(String(event.error));
        // Retrying the whole turn after actions ran could repeat edits or shell
        // commands. Let the user resume from the current filesystem instead.
        if (totalToolCalls > 0 || toolCalls.length > 0) Object.assign(error, { retryable: false });
        throw error;
      }
      if (event.type === 'text-delta') {
        fullText += event.text;
        config.onTextChunk?.(event.text);
      } else if (event.type === 'tool-call') {
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.input as Record<string, unknown>,
        });
        config.onToolCall?.(event.toolName, event.input as Record<string, unknown>, event.toolCallId);
      }
      const evt = event as Record<string, unknown>;
      if (evt.type === 'tool-result' || evt.type === 'tool-error') {
          const output = evt.type === 'tool-error' ? { content: evt.error instanceof Error ? evt.error.message : String(evt.error), isError: true } : evt.output;
        const res = output as { content: string; isError?: boolean } | undefined;
        toolResults.push({
          toolCallId: evt.toolCallId as string,
          result: output,
        });
        config.onToolResult?.(
          toolCalls.find((tc) => tc.toolCallId === evt.toolCallId)?.toolName ?? 'unknown',
          res?.content ?? String(output),
          res?.isError ?? false,
          evt.toolCallId as string,
        );
      }
    }
    config.toolContext.abortSignal?.throwIfAborted();

    // Collect usage
    try {
      const u = await result.usage;
      if (u) streamUsage = { promptTokens: u.inputTokens, completionTokens: u.outputTokens };
    } catch {
      // Usage not available
    }

    if (streamUsage) {
      totalPromptTokens += streamUsage.promptTokens ?? 0;
      totalCompletionTokens += streamUsage.completionTokens ?? 0;
      if (Number.isSafeInteger(streamUsage.promptTokens) && Number.isSafeInteger(streamUsage.completionTokens)
          && streamUsage.promptTokens! >= 0 && streamUsage.completionTokens! >= 0) {
        tokenRatio = Math.max(1, Math.min(4, (streamUsage.promptTokens! - overhead) / Math.max(1, estimateTokens(history))));
        config.onUsage?.({ inputTokens: streamUsage.promptTokens!, outputTokens: streamUsage.completionTokens!, contextWindow });
      }

      // Phase 1 shadow probe — records real token counts + pi-ai cost
      // estimate for later comparison against Stripe metering. No-op unless
      // NOTCH_USE_PI_AI is set and the model was resolved via a BYOK config.
      // Fire-and-forget; never blocks the loop.
      void recordShadowUsage(
        config.model as unknown as object,
        streamUsage,
      );
    }
    totalToolCalls += toolCalls.length;
    // Keep reasoning and provider metadata needed when native APIs replay tool calls.
    const nativeAssistantMessages = (await result.responseMessages ?? []).filter(message => message.role === 'assistant');
    const nativeCallCount = toolCalls.length;

    const missingCall = missingToolCallFeedback(await result.finishReason, toolCalls.length);
    if (missingCall) {
      history.push({ role: 'user', content: missingCall });
      totalCorrectionAttempts++;
      config.onCorrection?.(totalCorrectionAttempts, false);
      continue;
    }

    // --- Correction pipeline: when the model produced no native tool calls
    // but the text looks like it tried to call a tool, run the correction
    // pass to extract or re-elicit the tool call. ---
    if (toolCalls.length === 0 && fullText && correctionCfg.maxCorrectionAttempts > 0 && toolNames.length > 0) {
      const directExtracted = extractToolCallsFromText(fullText, toolNames);
      const templateExtracted = correctionCfg.useTemplateFormat
        ? extractTemplateToolCalls(fullText, toolNames)
        : [];
      const shouldCorrect = looksLikeFailedToolCall(fullText, toolNames)
        || directExtracted.length > 0
        || templateExtracted.length > 0
        || (intentResult === 'yes' && totalToolCalls === 0);

      if (shouldCorrect) {
        const corrected = directExtracted.length > 0
          ? directExtracted
          : templateExtracted.length > 0
            ? templateExtracted
            : await correctionPass(
                config.model,
                fullText,
                toolNames,
                history,
                correctionCfg.maxCorrectionAttempts,
              );
        totalCorrectionAttempts++;
        if (corrected && corrected.length > 0) {
          // Correction succeeded — inject the corrected tool calls as if
          // the model had produced them natively.
          config.onCorrection?.(totalCorrectionAttempts, true);
          for (const tc of corrected) {
            toolCalls.push({
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.args,
            });
          }
          totalToolCalls += corrected.length;

          // Execute the corrected tool calls manually since they didn't
          // come from streamText's native tool execution.
          for (const tc of corrected) {
            const toolDef = tools[tc.name];
            if (!toolDef?.execute) {
              toolResults.push({
                toolCallId: tc.id,
                result: { content: `Tool "${tc.name}" not found.`, isError: true },
              });
              continue;
            }
            try {
              // Call through the same wrapped execute that streamText uses,
              // which includes permission checks, hooks, and dry-run.
              config.onToolCall?.(tc.name, tc.args, tc.id);
              const result = await toolDef.execute(tc.args, { toolCallId: tc.id, messages: history, context: undefined });
              toolResults.push({ toolCallId: tc.id, result });
              config.onToolResult?.(
                tc.name,
                result?.content ?? String(result),
                result?.isError ?? false,
                tc.id,
              );
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              toolResults.push({
                toolCallId: tc.id,
                result: { content: `Error: ${msg}`, isError: true },
              });
              config.onToolResult?.(tc.name, `Error: ${msg}`, true, tc.id);
            }
          }
        } else {
          config.onCorrection?.(totalCorrectionAttempts, false);
        }
      }
    }

    // --- Handle tool calls ---
    if (toolCalls.length > 0) {
      // Check for repeated errors
      let hasRepeatedError = false;
      for (const tr of toolResults) {
        const res = tr.result as { content?: string; isError?: boolean } | undefined;
        if (res?.isError) {
          const toolName = toolCalls.find((tc) => tc.toolCallId === tr.toolCallId)?.toolName ?? 'unknown';
          const sig = getErrorSignature(toolName, res.content ?? '');
          const repeated = recentErrors.filter((e) => signaturesMatch(e, sig)).length;
          recentErrors.push(sig);

          if (repeated >= MAX_REPEATED_ERRORS - 1) {
            hasRepeatedError = true;
          }
        }
      }

      // Append assistant message
      if (nativeCallCount === toolCalls.length && nativeAssistantMessages.length) {
        history.push(...nativeAssistantMessages);
      } else history.push({
        role: 'assistant',
        content: [
          ...(fullText ? [{ type: 'text' as const, text: fullText }] : []),
          ...toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.args,
          })),
        ],
      });

      // Append tool results
      history.push({
        role: 'tool',
        content: toolResults.map((tr) => ({
          type: 'tool-result' as const,
          toolCallId: tr.toolCallId,
          toolName: toolCalls.find((tc) => tc.toolCallId === tr.toolCallId)?.toolName ?? 'unknown',
          output: toolOutput(tr.result),
        })),
      } satisfies ToolModelMessage);

      // Inject hint if the model is stuck in an error loop
      if (hasRepeatedError) {
        history.push({
          role: 'user',
          content:
            '[System: You have repeated the same failing tool call multiple times. ' +
            'Stop and try a different approach. If the tool is unavailable or the ' +
            'command keeps failing, explain the issue to the user instead of retrying.]',
        });
        // Reset error tracking
        recentErrors.length = 0;
      }


      continue;
    }

    // --- No tool calls — done, unless coordinator mode has pending workers ---
    if (nativeAssistantMessages.length) history.push(...nativeAssistantMessages);
    else history.push({ role: 'assistant', content: fullText });

    // Coordinator-mode hook: if the model ran out of tool calls but there are
    // in-flight worker agents, wait for the next <task-notification> and
    // continue the loop. In non-coordinator mode pollPendingAgents() is a
    // no-op (the registry stays empty) and this adds ~0 overhead.
    if (await pollPendingAgents(history)) {
      continue;
    }

    return {
      status: 'completed',
      text: fullText,
      messages: history,
      iterations,
      toolCallCount: totalToolCalls,
      compressed: wasCompressed,
      correctionAttempts: totalCorrectionAttempts,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
      },
    };
  }

  // Hit max iterations
  const finalText = '[Reached maximum tool iterations. Please continue or refine your request.]';
  history.push({ role: 'assistant', content: finalText });

  return {
    status: 'max-iterations',
    text: finalText,
    messages: history,
    iterations,
    toolCallCount: totalToolCalls,
    compressed: wasCompressed,
    correctionAttempts: totalCorrectionAttempts,
    usage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
    },
  };
}

/**
 * Build the system prompt for the Notch agent.
 *
 * Assembled from an ordered list of sections (see ./prompt-sections.ts).
 * The FIRST cache-breaking section establishes the
 * `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` split between the cacheable prefix
 * (tone/tools/agent registry) and the volatile suffix (cwd, git branch,
 * memory, date/time, project instructions).
 */
export async function buildSystemPrompt(
  projectRoot: string,
  _modelId?: string,
  toolContext?: ToolContext,
): Promise<string> {
  const sections: PromptSection[] = [
    // =========================================================
    // CACHEABLE PREFIX — stable across turns, sessions, users.
    // These are safe to reuse wherever prompt caching is available.
    // =========================================================
    safeSection('identity', () =>
      [
        'You are Notch, an expert AI coding assistant built by Driftrail.',
        'You help developers write, debug, refactor, and understand code.',
        'Use the tools and argument schemas supplied with each request.',
      ].join('\n'),
    ),

    safeSection('tone', () =>
      [
        '## Tone & Style',
        '- Be concise. Prefer direct answers over preambles.',
        "- Don't restate what the user said.",
        '- Default to plain prose; reach for headings/bullets only when structure genuinely helps.',
        '- Never use emojis unless the user does first.',
      ].join('\n'),
    ),

    safeSection('guidelines', () =>
      [
        '## Guidelines',
        '- Always read files before editing them.',
        '- Use exact string matching for edits — never guess at file contents.',
        "- Explain what you're doing before making changes.",
        '- If a task is complex, break it into steps.',
        '- When running shell commands, prefer non-destructive operations.',
        '- If you encounter an error, analyze it and suggest a fix.',
        '- If the same tool call keeps failing, stop retrying and try a different approach.',
      ].join('\n'),
    ),

    safeSection('quality-bar', () =>
      [
        '## Quality Bar',
        '- Do not declare work done while required work remains incomplete. Report failures and execution limits honestly.',
        '- Run the requested tests. After the implemented requirements pass, report the actual result and finish; do not repeat successful checks without a new change or unresolved concern.',
        '- Prefer editing existing files over creating new ones.',
        '- Do not invent APIs — if you need to verify syntax or semantics, read the source or the docs first.',
        '- When the user asks for a fix, fix the root cause, not the symptom.',
      ].join('\n'),
    ),

    safeSection('builtin-agents', () => {
      try {
        const agents = listBuiltinAgents();
        if (agents.length === 0) return '';
        const lines = agents.map((a) => `- \`${a.name}\`: ${a.description ?? ''}`.trimEnd());
        return ['## Built-in Agents', 'These agents can be invoked via the task tool:', ...lines].join('\n');
      } catch {
        return '';
      }
    }),

    // =========================================================
    // VOLATILE SUFFIX — session/user/turn-specific.
    // The FIRST entry here places the __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
    // marker. Everything below this point invalidates the prompt cache
    // whenever its contents change.
    // =========================================================
    DANGEROUS_uncachedSystemPromptSection(
      'env-context',
      async () => {
        const lines: string[] = ['## Environment'];
        lines.push(`- Working directory: ${projectRoot}`);
        lines.push(`- Platform: ${process.platform}`);
        if (process.platform === 'win32') lines.push('- The shell tool currently uses cmd.exe. Use portable Node commands or invoke PowerShell explicitly; Unix commands such as cat are not available by default.');
        lines.push(`- Current date (UTC): ${new Date().toISOString().slice(0, 10)}`);
        try {
          const entries = await fs.readdir(projectRoot);
          const preview = entries.filter((e) => !e.startsWith('.')).slice(0, 30).join(', ');
          if (preview) lines.push(`- Top-level entries: ${preview}`);
        } catch {
          // ignore
        }
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1500,
          })
            .toString()
            .trim();
          if (branch) lines.push(`- Git branch: ${branch}`);
        } catch {
          // not a git repo — fine
        }
        return lines.join('\n');
      },
      'Working directory, platform, date, and git branch change per session and per machine; cannot be cached.',
    ),

    DANGEROUS_uncachedSystemPromptSection(
      'project-instructions',
      async () => {
        try {
          const instructions = await loadProjectInstructions(projectRoot);
          if (instructions) {
            return `## Project Instructions (.notch.md)\n${instructions}`;
          }
        } catch {
          // no instructions — fine
        }
        return '';
      },
      'Project instruction files live per-repo and evolve as the user edits them; not cacheable across projects.',
    ),

    DANGEROUS_uncachedSystemPromptSection(
      'memory',
      async () => {
        try {
          const memoryStr = await formatMemoriesForPrompt();
          if (memoryStr) {
            // Saved memory may have been influenced by prior tool output or
            // agent-suggested edits, so wrap it in the untrusted-context
            // fence. See untrusted-context.ts for the format contract.
            return fenceUntrustedContext('project-memory', `Saved Context (Memory)\n${memoryStr}`, {
              origin: 'cli:local-memory',
            });
          }
        } catch {
          // no memory — fine
        }
        return '';
      },
      'Memories change between turns whenever the user saves or deletes one; cannot be cached.',
    ),
  ];

  return composeSystemPrompt(sections);
}
