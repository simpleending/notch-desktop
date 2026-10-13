/**
 * Notch CLI — Hooks System
 *
 * Event-driven hook system that executes user-configured shell commands
 * in response to CLI events. Configured in .notch.json or ~/.notch/hooks.json.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pluginManager } from '../plugins/index.js';

export type HookEvent =
  | 'pre-tool'            // Before any tool executes
  | 'post-tool'           // After any tool executes
  | 'pre-edit'            // Before file edit/write
  | 'post-edit'           // After file edit/write
  | 'pre-commit'          // Before git commit
  | 'post-commit'         // After git commit
  | 'session-start'       // When REPL starts
  | 'session-end'         // When REPL exits
  | 'on-error'            // When an error occurs
  | 'file-changed'        // When a watched file changes on disk
  | 'cwd-changed'         // When working directory changes
  | 'config-change'       // When .notch.json is modified
  | 'pre-compact'         // Before context compression
  | 'post-compact'        // After context compression
  | 'permission-request'  // When a permission check is about to run
  | 'permission-denied';  // When a tool call is denied by permissions

export interface Hook {
  event: HookEvent;
  command: string;
  /** Optional: only trigger for specific tool names */
  tool?: string;
  /** Optional: only trigger for files matching this pattern */
  pattern?: string;
  /** Timeout in ms (default 10s) */
  timeout?: number;
}

export interface HookConfig {
  hooks: Hook[];
}

/**
 * Load hooks from project and global config.
 */
/** Path to the trust store — records fingerprints of trusted project configs. */
const TRUST_STORE_PATH = path.join(os.homedir(), '.notch', 'trusted-projects.json');

async function isTrustedProject(projectRoot: string, raw: string): Promise<boolean> {
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  const key = path.resolve(projectRoot);
  try {
    const store = JSON.parse(await fs.readFile(TRUST_STORE_PATH, 'utf-8'));
    return store[key] === fingerprint;
  } catch {
    return false;
  }
}

async function trustProject(projectRoot: string, raw: string): Promise<void> {
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  const key = path.resolve(projectRoot);
  let store: Record<string, string> = {};
  try { store = JSON.parse(await fs.readFile(TRUST_STORE_PATH, 'utf-8')); } catch { /* first run */ }
  store[key] = fingerprint;
  await fs.mkdir(path.dirname(TRUST_STORE_PATH), { recursive: true });
  await fs.writeFile(TRUST_STORE_PATH, JSON.stringify(store, null, 2));
}

export async function loadHooks(
  projectRoot: string,
  /** Prompt callback — called when project hooks need trust confirmation. Return true to allow. */
  promptTrust?: (commands: string[]) => Promise<boolean>,
): Promise<HookConfig> {
  const hooks: Hook[] = [];

  // Global hooks (trusted — user wrote these themselves)
  const globalPath = path.join(os.homedir(), '.notch', 'hooks.json');
  try {
    const raw = await fs.readFile(globalPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.hooks)) {
      hooks.push(...parsed.hooks);
    }
  } catch {
    // No global hooks
  }

  // Project hooks from .notch.json — may come from an untrusted cloned repo
  const projectPath = path.join(projectRoot, '.notch.json');
  try {
    const raw = await fs.readFile(projectPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.hooks) && parsed.hooks.length > 0) {
      const alreadyTrusted = await isTrustedProject(projectRoot, raw);
      if (!alreadyTrusted) {
        const commands = (parsed.hooks as Hook[]).map((h) => h.command);
        const allowed = promptTrust ? await promptTrust(commands) : false;
        if (!allowed) {
          console.warn('[notch] Project hooks skipped — not trusted. Run with --trust-hooks to allow.');
        } else {
          await trustProject(projectRoot, raw);
          hooks.push(...parsed.hooks);
        }
      } else {
        hooks.push(...parsed.hooks);
      }
    }
  } catch {
    // No project hooks
  }

  return { hooks };
}

/**
 * Execute all hooks matching the given event.
 */
export async function runHooks(
  config: HookConfig,
  event: HookEvent,
  context: {
    cwd: string;
    tool?: string;
    file?: string;
    args?: Record<string, unknown>;
    error?: string;
  },
): Promise<{ results: HookResult[] }> {
  // Combine config hooks with plugin hooks
  const allHooks = [...config.hooks, ...pluginManager.getHooks()];

  const matching = allHooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.tool && h.tool !== context.tool) return false;
    if (h.pattern && context.file && !context.file.includes(h.pattern)) return false;
    return true;
  });

  const results: HookResult[] = [];

  for (const hook of matching) {
    const result = await executeHook(hook, context);
    results.push(result);

    // If a hook fails, stop executing remaining hooks for this event
    if (!result.ok) break;
  }

  return { results };
}

export interface HookResult {
  hook: Hook;
  ok: boolean;
  output: string;
  error?: string;
}

async function executeHook(
  hook: Hook,
  context: { cwd: string; tool?: string; file?: string; args?: Record<string, unknown>; error?: string },
): Promise<HookResult> {
  // Build a safe environment for hook execution.
  // Explicitly exclude sensitive credentials — hooks are user-configured shell
  // commands that may be sourced from untrusted .notch.json files in cloned repos.
  const BLOCKED_ENV_KEYS = new Set([
    'NOTCH_API_KEY', 'NOTCH_BASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  ]);
  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !BLOCKED_ENV_KEYS.has(k)) {
      safeEnv[k] = v;
    }
  }
  const env: Record<string, string> = {
    ...safeEnv,
    NOTCH_EVENT: hook.event,
    NOTCH_TOOL: context.tool ?? '',
    NOTCH_FILE: context.file ?? '',
    NOTCH_ERROR: context.error ?? '',
    NOTCH_CWD: context.cwd,
  };

  try {
    const output = execSync(hook.command, {
      cwd: context.cwd,
      encoding: 'utf-8',
      timeout: hook.timeout ?? 10_000,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { hook, ok: true, output: output.trim() };
  } catch (err: any) {
    return {
      hook,
      ok: false,
      output: err.stdout?.toString() ?? '',
      error: err.stderr?.toString() ?? err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// File Watcher — fires 'file-changed' and 'config-change' hook events
// ---------------------------------------------------------------------------

/**
 * Start a file watcher on the project root.
 * Fires `file-changed` for any file modification and `config-change` when
 * `.notch.json` is modified. Events are debounced to avoid flooding.
 *
 * Returns a cleanup function to stop watching.
 */
export function startFileWatcher(
  projectRoot: string,
  hookConfig: HookConfig,
  onHookResult?: (event: HookEvent, results: HookResult[]) => void,
): () => void {
  // Do not recursively watch entire repositories without an event consumer.
  // Besides startup overhead, an unused watcher keeps headless processes alive.
  const needsWatcher = [...hookConfig.hooks, ...pluginManager.getHooks()]
    .some(hook => hook.event === 'file-changed' || hook.event === 'config-change');
  if (!needsWatcher) return () => {};
  const debounceMs = 150;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(projectRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // Ignore common noisy paths
      if (
        filename.startsWith('.git/') || filename.startsWith('.git\\') ||
        filename.includes('node_modules') ||
        filename.startsWith('dist/') || filename.startsWith('dist\\')
      ) return;

      // Debounce per file
      const existing = pending.get(filename);
      if (existing) clearTimeout(existing);

      pending.set(filename, setTimeout(async () => {
        pending.delete(filename);

        const filePath = path.join(projectRoot, filename);
        const context = { cwd: projectRoot, file: filePath };

        // Fire file-changed
        const { results } = await runHooks(hookConfig, 'file-changed', context);
        onHookResult?.('file-changed', results);

        // Fire config-change if it's the .notch.json file
        if (filename === '.notch.json') {
          const { results: cfgResults } = await runHooks(hookConfig, 'config-change', context);
          onHookResult?.('config-change', cfgResults);
        }
      }, debounceMs));
    });
  } catch {
    // fs.watch may not be available on all platforms or for recursive watching
  }

  return () => {
    watcher?.close();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}
