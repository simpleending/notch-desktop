/**
 * Notch CLI — Shell Tool
 *
 * Execute shell commands with safety classification and async execution.
 *
 * Security layers:
 * 1. Blocked patterns — absolutely forbidden commands (fork bombs, disk wipe)
 * 2. Pipe chain validation — catches attempts to bypass via piping
 * 3. Path traversal detection — blocks commands targeting outside project root
 * 4. Environment variable protection — strips dangerous env overrides
 * 5. Destructive command confirmation — warns before rm -rf, force push, etc.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import path from 'node:path';
import { z } from 'zod';
import type { NotchTool, ToolResult } from './types.js';
import { LocalTerminal } from '../terminal/local.js';
const terminal = new LocalTerminal();

// ---------------------------------------------------------------------------
// Security patterns
// ---------------------------------------------------------------------------

/** Absolutely blocked — never execute these under any circumstances */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,            // rm -rf /
  /mkfs\./,                          // format filesystem
  /dd\s+if=.*of=\/dev/,             // raw disk write
  /:\(\)\s*\{.*:\|:.*\}/,           // fork bomb
  /chmod\s+-R\s+777\s+\//,          // recursive chmod on root
  /curl\s.*\|\s*(?:ba)?sh/,         // curl | sh (remote code execution)
  /wget\s.*\|\s*(?:ba)?sh/,         // wget | sh
  />\s*\/dev\/sd[a-z]/,             // overwrite disk device
  /shutdown|reboot|init\s+[06]/,    // system shutdown/reboot
  /rm\s+-rf\s+~\//,                 // rm -rf ~/
];

/** Destructive but sometimes necessary — require user confirmation */
const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf/,
  /rm\s+-r\s/,
  /git\s+push\s+--force(?!\s+--with-lease)/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-f/,
  /git\s+checkout\s+--\s*\./,
  /DROP\s+(TABLE|DATABASE)/i,
  /TRUNCATE/i,
  />\s*\/dev\/sd/,
  /docker\s+(rm|rmi|system\s+prune)/,
  /kubectl\s+delete/,
  /npm\s+unpublish/,
];

/** Environment variables that should never be overridden via command */
const BLOCKED_ENV_PATTERNS = [
  /\bLD_PRELOAD=/,
  /\bLD_LIBRARY_PATH=/,
  /\bDYLD_INSERT_LIBRARIES=/,
  /\bPATH=\//,         // Setting PATH to absolute (could shadow binaries)
  /\bHOME=\//,
  /\bSHELL=/,
];

const MAX_OUTPUT = 50_000; // characters
const DEFAULT_TIMEOUT = 30_000; // 30s
const MAX_TIMEOUT = 600_000; // 10 minutes

const parameters = z.object({
  command: z.string().describe('Shell command to execute'),
  timeout: z.number().optional().describe('Timeout in ms (default 30s, max 10m)'),
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate command against all security layers.
 * Returns null if safe, or an error message if blocked.
 */
function validateCommand(command: string, cwd: string): string | null {
  // Layer 1: Absolute blocks
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: this command is too dangerous to execute.`;
    }
  }

  // Layer 2: Env variable injection
  for (const pattern of BLOCKED_ENV_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: command attempts to override a protected environment variable.`;
    }
  }

  // Layer 3: Pipe chain analysis — check each segment of piped commands
  const pipeSegments = command.split(/\s*\|\s*/);
  for (const segment of pipeSegments) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(segment.trim())) {
        return `Blocked: a pipe segment contains a dangerous command.`;
      }
    }
  }

  // Also check command substitution: $(cmd) and `cmd`
  const subCommands = [
    ...command.matchAll(/\$\(([^)]+)\)/g),
    ...command.matchAll(/`([^`]+)`/g),
  ];
  for (const match of subCommands) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(match[1]!)) {
        return `Blocked: command substitution contains a dangerous command.`;
      }
    }
  }

  // Layer 4: Path traversal — block commands targeting outside project root or /tmp
  const fileOpRegex = /(?:^|\s)(?:>|>>|cat|cp|mv|ln|tee|tar|zip|scp|rsync|chmod|chown|rm)\s+(\/(?!tmp\b|dev\/null\b)[^\s]+)/g;
  let match;
  while ((match = fileOpRegex.exec(command)) !== null) {
    const targetPath = path.normalize(match[1]!);
    if (!targetPath.startsWith(cwd) && !targetPath.startsWith('/tmp')) {
      return `Blocked: command targets path outside project root: ${targetPath}`;
    }
  }

  // Layer 5: Deep path traversal
  if (/(?:^|\s)(?:\.\.\/){3,}/.test(command)) {
    return 'Blocked: deep path traversal detected.';
  }

  return null;
}

/**
 * Check if command is destructive (needs confirmation).
 */
function isDestructive(command: string): boolean {
  // Check main command and all pipe segments
  const segments = [command, ...command.split(/\s*\|\s*/)];
  for (const segment of segments) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(segment)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const shellTool: NotchTool<typeof parameters> = {
  name: 'shell',
  description:
    'Execute a shell command in the project directory. ' +
    'Dangerous commands (rm -rf, DROP TABLE, git push --force) require confirmation. ' +
    'Some destructive system commands are blocked entirely.',
  parameters,
  async execute(params, ctx): Promise<ToolResult> {
    const { command } = params;
    const maxTimeout = ctx.shellTimeout ?? MAX_TIMEOUT;
    const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, maxTimeout);

    // Security validation
    const validationError = validateCommand(command, ctx.cwd);
    if (validationError) {
      return { content: validationError, isError: true };
    }

    // Destructive command confirmation
    if (ctx.requireConfirm && isDestructive(command)) {
      const confirmed = await ctx.confirm(
        `\u26a0 Destructive command: ${command}\nProceed?`
      );
      if (!confirmed) {
        return { content: 'Command cancelled by user.', isError: true };
      }
    }

    try {
      const result = await terminal.run({
        command, cwd: ctx.cwd, timeoutMs: timeout, maxOutputChars: MAX_OUTPUT,
        signal: ctx.abortSignal, env: { FORCE_COLOR: '0' },
      });
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const trimmed = combined.length > MAX_OUTPUT ? combined.slice(0, MAX_OUTPUT) : combined;
      const suffix = result.truncated || combined.length > MAX_OUTPUT ? '\n... (truncated)' : '';
      return {
        content: result.exitCode === 0 ? (trimmed || '(no output)') + suffix
          : `Command failed (exit ${result.exitCode ?? 'cancelled/timeout'}):\n${trimmed || '(no output)'}${suffix}`,
        ...(result.exitCode !== 0 ? { isError: true } : {}),
      };
    } catch (error) {
      return { content: `Command failed: ${(error as Error).message}`, isError: true };
    }
  },
};
