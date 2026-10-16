/**
 * Notch CLI — Tool Registry
 *
 * Exports all available tools as a unified map.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { tool } from 'ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { applyPatchTool } from './apply-patch.js';
import { shellTool, validateCommand } from './shell.js';
import path from 'node:path';
import { gitTool } from './git.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';
import { browserReadTool, browserInteractTool } from './browser.js';
import { githubTool } from './github.js';
import { lspTool } from './lsp.js';
import { notebookTool } from './notebook.js';
import { taskTool } from './task.js';
import { codeModeExecTool, codeModeWaitTool } from './code-mode.js';
import { skillManageTool } from './skill-manage.js';
import { eventsTool } from './events.js';
import type { NotchTool, ToolContext, PermissionLevel } from './types.js';
import { MCPClient, parseMCPConfig, mcpToolsToNotch, type MCPServerConfig } from '../mcp/client.js';
import { pluginManager } from '../plugins/index.js';
import { assessRisk, type RiskAssessment } from '../safety/guardian.js';
import {
  agentSpawnTool,
  agentSendMessageTool,
  agentStopTool,
  COORDINATOR_ALLOWED_TOOL_NAMES,
} from '../coordinator/tools.js';
import {
  runPermissionCheck,
  createHandlerContext,
  recordAutoModeDenial,
  pushTailNotification,
  type Surface,
} from '../permissions/dispatcher.js';
import { recordInteractiveApproval } from '../permissions/handlers/interactive.js';

import { isBuiltInReadTool } from '../permissions/access.js';
import { guardedFileAccess } from '../concurrency/file-access.js';
import { taskChangesTool } from './task-changes.js';
export type { ToolContext, ToolResult, NotchTool, PermissionLevel } from './types.js';

/** All built-in tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILTIN_TOOLS: NotchTool<any>[] = [
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  shellTool,
  gitTool,
  githubTool,
  grepTool,
  globTool,
  webFetchTool,
  webSearchTool,
  browserReadTool,
  browserInteractTool,
  lspTool,
  notebookTool,
  taskTool,
  codeModeExecTool,
  codeModeWaitTool,
  skillManageTool,
  eventsTool,
  taskChangesTool,
];

/** MCP clients (kept alive for the session) */
const mcpClients = new Map<string, MCPClient>();

/** MCP tools discovered from connected servers */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mcpTools: NotchTool<any>[] = [];

/**
 * Connect to MCP servers from config and discover tools.
 * Call this once at startup after loading .notch.json.
 */
export async function initMCPServers(config: Record<string, unknown>): Promise<number> {
  const servers = parseMCPConfig(config);
  let toolCount = 0;

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const client = new MCPClient(serverConfig, name);
      await client.connect();
      mcpClients.set(name, client);
      const tools = mcpToolsToNotch(client, name);
      mcpTools.push(...tools);
      toolCount += tools.length;
    } catch (err: any) {
      console.error(`  MCP server '${name}' failed to connect: ${err.message}`);
    }
  }

  return toolCount;
}

/** Disconnect all MCP servers (call on exit) */
export function disconnectMCPServers(): void {
  for (const [, client] of mcpClients) {
    client.disconnect();
  }
  mcpClients.clear();
  mcpTools = [];
}

/** Coordinator-mode tools — exposed ONLY when ctx.coordinatorMode is true. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COORDINATOR_ONLY_TOOLS: NotchTool<any>[] = [
  agentSpawnTool,
  agentSendMessageTool,
  agentStopTool,
];

/** All available tools (built-in + MCP + plugins) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAllTools(ctx?: ToolContext): NotchTool<any>[] {
  const coordinator = !!ctx?.coordinatorMode;

  if (coordinator) {
    // In coordinator mode: only the 3 coordinator tools + read/grep/glob.
    // MCP tools and plugin tools are dropped — the coordinator must delegate
    // all external interactions to workers, which get the full tool map.
    const allowed: NotchTool<any>[] = [];
    for (const t of BUILTIN_TOOLS) {
      if (COORDINATOR_ALLOWED_TOOL_NAMES.has(t.name)) allowed.push(t);
    }
    allowed.push(...COORDINATOR_ONLY_TOOLS);
    return ctx?.onlyTools ? allowed.filter(tool => ctx.onlyTools!.includes(tool.name)) : allowed;
  }

  // Non-coordinator mode: full built-in set + MCP + plugins, and the
  // coordinator-only tools are excluded entirely so the model never sees
  // agent_spawn / agent_send_message / agent_stop outside coordinator mode.
  const all = ctx?.remoteWorkspace ? BUILTIN_TOOLS.filter(t => ['read', 'write', 'edit', 'shell', 'grep', 'glob'].includes(t.name)) : ctx?.taskWorkspace ? BUILTIN_TOOLS : [...BUILTIN_TOOLS.filter(t => t !== taskChangesTool), ...mcpTools, ...pluginManager.getTools()];
  return ctx?.onlyTools ? all.filter(tool => ctx.onlyTools!.includes(tool.name) || (ctx.taskWorkspace && tool === taskChangesTool && ctx.onlyTools!.includes('read'))) : all;
}

/**
 * Build the tool map, binding each tool to the given context.
 * Integrates permission checks, hook execution, and dry-run support.
 */
export function buildToolMap(ctx: ToolContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map: Record<string, any> = {};

  for (const t of getAllTools(ctx)) {
    map[t.name] = tool({
      description: t.description,
      inputSchema: t.parameters,
      execute: async (params, execution) => {
        ctx.abortSignal?.throwIfAborted();
        const readOnly = isBuiltInReadTool(t.name, BUILTIN_TOOLS.includes(t));
        if (ctx.accessMode === 'read-only' && !readOnly) {
          return { content: `Permission denied: ${t.name} is unavailable in read-only mode.`, isError: true };
        }
        if (ctx.dryRun && !readOnly) {
          return { content: `[DRY RUN] Would execute ${t.name}:\n${JSON.stringify(params, null, 2).slice(0, 500)}` };
        }
        // Native SDK calls are validated before execution, but recovered
        // text calls use this wrapper directly. Both paths must enforce the
        // same argument schema before permissions, hooks or side effects.
        const validated = t.parameters.safeParse(params);
        if (!validated.success) {
          return { content: `Invalid arguments for ${t.name}: ${validated.error.message}`, isError: true };
        }
        params = validated.data;
        if (ctx.remoteWorkspace && t.name === 'shell') {
          const problem = validateCommand((params as {command: string}).command, ctx.cwd, path.posix);
          if (problem) return { content: problem, isError: true };
        }
        // Check permissions
        if (ctx.checkPermission) {
          // Fire permission-request hook
          await ctx.runHook?.('permission-request', { tool: t.name, args: params });

          const argRecord = params as Record<string, unknown>;
          const baseLevel: PermissionLevel = ctx.checkPermission(t.name, argRecord);

          // Route through the active surface's handler BEFORE the UI prompt
          // is ever shown. The handler can allow/deny silently, downgrade a
          // prompt to allow (session-recent approval), upgrade an allow to
          // prompt (classifier-flagged destructive), etc.
          const surface: Surface = ctx.permissionSurface ?? 'interactive';
          const handlerCtx = createHandlerContext({
            cwd: ctx.cwd,
            sessionId: ctx.permissionSessionId ?? 'session',
            log: ctx.log,
            autoConfirm: ctx.autoConfirm,
            guardianEnabled: !!ctx.guardianModel,
            subagentId: ctx.subagentId,
          });

          const decision = await runPermissionCheck(t.name, argRecord, baseLevel, surface, handlerCtx);

          if (decision.outcome === 'deny') {
            // Push the tail notification if the surface is auto-mode so
            // `drainTailNotifications()` at turn-end can surface it.
            if (surface === 'auto-mode') recordAutoModeDenial(decision);
            await ctx.runHook?.('permission-denied', {
              tool: t.name,
              args: params,
              reason: decision.reason ?? 'denied-by-handler',
              surface,
            });
            return {
              content: decision.silent
                ? `Permission denied: ${decision.reason ?? t.name + ' blocked by ' + surface + ' handler'}`
                : `Permission denied: ${t.name} — ${decision.reason ?? 'denied by permission handler'}.`,
              isError: true,
            };
          }

          if (decision.outcome === 'prompt') {
            // Guardian pre-flight — independent second-opinion scoring. Runs
            // BEFORE the template prompt so its verdict can (a) auto-allow a
            // clearly low-risk action, (b) block a critical one outright, or
            // (c) annotate the standard prompt with the severity tag.
            let guardian: RiskAssessment | null = null;
            if (ctx.guardianModel) {
              try {
                guardian = await assessRisk(
                  { tool: t.name, args: argRecord },
                  ctx.guardianModel,
                );
              } catch {
                // Guardian must never block on its own failure.
                guardian = null;
              }

              if (guardian?.recommended_action === 'deny') {
                await ctx.runHook?.('permission-denied', {
                  tool: t.name,
                  args: params,
                  reason: 'guardian-denied',
                  guardian,
                });
                return {
                  content: `Guardian blocked this action (${guardian.severity}): ${guardian.justification}`,
                  isError: true,
                };
              }
            }

            const guardianCleared =
              guardian?.recommended_action === 'auto-allow' &&
              guardian.severity === 'low';

            if (!guardianCleared) {
              if (!ctx.requireConfirm && !ctx.confirmTool) {
                // No UI available but the handler still wants a prompt — treat
                // as deny to be safe, with a tail notification so it surfaces.
                pushTailNotification(`${surface}: prompt required for ${t.name} but no UI (denied)`);
                await ctx.runHook?.('permission-denied', {
                  tool: t.name,
                  args: params,
                  reason: 'no-ui-to-prompt',
                  surface,
                });
                return {
                  content: `Permission denied: ${t.name} requires a prompt but no interactive UI is attached.`,
                  isError: true,
                };
              }
              const paramSummary = Object.entries(argRecord)
                .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
                .join(', ');
              const basePrompt = `Tool ${t.name}(${paramSummary}) requires approval. Proceed?`;
              const guardianTag = guardian
                ? `\n(Guardian: ${guardian.severity} — ${guardian.justification.slice(0, 200)})`
                : '';
              const confirmed = ctx.confirmTool
                ? await ctx.confirmTool(t.name, argRecord, basePrompt + guardianTag, execution?.toolCallId)
                : await ctx.confirm(basePrompt + guardianTag);
              if (!confirmed) {
                await ctx.runHook?.('permission-denied', { tool: t.name, args: params, reason: 'cancelled-by-user' });
                return { content: 'Cancelled by user.', isError: true };
              }
              // Record the approval so the same (tool, args) within 30s won't
              // re-prompt (interactive surface only — no-op for others).
              if (surface === 'interactive' && !ctx.confirmTool) {
                recordInteractiveApproval(
                  ctx.permissionSessionId ?? 'session',
                  t.name,
                  argRecord,
                );
              }
            }
          }
        }

        const execute = async () => {
        // Fire pre-tool hook
        await ctx.runHook?.('pre-tool', { tool: t.name, args: params, toolCallId: execution?.toolCallId });
        ctx.abortSignal?.throwIfAborted();

        // Execute the tool
        // Shell, git, MCP and file tools can change files. Never serve a stale
        // cached read after an action (including a partially failed action).
        const mayChangeFiles = !['read', 'glob', 'grep', 'web_fetch', 'web_search', 'browser_read', 'browser_interact'].includes(t.name);
        if (mayChangeFiles) ctx._readCache?.clear();
        let result;
        try {
          result = ctx.remoteWorkspace ? await ctx.remoteWorkspace.execute(t.name, params as Record<string, unknown>, ctx.abortSignal) : await t.execute(params, ctx);
        } finally {
          if (mayChangeFiles) ctx._readCache?.clear();
        }

        // Fire post-tool hook
        await ctx.runHook?.('post-tool', {
          tool: t.name,
          args: params,
          result: result.content.slice(0, 500),
          isError: result.isError ?? false,
          toolCallId: execution?.toolCallId,
        });

        return result;
        };
        return ctx.remoteWorkspace ? execute() : guardedFileAccess(t.name, params as Record<string, unknown>, ctx, execute);
      },
    });
  }

  return map;
}

/** List all tool names (useful for system prompt construction) */
export function listToolNames(ctx?: ToolContext): string[] {
  return getAllTools(ctx).map((t) => t.name);
}

/** Get tool descriptions formatted for a system prompt */
export function describeTools(ctx?: ToolContext): string {
  return getAllTools(ctx).map(
    (t) => `- **${t.name}**: ${t.description}`
  ).join('\n');
}

export interface DescribeToolSchemasOptions {
  /** Include only this subset of tool names. Defaults to every active tool. */
  includeNames?: Iterable<string>;
}

/** Get compact tool names, descriptions, and argument JSON schemas for prompts. */
export function describeToolSchemas(
  ctx?: ToolContext,
  options: DescribeToolSchemasOptions = {},
): string {
  const include = options.includeNames ? new Set(options.includeNames) : null;
  const tools = getAllTools(ctx).filter((t) => !include || include.has(t.name));
  if (tools.length === 0) return '## Tool Schemas\nNo tools are available in this mode.';

  const lines = [
    '## Tool Schemas',
    'Native tool schemas are sent with every model request. They are repeated here so OpenAI-compatible routers and local models can reliably choose valid tools.',
    'When using a tool, call the native tool with exactly one listed name and a JSON object matching its parameters schema. Do not print tool-call JSON as normal text.',
    '',
  ];

  for (const t of tools) {
    const schema = toolPromptSchema(t);
    lines.push(`### ${t.name}`);
    lines.push(t.description);
    lines.push('Parameters JSON Schema:');
    lines.push('```json');
    lines.push(JSON.stringify(schema));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function toolPromptSchema(t: NotchTool<any>): Record<string, unknown> {
  const schema = t.inputSchema
    ?? zodToJsonSchema(t.parameters, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
  return stripSchemaNoise(schema) as Record<string, unknown>;
}

function stripSchemaNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaNoise);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$schema' || key === 'definitions' || key === '$defs') continue;
    out[key] = stripSchemaNoise(raw);
  }
  return out;
}

/** Get count of MCP tools currently loaded */
export function mcpToolCount(): number {
  return mcpTools.length;
}
