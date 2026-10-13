/**
 * Notch CLI — Policy Clause Matchers
 *
 * Per-kind predicate implementations for every `MatchClause` variant in
 * policy-dsl.ts. Every matcher follows the same contract:
 *
 *   (args, clause) => boolean
 *
 * and NEVER throws. A malformed clause, missing arg, or runtime error
 * resolves to `false` ("clause does not match") rather than rejecting the
 * whole evaluation. That way a typo'd regex in one rule can't lock the
 * user out of every other rule.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { MatchClause } from './policy-dsl.js';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** One-time warning tracker so we don't spam logs on repeated lookups. */
const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[notch/policy] ${message}`);
}

/** Read an arg as a string; returns undefined if missing or wrong type. */
function argString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Expand `~`, `$HOME`, and any other `process.env.X` references in a path
 * string. Returns the expanded string unchanged if no expansion applies.
 */
function expandHome(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (full, name) => {
    const v = process.env[name];
    return typeof v === 'string' ? v : full;
  });
  return out;
}

/** Resolve to absolute + realpath-if-exists; lexical fallback otherwise. */
function resolveLike(p: string): string {
  const abs = path.resolve(expandHome(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Tokenize a shell command on whitespace (simple — quotes are preserved). */
function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Safe regex compile. Returns undefined on syntax error. */
function safeRegex(pattern: string, flags?: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

function matchArgEquals(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'arg_equals' }>,
): boolean {
  const v = args[clause.arg];
  if (v === undefined) return false;
  // Strict equality on primitive types.
  if (typeof v === typeof clause.value) return v === clause.value;
  return String(v) === String(clause.value);
}

function matchArgContains(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'arg_contains' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  return s.includes(clause.value);
}

function matchArgPrefix(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'arg_prefix' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  return s.startsWith(clause.value);
}

function matchArgRegex(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'arg_regex' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  const re = safeRegex(clause.pattern, clause.flags);
  if (!re) return false;
  try {
    return re.test(s);
  } catch {
    return false;
  }
}

function matchCommandPrefix(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'command_prefix' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  const tokens = tokenizeCommand(s);
  const wantTokens = tokenizeCommand(clause.value);
  if (wantTokens.length === 0) return false;
  if (tokens.length < wantTokens.length) return false;
  for (let i = 0; i < wantTokens.length; i++) {
    if (tokens[i] !== wantTokens[i]) return false;
  }
  return true;
}

function matchCommandWord(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'command_word' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  const tokens = tokenizeCommand(s);
  return tokens.includes(clause.value);
}

function matchPathUnder(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'path_under' }>,
): boolean {
  const p = argString(args, clause.arg);
  if (p === undefined) return false;
  try {
    const resolvedArg = resolveLike(p);
    const resolvedRoot = resolveLike(clause.root);
    const rel = path.relative(resolvedRoot, resolvedArg);
    // Under root iff rel doesn't start with `..` and isn't absolute.
    if (rel === '') return true;
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
  } catch {
    return false;
  }
}

function matchPathBasename(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'path_basename' }>,
): boolean {
  const p = argString(args, clause.arg);
  if (p === undefined) return false;
  try {
    return path.basename(p) === clause.value;
  } catch {
    return false;
  }
}

/**
 * `host_executable` matches when the tool-arg's first shell token is the
 * named executable. If `allowed_paths` is provided, we additionally try to
 * resolve the executable via PATH (best-effort, sync `fs.existsSync`) and
 * require the resolved absolute path to be under one of the allowed
 * roots. On resolution failure, the rule "does not match" (returns false)
 * so the user is never locked out by a missing binary.
 */
function matchHostExecutable(
  args: Record<string, unknown>,
  clause: Extract<MatchClause, { kind: 'host_executable' }>,
): boolean {
  const s = argString(args, clause.arg);
  if (s === undefined) return false;
  const tokens = tokenizeCommand(s);
  if (tokens.length === 0) return false;
  const first = tokens[0]!;
  const firstBase = path.basename(first);
  if (firstBase !== clause.name) return false;

  // Bare name — no path component.
  if (!first.includes('/') && !first.includes('\\')) {
    if (!clause.allowed_paths || clause.allowed_paths.length === 0) return true;
    // Try to resolve via PATH; if we can't, warn once and return false.
    const resolved = resolveExecutable(clause.name);
    if (!resolved) {
      warnOnce(
        `host_exec_${clause.name}`,
        `host_executable: could not resolve '${clause.name}' on PATH; rule skipped`,
      );
      return false;
    }
    const resolvedReal = resolveLike(resolved);
    return clause.allowed_paths.some((root) => {
      try {
        const rel = path.relative(resolveLike(root), resolvedReal);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      } catch {
        return false;
      }
    });
  }

  // Absolute / relative-path form — check allowed_paths against it directly.
  if (!clause.allowed_paths || clause.allowed_paths.length === 0) return true;
  const resolvedReal = resolveLike(first);
  return clause.allowed_paths.some((root) => {
    try {
      const rel = path.relative(resolveLike(root), resolvedReal);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  });
}

/**
 * Resolve an executable name against PATH. Synchronous best-effort lookup
 * — returns the first existing candidate or undefined. Silent on all
 * errors.
 */
function resolveExecutable(name: string): string | undefined {
  const PATH = process.env.PATH ?? '';
  const PATHEXT = (process.env.PATHEXT ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' && PATHEXT.length > 0 ? ['', ...PATHEXT] : [''];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

/**
 * Evaluate a single clause. Returns false on any failure — matchers never
 * throw.
 */
export function evaluateClause(
  args: Record<string, unknown>,
  clause: MatchClause,
): boolean {
  try {
    switch (clause.kind) {
      case 'arg_equals':
        return matchArgEquals(args, clause);
      case 'arg_contains':
        return matchArgContains(args, clause);
      case 'arg_prefix':
        return matchArgPrefix(args, clause);
      case 'arg_regex':
        return matchArgRegex(args, clause);
      case 'command_prefix':
        return matchCommandPrefix(args, clause);
      case 'command_word':
        return matchCommandWord(args, clause);
      case 'path_under':
        return matchPathUnder(args, clause);
      case 'path_basename':
        return matchPathBasename(args, clause);
      case 'host_executable':
        return matchHostExecutable(args, clause);
      default: {
        // Unknown kind — future-proof fail-closed at rule level, fail-open
        // at clause level: return false so rules don't spuriously fire.
        const _exhaustive: never = clause;
        void _exhaustive;
        return false;
      }
    }
  } catch {
    return false;
  }
}

/**
 * Clear the one-time warning tracker. Used by tests.
 */
export function _resetClauseWarnings(): void {
  warnedOnce.clear();
}
