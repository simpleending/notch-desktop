import path from 'node:path';
import fs from 'node:fs/promises';
import type { ModelMessage } from 'ai';
import { loadConfig, selectModel } from './config.js';
import { resolveModel } from './providers/registry.js';
import { isByokRef, parseByokRef } from './providers/byok.js';
import { ollamaContextLength } from './providers/ollama-transport.js';
import { runAgentLoop, buildSystemPrompt, type AgentConfig } from './agent/loop.js';
import { CheckpointManager } from './agent/checkpoints.js';
import { parsePatch } from './tools/apply-patch.js';
import { loadPermissions, checkPermission, type PermissionRule } from './permissions/index.js';
import { checkAccess, type AccessMode } from './permissions/access.js';
import type { ToolContext } from './tools/types.js';

export { CheckpointManager };
export { detectLocalHardware, parseNvidiaMemory, linuxGpuMemory, modelFit, inspectHubModel, LOCAL_MODEL_CATALOG } from './providers/local-models.js';
export { contextBudget, estimateTextTokens } from './agent/context-budget.js';
export { autoCompress, fullCompact, safeTailStart, estimateTokens } from './agent/compression.js';
export type { ModelMessage, AccessMode };
export interface DesktopTurn {
  webSettings?: ToolContext['webSettings'];
  workspaceSearch?: ToolContext['workspaceSearch'];
  ripgrepPath?: string;
  cwd: string;
  sessionId: string;
  messages: ModelMessage[];
  model?: string;
  apiKey?: string;
  maxOutputTokens?: number;
  baseUrl?: string;
  contextWindow?: number;
  nativeContextWindow?: number;
  ollamaBatch?: number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  instructions?: string;
  accessMode: AccessMode;
  workspaceMode?: 'shared' | 'isolated';
  signal: AbortSignal;
  checkpoints: CheckpointManager;
  approve: NonNullable<ToolContext['confirmTool']>;
  maxIterations?: number;
  onText?: AgentConfig['onTextChunk'];
  onToolCall?: AgentConfig['onToolCall'];
  onToolResult?: AgentConfig['onToolResult'];
  onUsage?: AgentConfig['onUsage'];
  onCompact?: AgentConfig['onCompact'];
  onLog?: (message: string) => void;
  onQueue?: (message: string | null) => void;
  onLifecycle?: (event: string, payload: Record<string, unknown>) => Promise<void>;
}

const desktopToolNames: Record<string, string> = { Read: 'read', TaskChanges: 'task_changes', Write: 'write', Edit: 'edit', Bash: 'shell', Glob: 'glob', Grep: 'grep', Git: 'git', ApplyPatch: 'apply_patch', WebFetch: 'web_fetch', WebSearch: 'web_search', BrowserRead: 'browser_read', BrowserInteract: 'browser_interact', Agent: 'task' };
export function desktopToolName(name: string): string { return desktopToolNames[name] ?? name; }
export function definitionRules(values: string[] = [], level: 'allow' | 'deny'): PermissionRule[] {
  return values.map(value => {
    const match = /^([\w*.-]+)(?:\((.+)\))?$/.exec(value);
    if (!match) throw new Error(`Unsupported desktop tool policy: ${value}`);
    if (match[1]!.includes('*') && match[1] !== '*') throw new Error(`Unsupported desktop tool wildcard: ${value}`);
    return { tool: desktopToolName(match[1]!), level, ...(match[2] ? { pattern: match[2] } : {}) };
  });
}

/** The desktop uses the CLI's real provider, tool and permission implementation. */
export async function runDesktopTurn(turn: DesktopTurn) {
  const cwd = await fs.realpath(turn.cwd);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Choose a workspace directory.');
  if (!['approve', 'read-only', 'full-access'].includes(turn.accessMode)) throw new Error('Invalid desktop access mode.');
  turn.signal.throwIfAborted();
  const config = await loadConfig({ projectRoot: cwd });
  const selection = { ...(turn.model && turn.model !== 'auto' ? selectModel(config.models.chat, { model: turn.model }) : config.models.chat),
    ...(turn.baseUrl ? { baseUrl: turn.baseUrl } : {}),
    ...(turn.apiKey ? { apiKey: turn.apiKey } : {}),
    ...(turn.contextWindow ? { contextWindow: turn.contextWindow } : {}),
    ...(turn.nativeContextWindow ? { nativeContextWindow: turn.nativeContextWindow } : {}),
    ...(turn.ollamaBatch ? { ollamaBatch: turn.ollamaBatch } : {}),
  };
  const provider = selection.byokProvider || (isByokRef(selection.model) ? parseByokRef(selection.model).provider : undefined);
  if (provider === 'openrouter') {
    selection.baseUrl = 'https://openrouter.ai/api/v1';
    delete selection.headers; delete selection.byokHeaders; delete selection.byokApiShape;
  }
  if (provider === 'ollama' && selection.baseUrl?.replace(/\/v1\/?$/, '') === 'http://127.0.0.1:11436') {
    const { managedOllama } = await import('./providers/ollama-runtime.js');
    await managedOllama('0.40.3', turn.signal);
  }
  if (provider === 'mlx') {
    const { startMlx } = await import('./providers/local-runner.js');
    selection.baseUrl = await startMlx(parseByokRef(selection.model).model, turn.signal);
  }
  if (provider === 'ollama' || provider === 'ollama-anthropic') selection.contextWindow = ollamaContextLength(selection.contextWindow, selection.nativeContextWindow);
  const permissions = await loadPermissions(cwd);
  const delivered = new Set<string>();
  const allowed = definitionRules(turn.allowedTools, 'allow'), denied = definitionRules(turn.disallowedTools, 'deny');
  const ctx: ToolContext = {
    webSettings: turn.webSettings ?? (async () => ({ enabled: true, browser: 'auto' })),
    workspaceMode: () => turn.workspaceMode ?? config.workspaceMode ?? 'shared',
    isolateTasks: () => provider === 'openrouter' && (turn.workspaceMode ?? config.workspaceMode) === 'isolated',
    workspaceCheckpoints: {
      finish: async () => { await turn.checkpoints.commit('Desktop turn'); },
      recordBefore: async file => {
        await turn.checkpoints.recordBefore(file); delivered.add(file);
        await turn.onLifecycle?.('pre-tool', { tool: 'write', args: { path: file }, toolCallId: `delivery:${file}` });
      },
      recordAfter: async file => {
        await turn.checkpoints.recordAfter(file);
        for (const target of file ? [file] : delivered) await turn.onLifecycle?.('post-tool', { tool: 'write', args: { path: target }, toolCallId: `delivery:${target}`, result: 'Task changes applied.', isError: false });
      },
    },
    workspaceSearch: turn.workspaceSearch, ripgrepPath: turn.ripgrepPath,
    cwd, abortSignal: turn.signal, accessMode: turn.accessMode,
    requireConfirm: false, confirm: async () => false, confirmTool: turn.approve,
    onlyTools: turn.tools?.map(desktopToolName),
    permissionSurface: 'interactive', permissionSessionId: turn.sessionId,
    log: turn.onLog || (() => {}), onQueue: turn.onQueue,
    checkPermission: (name, args) => {
      if (checkPermission({ default: 'allow', rules: denied }, name, args) === 'deny') return 'deny';
      if (name === 'task_changes' && checkPermission({ default: 'allow', rules: denied }, 'read', args) === 'deny') return 'deny';
      if (allowed.length && checkPermission({ default: 'deny', rules: allowed }, name, args) !== 'allow' && !(name === 'task_changes' && checkPermission({ default: 'deny', rules: allowed }, 'read', args) === 'allow')) return 'deny';
      return checkAccess(turn.accessMode, permissions, name, args);
    },
    runHook: async (event, payload) => {
      await turn.onLifecycle?.(event, payload);
      if (payload.isolatedWorkspace) return;
      if (event === 'post-tool') await turn.checkpoints.recordAfter();
      if (event !== 'pre-tool') return;
      const args = payload.args as Record<string, unknown>;
      if ((payload.tool === 'write' || payload.tool === 'edit') && typeof args.path === 'string') await turn.checkpoints.recordBefore(path.resolve(cwd, args.path));
      if (payload.tool === 'apply_patch' && typeof args.input === 'string') for (const action of parsePatch(args.input)) {
        await turn.checkpoints.recordBefore(path.resolve(cwd, action.target));
        if (action.kind === 'update' && action.moveTo) await turn.checkpoints.recordBefore(path.resolve(cwd, action.moveTo));
      }
    },
  };
  try {
    return await runAgentLoop(turn.messages, {
      model: resolveModel(selection), modelId: selection.model,
      systemPrompt: (await buildSystemPrompt(cwd, selection.model, ctx)) + (turn.instructions ? `\n\nDesktop agent instructions:\n${turn.instructions}` : ''), toolContext: ctx,
      maxIterations: turn.maxIterations, contextWindow: selection.contextWindow,
      onTextChunk: turn.onText, onToolCall: turn.onToolCall, onToolResult: turn.onToolResult,
      onUsage: turn.onUsage,
      maxOutputTokens: turn.maxOutputTokens, onCompact: turn.onCompact,
    });
  } finally { await turn.checkpoints.commit('Desktop turn'); }
}

export { webSettingsSchema, validSearchKey, installResearchBrowser } from './web/settings.js';
