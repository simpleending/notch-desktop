/**
 * Notch CLI — Built-in Subagent Registry
 *
 * Loads scholar-themed built-in subagents from TOML files in this directory.
 * Each TOML file declares an agent's name, description, allowed tool names,
 * iteration cap, and developer instructions (system prompt).
 *
 * Inspired by the builtins pattern in openai/codex (codex-rs/core/src/agent/builtins).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

export interface BuiltinAgent {
  name: string;
  description: string;
  tools: string[];
  maxIterations: number;
  prompt: string;
}

interface TomlShape {
  agent?: {
    name?: unknown;
    description?: unknown;
    tools?: unknown;
    max_iterations?: unknown;
    prompt?: {
      developer_instructions?: unknown;
    };
  };
}

let cache: Map<string, BuiltinAgent> | null = null;

/**
 * Resolve the directory where the builtin TOML files live.
 * Handles both source-tree runs (src/agent/builtins) and bundled dist runs
 * (dist/builtins) by trying candidates in order.
 */
function resolveBuiltinsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    here,                                    // src/agent/builtins (dev) or wherever co-located
    join(here, 'builtins'),                  // dist layout with copied builtins/ subdir
    join(here, '..', 'builtins'),            // one level up (e.g. dist/ adjacent to builtins/)
    join(here, '..', '..', 'src', 'agent', 'builtins'), // from dist/ back into src/
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.toml'))) {
        return dir;
      }
    } catch {
      // ignore and try next
    }
  }
  return null;
}

function asString(v: unknown, field: string, file: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`builtin agent ${file}: field "${field}" must be a non-empty string`);
  }
  return v;
}

function asStringArray(v: unknown, field: string, file: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`builtin agent ${file}: field "${field}" must be an array of strings`);
  }
  return v as string[];
}

function asPositiveInt(v: unknown, field: string, file: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  // smol-toml may return bigint for integers
  if (typeof v === 'bigint' && v > 0n) return Number(v);
  throw new Error(`builtin agent ${file}: field "${field}" must be a positive integer`);
}

function parseBuiltinFile(filePath: string, fileName: string): BuiltinAgent | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`  [builtins] could not read ${fileName}: ${(err as Error).message}`);
    return null;
  }

  let doc: TomlShape;
  try {
    doc = parseToml(raw) as TomlShape;
  } catch (err) {
    console.warn(`  [builtins] malformed TOML in ${fileName}: ${(err as Error).message}`);
    return null;
  }

  const a = doc.agent;
  if (!a || typeof a !== 'object') {
    console.warn(`  [builtins] ${fileName}: missing [agent] table`);
    return null;
  }

  try {
    const name = asString(a.name, 'agent.name', fileName).toLowerCase();
    const description = asString(a.description, 'agent.description', fileName);
    const tools = asStringArray(a.tools, 'agent.tools', fileName);
    const maxIterations = asPositiveInt(a.max_iterations, 'agent.max_iterations', fileName, 20);
    const prompt = asString(
      a.prompt?.developer_instructions,
      'agent.prompt.developer_instructions',
      fileName,
    );
    return { name, description, tools, maxIterations, prompt };
  } catch (err) {
    console.warn(`  [builtins] ${(err as Error).message}`);
    return null;
  }
}

/**
 * Load all built-in agents from TOML files in the builtins directory.
 * Result is cached. Malformed files are skipped with a warning.
 */
export function loadBuiltinAgents(): Map<string, BuiltinAgent> {
  if (cache) return cache;
  const dir = resolveBuiltinsDir();
  const map = new Map<string, BuiltinAgent>();
  if (!dir) {
    console.warn('  [builtins] could not locate builtins directory; no built-in agents loaded');
    cache = map;
    return map;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.toml'));
  } catch (err) {
    console.warn(`  [builtins] could not list ${dir}: ${(err as Error).message}`);
    cache = map;
    return map;
  }

  for (const file of entries) {
    const agent = parseBuiltinFile(join(dir, file), file);
    if (!agent) continue;
    if (map.has(agent.name)) {
      console.warn(`  [builtins] duplicate agent name "${agent.name}" in ${file} (keeping first)`);
      continue;
    }
    map.set(agent.name, agent);
  }

  cache = map;
  return map;
}

/** Clear the load cache. Intended for tests and hot-reload. */
export function _resetBuiltinCache(): void {
  cache = null;
}

/** Get a single built-in agent by name (case-insensitive), or undefined if not found. */
export function getBuiltinAgent(name: string): BuiltinAgent | undefined {
  return loadBuiltinAgents().get(name.toLowerCase());
}

/** List all built-in agents, sorted alphabetically by name. */
export function listBuiltinAgents(): BuiltinAgent[] {
  return [...loadBuiltinAgents().values()].sort((a, b) => a.name.localeCompare(b.name));
}
