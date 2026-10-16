import type { PermissionConfig, PermissionLevel } from './index.js';
import { checkPermission } from './index.js';

/** Shared by the CLI and future IDE; approval policy is distinct from OS isolation. */
export const ACCESS_MODES = ['approve', 'read-only', 'full-access'] as const;
export type AccessMode = typeof ACCESS_MODES[number];
const READ_TOOLS = new Set(['read', 'task_changes', 'grep', 'glob', 'web_fetch', 'web_search']);

export function parseAccessMode(value: unknown): AccessMode {
  if (typeof value !== 'string' || !ACCESS_MODES.includes(value as AccessMode)) {
    throw new Error(`Invalid access mode ${JSON.stringify(value)}. Choose ${ACCESS_MODES.join(', ')}.`);
  }
  return value as AccessMode;
}

export function checkAccess(mode: AccessMode, permissions: PermissionConfig, tool: string, args: Record<string, unknown>): PermissionLevel {
  if (mode === 'full-access') return 'allow';
  const base = checkPermission(permissions, tool, args);
  if (base === 'deny') return 'deny';
  if (mode === 'read-only') return READ_TOOLS.has(tool) ? 'allow' : 'deny';
  return base;
}

/** Unknown/MCP/plugin tools cannot establish that they are safe just by their name. */
export function isBuiltInReadTool(tool: string, builtin: boolean): boolean {
  return builtin && READ_TOOLS.has(tool);
}
