/**
 * Notch CLI — @file and @url Reference Resolver
 *
 * Parses user input for @file and @url references and injects
 * their contents into the prompt. Similar to how Claude Code handles
 * file context injection.
 *
 * Syntax:
 *   @path/to/file.ts      — inject file contents
 *   @https://example.com  — fetch and inject URL contents
 *   @*.ts                 — inject all matching files (glob)
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

export interface ResolvedReference {
  type: 'file' | 'url' | 'glob';
  original: string;
  resolved: string;
  content: string;
  error?: string;
}

/**
 * Extract @references from user input and resolve them.
 * Returns the cleaned input (without @refs) and the resolved references.
 */
export async function resolveReferences(
  input: string,
  cwd: string,
): Promise<{ cleanInput: string; references: ResolvedReference[] }> {
  const references: ResolvedReference[] = [];

  // Match @references (not preceded by letter/digit, not inside backticks)
  const refPattern = /@((?:https?:\/\/\S+)|(?:[^\s`]+))/g;
  const matches = [...input.matchAll(refPattern)];

  if (matches.length === 0) {
    return { cleanInput: input, references: [] };
  }

  let cleanInput = input;

  for (const match of matches) {
    const ref = match[1]!;
    cleanInput = cleanInput.replace(match[0], '').trim();

    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      // URL reference
      const resolved = await resolveUrl(ref);
      references.push(resolved);
    } else if (ref.includes('*')) {
      // Glob reference
      const resolved = await resolveGlob(ref, cwd);
      references.push(...resolved);
    } else {
      // File reference
      const resolved = await resolveFile(ref, cwd);
      references.push(resolved);
    }
  }

  return { cleanInput, references };
}

/**
 * Format resolved references as context to prepend to user message.
 */
export function formatReferences(refs: ResolvedReference[]): string {
  if (refs.length === 0) return '';

  const sections: string[] = [];
  for (const ref of refs) {
    if (ref.error) {
      sections.push(`<!-- @${ref.original}: ${ref.error} -->`);
      continue;
    }

    const label = ref.type === 'url' ? ref.original : ref.resolved;
    const truncated = ref.content.length > 30_000
      ? ref.content.slice(0, 30_000) + '\n... (truncated)'
      : ref.content;

    sections.push(`<referenced_${ref.type} path="${label}">\n${truncated}\n</referenced_${ref.type}>`);
  }

  return sections.join('\n\n') + '\n\n';
}

async function resolveFile(ref: string, cwd: string): Promise<ResolvedReference> {
  const filePath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n');

    return {
      type: 'file',
      original: ref,
      resolved: filePath,
      content: `${filePath} (${lines.length} lines):\n${numbered}`,
    };
  } catch (err: any) {
    return {
      type: 'file',
      original: ref,
      resolved: filePath,
      content: '',
      error: err.code === 'ENOENT' ? `File not found: ${filePath}` : err.message,
    };
  }
}

async function resolveUrl(url: string): Promise<ResolvedReference> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Notch-CLI/0.2 (AI coding assistant)' },
    });

    if (!response.ok) {
      return {
        type: 'url',
        original: url,
        resolved: url,
        content: '',
        error: `HTTP ${response.status}`,
      };
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';

    let content: string;
    if (contentType.includes('html')) {
      // Basic HTML stripping
      content = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s{3,}/g, '\n\n')
        .trim();
    } else {
      content = text;
    }

    return { type: 'url', original: url, resolved: url, content };
  } catch (err: any) {
    return {
      type: 'url',
      original: url,
      resolved: url,
      content: '',
      error: err.message,
    };
  }
}

async function resolveGlob(pattern: string, cwd: string): Promise<ResolvedReference[]> {
  try {
    const matches = await glob(pattern, {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      nodir: true,
    });

    if (matches.length === 0) {
      return [{
        type: 'glob',
        original: pattern,
        resolved: pattern,
        content: '',
        error: `No files matching: ${pattern}`,
      }];
    }

    // Cap at 10 files to avoid massive context injection
    const capped = matches.slice(0, 10);
    const results: ResolvedReference[] = [];

    for (const file of capped) {
      results.push(await resolveFile(file, cwd));
    }

    if (matches.length > 10) {
      results.push({
        type: 'glob',
        original: pattern,
        resolved: pattern,
        content: `\u26a0 Warning: ${matches.length} files matched ${pattern}, but only the first 10 were injected. Narrow your glob pattern for more precise results.`,
      });
    }

    return results;
  } catch (err: any) {
    return [{
      type: 'glob',
      original: pattern,
      resolved: pattern,
      content: '',
      error: err.message,
    }];
  }
}
