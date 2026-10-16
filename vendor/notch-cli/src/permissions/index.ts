/**
 * Notch CLI — Permission System
 *
 * Granular per-tool permission control. Supports auto-allow, prompt,
 * and deny modes per tool. Persisted in .notch.json or ~/.notch/permissions.json.
 *
 * Adds cross-tool deny-read and deny-write glob policies (Codex pattern)
 * that block access to sensitive paths regardless of which tool attempted
 * them. deny-read globs override any tool-level allow rule — a `read`
 * approval for `.env` still denies.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { minimatch } from 'minimatch';

export type PermissionLevel = 'allow' | 'prompt' | 'deny';

export interface PermissionRule {
  tool: string;
  level: PermissionLevel;
  /** Optional pattern — e.g., only allow shell commands matching this */
  pattern?: string;
}

export interface PermissionConfig {
  /** Default permission for tools not explicitly configured */
  default: PermissionLevel;
  /** Per-tool overrides */
  rules: PermissionRule[];
  /**
   * Glob patterns (gitignore-style) that deny READ access to matching
   * paths for ANY tool, overriding per-tool allow rules. Applied to any
   * tool whose args carry a path-like argument or shell command that
   * reads matching paths.
   */
  denyReadGlobs?: string[];
  /**
   * Glob patterns that deny WRITE access to matching paths for any tool.
   * Covers write/edit/apply_patch plus shell commands that mutate files.
   */
  denyWriteGlobs?: string[];
}

/**
 * Conservative default deny-read set. Protects credentials, private keys,
 * and cloud provider config — things agents should never exfiltrate by
 * accident. Users can remove entries in `.notch.json` if they need the
 * agent to see them (rare — usually a smell).
 */
export const DEFAULT_DENY_READ_GLOBS: readonly string[] = Object.freeze([
  '**/.env',
  '**/.env.*',
  '!**/.env.example',
  '!**/.env.sample',
  '**/*.key',
  '**/*.pem',
  '**/id_rsa',
  '**/id_rsa.*',
  '**/id_ed25519',
  '**/id_ed25519.*',
  '**/id_ecdsa',
  '**/id_ecdsa.*',
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.aws/config',
  '**/.gcp/**',
  '**/credentials.json',
  '**/secrets.json',
  '**/*.keystore',
  '**/*.jks',
  '**/*.p12',
  '**/*.pfx',
  '**/.git/config',
  '**/.git/hooks/**',
]);

/**
 * Conservative default deny-write set. Protects git internals and CI
 * config from accidental overwrites during agent work.
 */
export const DEFAULT_DENY_WRITE_GLOBS: readonly string[] = Object.freeze([
  '**/.git/**',
  '!**/.git/info/exclude', // a file users legitimately edit
]);

const DEFAULT_PERMISSIONS: PermissionConfig = {
  default: 'prompt',
  rules: [
    // Safe read-only tools auto-allowed
    { tool: 'read', level: 'allow' },
    { tool: 'task_changes', level: 'allow' },
    { tool: 'grep', level: 'allow' },
    { tool: 'glob', level: 'allow' },
    { tool: 'web_fetch', level: 'allow' },
    { tool: 'web_search', level: 'allow' },
    { tool: 'browser_read', level: 'allow' },
    { tool: 'browser_interact', level: 'prompt' },
    // Write tools prompt by default
    { tool: 'write', level: 'prompt' },
    { tool: 'edit', level: 'prompt' },
    { tool: 'shell', level: 'prompt' },
    { tool: 'git', level: 'prompt' },
  ],
  denyReadGlobs: [...DEFAULT_DENY_READ_GLOBS],
  denyWriteGlobs: [...DEFAULT_DENY_WRITE_GLOBS],
};

/**
 * Load permissions from project config or global config.
 */
export async function loadPermissions(projectRoot: string): Promise<PermissionConfig> {
  // Try project-level first
  const projectPath = path.join(projectRoot, '.notch.json');
  const globalPath = path.join(os.homedir(), '.notch', 'permissions.json');

  let config = { ...DEFAULT_PERMISSIONS };

  // Load global permissions
  try {
    const raw = await fs.readFile(globalPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.permissions) {
      config = mergePermissions(config, parsed.permissions);
    }
  } catch {
    // No global permissions
  }

  // Load project permissions (override global)
  try {
    const raw = await fs.readFile(projectPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.permissions) {
      config = mergePermissions(config, parsed.permissions);
    }
  } catch {
    // No project permissions
  }

  return config;
}

// ---------------------------------------------------------------------------
// Path extraction & glob matching for deny-read/deny-write policies
// ---------------------------------------------------------------------------

/**
 * Tool-name → classifier for what kind of path access the tool performs.
 * 'read' tools match deny-read globs; 'write' tools match deny-write (and
 * implicitly read, since most write tools read-then-write). Tools that
 * don't touch the filesystem directly (web_fetch, agent_spawn, etc.) aren't
 * in this map and are unaffected by deny-glob checks.
 */
const TOOL_PATH_ACCESS: Record<string, 'read' | 'write' | 'both'> = {
  task_changes: 'read',
  read: 'read',
  grep: 'read',
  glob: 'read',
  notebook: 'both',
  write: 'write',
  edit: 'both',
  apply_patch: 'both',
  applypatch: 'both',
  diff_preview: 'read',
  diffpreview: 'read',
  // Shell-like tools can read or write — check both deny sets. Path
  // extraction below scrapes literal tokens from the command string.
  shell: 'both',
  bash: 'both',
  git: 'both',
};

/** Paths an arg object refers to, used for glob-based deny checks. */
function extractPathsFromArgs(toolName: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const t = toolName.toLowerCase().replace(/-/g, '_');

  // Common arg keys across Notch tools
  const COMMON_PATH_KEYS = ['path', 'file', 'file_path', 'filePath', 'target', 'input', 'output'];
  for (const k of COMMON_PATH_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }

  // shell/git: scrape literal-looking file tokens from the command string.
  // Intentionally conservative — if we can't cleanly parse, we don't guess.
  if ((t === 'shell' || t === 'bash' || t === 'git') && typeof args.command === 'string') {
    const cmd = args.command as string;
    // Grab tokens that look like paths (contain '/' or '.') and aren't flags
    const tokens = cmd.split(/\s+/).filter((tok) => {
      if (tok.startsWith('-')) return false;
      if (tok.startsWith('"') || tok.startsWith("'")) tok = tok.slice(1);
      return /[./]/.test(tok);
    });
    out.push(...tokens);
  }

  // edit / apply_patch sometimes carry a 'patch' or 'diff' field that
  // references files — parse the --- / +++ lines.
  if (typeof args.patch === 'string') {
    for (const line of (args.patch as string).split('\n')) {
      const m = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)/);
      if (m && m[1] !== '/dev/null') out.push(m[1]!);
    }
  }

  return out;
}

/**
 * Match one candidate path against a list of gitignore-style globs.
 * Supports negation (lines starting with `!`) so a narrow allowlist can
 * carve exceptions out of a broad deny (e.g. a negated `.env.example`).
 */
export function matchesAnyGlob(candidate: string, patterns: readonly string[]): boolean {
  // Normalize: backslash → slash, strip leading `./`.
  let normalized = candidate.replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  const basename = normalized.split('/').pop() ?? normalized;

  let matched = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const pat = negate ? raw.slice(1) : raw;
    const hasSlash = pat.includes('/');

    // Try multiple strategies — the goal is "is this path covered by this
    // pattern?" and minimatch's default semantics are strict about things
    // like `**/` requiring at least one directory.
    let hit = false;
    // (1) full path against pattern, with matchBase when pattern is bare.
    if (minimatch(normalized, pat, { dot: true, matchBase: !hasSlash })) hit = true;
    // (2) `**/X` also matches bare `X` at the root.
    if (!hit && pat.startsWith('**/')) {
      if (minimatch(basename, pat.slice(3), { dot: true })) hit = true;
    }
    // (3) Basename against pattern — safety net for patterns that look
    //     anchored but are really about a filename (`.env.production` etc).
    if (!hit && minimatch(basename, pat, { dot: true })) hit = true;

    if (hit) matched = !negate;
  }
  return matched;
}

/**
 * Check if a tool call is allowed.
 * Returns the permission level for the given tool.
 *
 * Deny-read and deny-write glob policies override per-tool rules: a path
 * that hits `denyReadGlobs` is denied even if the tool is in the allow list.
 */
export function checkPermission(
  config: PermissionConfig,
  toolName: string,
  args?: Record<string, unknown>,
): PermissionLevel {
  // ---- Deny-glob pre-check (hard override) --------------------------------
  const access = TOOL_PATH_ACCESS[toolName.toLowerCase().replace(/-/g, '_')];
  if (access && args) {
    const paths = extractPathsFromArgs(toolName, args);
    if (paths.length > 0) {
      const denyRead = config.denyReadGlobs ?? [];
      const denyWrite = config.denyWriteGlobs ?? [];
      const checkRead = access === 'read' || access === 'both';
      const checkWrite = access === 'write' || access === 'both';

      for (const p of paths) {
        if (checkRead && denyRead.length > 0 && matchesAnyGlob(p, denyRead)) {
          return 'deny';
        }
        if (checkWrite && denyWrite.length > 0 && matchesAnyGlob(p, denyWrite)) {
          return 'deny';
        }
      }
    }
  }

  // ---- Per-tool rule lookup (existing behavior) ---------------------------
  // Find matching rule (most specific first)
  const rule = config.rules.find((r) => {
    if (r.tool !== toolName) return false;
    if (r.pattern && args) {
      // Check if any arg value matches the pattern
      const pat = new RegExp(r.pattern);
      return Object.values(args).some((v) => pat.test(String(v)));
    }
    return true;
  });

  return rule?.level ?? config.default;
}

/**
 * Save permissions to the global config.
 */
export async function savePermissions(permissions: PermissionConfig): Promise<void> {
  const dir = path.join(os.homedir(), '.notch');
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, 'permissions.json');
  await fs.writeFile(filePath, JSON.stringify({ permissions }, null, 2), 'utf-8');
}

/**
 * Format permissions for display.
 */
export function formatPermissions(config: PermissionConfig): string {
  const lines = [`Default: ${config.default}`, ''];
  for (const rule of config.rules) {
    const icon = rule.level === 'allow' ? '\u2713' : rule.level === 'deny' ? '\u2717' : '?';
    const pattern = rule.pattern ? ` (${rule.pattern})` : '';
    lines.push(`  ${icon} ${rule.tool.padEnd(12)} ${rule.level}${pattern}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-surface handler dispatcher re-exports
// ---------------------------------------------------------------------------

export {
  runPermissionCheck,
  getActiveHandler,
  recordAutoModeDenial,
  drainTailNotifications,
  pushTailNotification,
  setCurrentSurface,
  getCurrentSurface,
  createHandlerContext,
} from './dispatcher.js';

export type {
  Surface,
  PermissionOutcome,
  PermissionDecision,
  PermissionHandler,
  HandlerContext,
} from './handlers/types.js';

export { classifyBashCommand, classifierPatternCount } from './handlers/bash-classifier.js';
export { recordInteractiveApproval, clearInteractiveApprovals } from './handlers/interactive.js';

function mergePermissions(base: PermissionConfig, override: Partial<PermissionConfig>): PermissionConfig {
  const merged: PermissionConfig = {
    ...base,
    denyReadGlobs: base.denyReadGlobs ? [...base.denyReadGlobs] : undefined,
    denyWriteGlobs: base.denyWriteGlobs ? [...base.denyWriteGlobs] : undefined,
  };
  if (override.default) merged.default = override.default;
  if (override.rules) {
    // Override rules replace matching tool rules
    for (const rule of override.rules) {
      const idx = merged.rules.findIndex((r) => r.tool === rule.tool && r.pattern === rule.pattern);
      if (idx >= 0) {
        merged.rules[idx] = rule;
      } else {
        merged.rules.push(rule);
      }
    }
  }
  // Deny-globs MERGE (user adds more patterns on top of defaults) rather
  // than replace. Users who genuinely want to loosen defaults can add a
  // negation entry (e.g. `!**/.env.test`) — loosening by omission would be
  // a footgun.
  if (override.denyReadGlobs) {
    const existing = new Set(merged.denyReadGlobs ?? []);
    for (const g of override.denyReadGlobs) existing.add(g);
    merged.denyReadGlobs = [...existing];
  }
  if (override.denyWriteGlobs) {
    const existing = new Set(merged.denyWriteGlobs ?? []);
    for (const g of override.denyWriteGlobs) existing.add(g);
    merged.denyWriteGlobs = [...existing];
  }
  return merged;
}
