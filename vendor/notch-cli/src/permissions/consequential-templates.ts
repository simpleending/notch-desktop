/**
 * Notch CLI — Consequential Tool Approval Template Registry
 *
 * Human-readable approval prompts for high-stakes tool calls. Modeled after
 * OpenAI Codex's `consequential_tool_message_templates.json` / `mcp_tool_approval_templates.rs`
 * but simplified for Notch's surface: a JSON registry + tiny extract engine.
 *
 * No eval. All regex patterns are compiled lazily and silently skipped on syntax errors.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import path from 'node:path';
// tsup/esbuild inlines JSON imports at build time; tsconfig has resolveJsonModule.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import registryJson from './consequential-templates.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateMatch {
  /** Only for shell-like tools: match when the `command` arg contains this literal. */
  command_contains?: string;
  /** Only for shell-like tools: match when the `command` arg matches this regex. */
  command_regex?: string;
  /** Match when basename(path-arg) equals this. */
  path_basename?: string;
  /** Match when the `path` arg contains this substring. */
  path_contains?: string;
  /** Match when the `patch` arg contains this substring. */
  patch_contains?: string;
  /** Match when every given arg strictly equals the given value. */
  arg_equals?: Record<string, unknown>;
  /** Match when the named arg contains the given substring. */
  arg_contains?: { arg: string; value: string };
}

export interface TemplateParam {
  /** Variable name that appears as `{name}` in the message. */
  name: string;
  /** Pull the value from a specific tool arg. */
  from_arg?: string;
  /** Pull the value from the tool name itself (only meaningful with regex:). */
  from_tool_name?: boolean;
  /**
   * Extract rule:
   *  - `after:<literal>`        value is the text that follows the literal
   *  - `before:<literal>`       value is the text that precedes the literal
   *  - `regex:<pattern>`        first capture group of the regex
   *  - `exact:<arg-name>`       value is the arg verbatim (the arg-name is only for docs)
   *  - `path-basename:<arg>`    basename of the arg
   */
  extract: string;
}

export interface TemplateEntry {
  /** Exact tool name match. Either this or `tool_name_regex` must be set. */
  tool_name?: string;
  /** Regex tool name match (for `mcp_*_send` style rules). */
  tool_name_regex?: string;
  match?: TemplateMatch;
  message: string;
  template_params?: TemplateParam[];
}

export interface TemplateRegistry {
  schema_version: number;
  templates: TemplateEntry[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let cached: TemplateRegistry | null = null;

/**
 * Load the template registry. The JSON is imported statically (bundled at
 * build time by tsup), so this is a cheap structural cast + cache.
 */
export function loadTemplates(): TemplateEntry[] {
  if (cached) return cached.templates;
  const parsed = registryJson as unknown as TemplateRegistry;
  cached = parsed && Array.isArray(parsed.templates)
    ? parsed
    : { schema_version: 1, templates: [] };
  return cached.templates;
}

/** Reset cache — primarily for tests. */
export function _resetTemplateCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the first template that matches (toolName, args). Returns the rendered
 * message or null if nothing matches. If any `template_params` extract fails,
 * the entry is skipped (don't render `{undefined}`).
 */
export function findTemplate(
  toolName: string,
  args: Record<string, unknown>,
): { message: string } | null {
  const templates = loadTemplates();

  for (const entry of templates) {
    if (!toolNameMatches(entry, toolName)) continue;
    if (!entryMatchesArgs(entry, args)) continue;

    const rendered = renderMessage(entry, toolName, args);
    if (rendered === null) continue; // a param extract failed — try the next entry

    return { message: rendered };
  }

  return null;
}

function toolNameMatches(entry: TemplateEntry, toolName: string): boolean {
  if (entry.tool_name && entry.tool_name === toolName) return true;
  if (entry.tool_name_regex) {
    const re = safeRegex(entry.tool_name_regex);
    if (re && re.test(toolName)) return true;
  }
  return false;
}

function entryMatchesArgs(entry: TemplateEntry, args: Record<string, unknown>): boolean {
  const m = entry.match;
  if (!m) return true;

  if (m.command_contains !== undefined) {
    const cmd = String(args.command ?? '');
    if (!cmd.includes(m.command_contains)) return false;
  }
  if (m.command_regex !== undefined) {
    const cmd = String(args.command ?? '');
    const re = safeRegex(m.command_regex);
    if (!re || !re.test(cmd)) return false;
  }
  if (m.path_basename !== undefined) {
    const p = String(args.path ?? args.file_path ?? '');
    if (!p || path.basename(p) !== m.path_basename) return false;
  }
  if (m.path_contains !== undefined) {
    const p = String(args.path ?? args.file_path ?? '');
    if (!p.includes(m.path_contains)) return false;
  }
  if (m.patch_contains !== undefined) {
    const p = String(args.patch ?? args.diff ?? args.content ?? '');
    if (!p.includes(m.patch_contains)) return false;
  }
  if (m.arg_equals !== undefined) {
    for (const [k, v] of Object.entries(m.arg_equals)) {
      if (String(args[k]) !== String(v)) return false;
    }
  }
  if (m.arg_contains !== undefined) {
    const val = String(args[m.arg_contains.arg] ?? '');
    if (!val.includes(m.arg_contains.value)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Extract engine
// ---------------------------------------------------------------------------

/** Returns the rendered message, or null if any slot failed to extract. */
function renderMessage(
  entry: TemplateEntry,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const slots: Record<string, string> = {};

  for (const param of entry.template_params ?? []) {
    const value = extractValue(param, toolName, args);
    if (value === null) return null;
    slots[param.name] = value;
  }

  // Replace {slot} occurrences. If the message references a slot that wasn't
  // provided, refuse to render (prevents literal "{target}" leaking to users).
  const referenced = new Set<string>();
  const out = entry.message.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name: string) => {
    referenced.add(name);
    if (name in slots) return slots[name]!;
    return `\u0000MISSING:${name}\u0000`;
  });

  if (out.includes('\u0000MISSING:')) return null;
  return out;
}

function extractValue(
  param: TemplateParam,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const source = param.from_tool_name
    ? toolName
    : param.from_arg !== undefined
    ? String(args[param.from_arg] ?? '')
    : '';

  if (!param.extract) return null;

  const colonIdx = param.extract.indexOf(':');
  const kind = colonIdx === -1 ? param.extract : param.extract.slice(0, colonIdx);
  const rest = colonIdx === -1 ? '' : param.extract.slice(colonIdx + 1);

  switch (kind) {
    case 'after': {
      if (!rest) return null;
      const idx = source.indexOf(rest);
      if (idx === -1) return null;
      const tail = source.slice(idx + rest.length).trim();
      return tail.length > 0 ? firstToken(tail) : null;
    }
    case 'before': {
      if (!rest) return null;
      const idx = source.indexOf(rest);
      if (idx <= 0) return null;
      const head = source.slice(0, idx).trim();
      return head.length > 0 ? lastToken(head) : null;
    }
    case 'regex': {
      const re = safeRegex(rest);
      if (!re) return null;
      const m = re.exec(source);
      if (!m) return null;
      const grp = m[1] ?? m[0];
      return grp || null;
    }
    case 'exact': {
      // rest is an arg-name for documentation; the value is `source` already
      if (!source) return null;
      return truncate(source, 120);
    }
    case 'path-basename': {
      if (!source) return null;
      return path.basename(source);
    }
    default:
      return null;
  }
}

function firstToken(s: string): string {
  const m = /^\S+/.exec(s);
  return m ? m[0]! : s.trim();
}

function lastToken(s: string): string {
  const m = /\S+$/.exec(s);
  return m ? m[0]! : s.trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}\u2026`;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch (err) {
    console.warn(`[consequential-templates] invalid regex ${JSON.stringify(pattern)}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Debug / CLI helpers
// ---------------------------------------------------------------------------

/**
 * Render every template with a synthetic example input. Used by
 * `notch --print-approval-templates` for manual review.
 */
export function describeAllTemplates(): string {
  const templates = loadTemplates();
  const lines: string[] = [];
  lines.push(`Notch consequential-tool approval registry (${templates.length} entries)`);
  lines.push('');

  for (const entry of templates) {
    const toolLabel = entry.tool_name ?? `re:${entry.tool_name_regex ?? '?'}`;
    lines.push(`• [${toolLabel}] ${entry.message}`);

    const example = buildExample(entry);
    const exampleTool = entry.tool_name ?? exampleToolFor(entry.tool_name_regex ?? '');
    const rendered = exampleTool ? findTemplate(exampleTool, example) : null;
    if (rendered) {
      lines.push(`    example: ${rendered.message}`);
    } else {
      lines.push(`    example: (no extract could be built — literal message only)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildExample(entry: TemplateEntry): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const m = entry.match ?? {};
  if (m.command_contains) {
    args.command = `${m.command_contains} /tmp/example`;
  } else if (m.command_regex) {
    args.command = 'git push origin main';
  }
  if (m.path_basename) args.path = `/work/${m.path_basename}`;
  if (m.path_contains) args.path = `/work${m.path_contains}example`;
  if (m.patch_contains) args.patch = `--- a/${m.patch_contains}\n+++ b/${m.patch_contains}\n`;
  if (m.arg_equals) {
    for (const [k, v] of Object.entries(m.arg_equals)) args[k] = v;
  }
  if (m.arg_contains) args[m.arg_contains.arg] = `https://${m.arg_contains.value}/example`;

  // Fill defaults for common referenced slots so examples render.
  for (const p of entry.template_params ?? []) {
    if (p.from_arg && args[p.from_arg] === undefined) {
      args[p.from_arg] = `example-${p.name}`;
    }
  }

  return args;
}

function exampleToolFor(regex: string): string | null {
  // Convert a few common regex shapes into a concrete tool name for examples.
  if (!regex) return null;
  if (regex.includes('_send')) return 'mcp_slack_send';
  if (regex.includes('_post')) return 'mcp_discord_post';
  if (regex.includes('_create_')) return 'mcp_linear_create_issue';
  if (regex.includes('_delete_')) return 'mcp_linear_delete_issue';
  if (regex.includes('_update_')) return 'mcp_linear_update_issue';
  if (regex.includes('email')) return 'mcp_email_send_message';
  if (regex.includes('slack')) return 'mcp_slack_list_channels';
  return null;
}
