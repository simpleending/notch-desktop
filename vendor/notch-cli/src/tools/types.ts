/**
 * Notch CLI — Tool System Types
 *
 * Tool definitions for the Notch agent.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { AccessMode } from '../permissions/access.js';

export type PermissionLevel = 'allow' | 'deny' | 'prompt';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Preflight rejection or preview: this is not an executed command result. */
  notExecuted?: boolean;
}

export interface NotchTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TParams;
  /** Optional JSON Schema override, used for non-Zod sources such as MCP tools. */
  inputSchema?: Record<string, unknown>;
  execute: (params: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Shared context available to all tools during execution */
export interface ToolContext {
  /** Desktop SSH transport. Schemas and permissions still run before this boundary. */
  remoteWorkspace?: { leaseKey: string; execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> };
  webSettings?: () => Promise<import('../web/settings.js').WebSettings>;
  workspaceMode?: () => 'shared' | 'isolated';
  /** Internal ownership token, inherited only by workers of an active shared task. */
  sharedTask?: string;
  sharedWorker?: string;
  isolateTasks?: () => boolean;
  taskWorkspace?: import('../concurrency/task-workspace.js').TaskWorkspace;
  workspaceCheckpoints?: { recordBefore(file: string): Promise<void>; recordAfter(file?: string): Promise<void>; finish?(): Promise<void> };
  onWorkspaceResult?: (result: { applied: boolean; files: string[]; conflicts: string[]; cwd: string }) => void;
  /** Desktop's shared native index; undefined requests the ripgrep compatibility path. */
  workspaceSearch?: (operation: 'grep' | 'glob', params: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<ToolResult | undefined>;
  ripgrepPath?: string;
  /** Cancellation for the current turn, inherited by worker tools. */
  abortSignal?: AbortSignal;
  /** Absolute path to the project root */
  cwd: string;
  /** Whether to require user confirmation for destructive operations */
  requireConfirm: boolean;
  /** Callback to ask the user a yes/no question */
  confirm: (message: string) => Promise<boolean>;
  /** Structured desktop approval; receives validated arguments and native call identity. */
  confirmTool?: (name: string, args: Record<string, unknown>, message: string, toolCallId?: string) => Promise<boolean>;
  /** Explicit tool exposure supplied by a desktop agent definition. */
  onlyTools?: string[];
  /** Callback to print status messages to the terminal */
  log: (message: string) => void;
  /** Transient queue status; never added to model conversation history. */
  onQueue?: (message: string | null) => void;
  _fileVersions?: Map<string, string | null>;
  /** Shared per-turn execution guard, including tools invoked from code cells. */
  _executeGuard?: (name: string, args: Record<string,unknown>, execute: () => Promise<ToolResult>) => Promise<ToolResult>;
  /** Permission checker — returns whether a tool call is allowed, denied, or needs prompting */
  checkPermission?: (toolName: string, args: Record<string, unknown>) => PermissionLevel;
  /** Hook runner — fires lifecycle events (pre-tool, post-tool, session-start, etc.) */
  runHook?: (event: string, ctx: Record<string, unknown>) => Promise<void>;
  /** Read cache — prevents redundant file reads within a single turn */
  _readCache?: Map<string, string>;
  /** Maximum shell command timeout override in ms */
  shellTimeout?: number;
  /** Whether dry-run mode is enabled (preview changes without applying) */
  dryRun?: boolean;
  /** Access profile inherited by tools and worker agents. */
  accessMode?: AccessMode;
  /**
   * Opt-in Guardian model — when set, tool calls that would normally prompt
   * are first scored by this independent (smaller) model against the Notch
   * risk taxonomy. Failures silently fall through to the default prompt UX.
   */
  guardianModel?: LanguageModel;
  /**
   * Coordinator mode — when true, the top-level agent is restricted to
   * orchestration tools (agent_spawn / agent_send_message / agent_stop) plus
   * read-only recon (read/grep/glob). All other tools are filtered out so the
   * coordinator is forced to delegate real work to spawned workers.
   */
  coordinatorMode?: boolean;
  /**
   * Model to use when spawning coordinator-mode workers. Optional; if unset,
   * the agent_spawn tool will refuse to run. Set by the CLI entry point when
   * coordinator mode is enabled.
   */
  coordinatorWorkerModel?: LanguageModel;
  /**
   * Permission surface for this execution context. Routes tool-permission
   * checks to the matching handler (interactive / one-shot / coordinator /
   * subagent / auto-mode / json-mode). Defaults to 'interactive' when unset.
   */
  permissionSurface?:
    | 'interactive'
    | 'one-shot'
    | 'coordinator'
    | 'subagent'
    | 'auto-mode'
    | 'json-mode';
  /**
   * Session identifier used by the permission handlers for session-scoped
   * state (e.g. recently-approved prompts in the interactive handler). A
   * stable string is fine; anything unique per REPL process works.
   */
  permissionSessionId?: string;
  /**
   * Subagent identifier — set by spawnSubagent so the subagent handler can
   * include the id in tail notifications.
   */
  subagentId?: string;
  /**
   * When true (e.g. `--yes` on one-shot), the one-shot handler auto-allows
   * base `prompt` outcomes.
   */
  autoConfirm?: boolean;
}
