/**
 * Notch CLI — AGENTS.md Hierarchy Loader
 *
 * Walks the filesystem to collect AGENTS.md instruction files following the
 * convention popularised by openai/codex: "Each AGENTS.md governs the entire
 * directory that contains it and every child directory. When two AGENTS.md
 * files disagree, the one located deeper overrides the higher-level file."
 *
 * We walk UP from `cwd` to the git root (or the user's home dir if there is
 * no git root) collecting AGENTS.md files, then DOWN exactly one level into
 * each direct child directory of `cwd` to pick up immediately-nested files.
 * Results are sorted by directory depth so the LAST entry wins on conflict.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** One AGENTS.md file discovered during the walk. */
export interface AgentsMdSection {
  /** Absolute path to the AGENTS.md file. */
  path: string;
  /** Depth measured as number of path segments from filesystem root. Deeper = higher precedence. */
  depth: number;
  /** File contents (trimmed). */
  content: string;
  /** Byte size of the file on disk. */
  size: number;
}

/** Files/dirs we never recurse into when scanning for nested AGENTS.md. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  '.vercel',
  '.nuxt',
  'out',
]);

/** Any AGENTS.md larger than this gets skipped to keep the prompt tractable. */
const MAX_FILE_BYTES = 32 * 1024;

/** Filename we match (case-sensitive; this is the Codex convention). */
const AGENTS_FILENAME = 'AGENTS.md';

/**
 * Determine the git root for `startDir` by walking up looking for a `.git`
 * entry (directory for regular repos, file for worktrees/submodules).
 * Returns null if no git root is found before the filesystem root.
 */
async function findGitRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  // Bound the walk to filesystem depth — parsed as a safety net against
  // weird filesystems where parentDir === current never trips.
  for (let i = 0; i < 128; i++) {
    const gitEntry = path.join(current, '.git');
    try {
      // Accept either a directory (regular repo) or a file (worktree/submodule).
      await fs.stat(gitEntry);
      return current;
    } catch {
      // not here, keep going up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Read and validate a single AGENTS.md file.
 * Returns null if the file doesn't exist, is too large, or is unreadable.
 * Logs a single-line warning on unreadable (permission) errors.
 */
async function readAgentsMd(filePath: string): Promise<AgentsMdSection | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null; // File doesn't exist — silent skip
  }

  if (!stat.isFile()) return null;

  if (stat.size > MAX_FILE_BYTES) {
    console.error(
      `[notch] Skipping ${filePath}: ${stat.size} bytes exceeds ${MAX_FILE_BYTES}-byte AGENTS.md limit.`,
    );
    return null;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[notch] Unable to read ${filePath}: ${msg}`);
    return null;
  }

  const trimmed = content.trim();
  if (!trimmed) return null;

  // Depth = number of non-empty segments in the absolute path.
  // Using path.sep keeps Windows + POSIX both correct.
  const depth = path
    .resolve(filePath)
    .split(path.sep)
    .filter(Boolean).length;

  return {
    path: path.resolve(filePath),
    depth,
    content: trimmed,
    size: stat.size,
  };
}

/**
 * Load the full AGENTS.md hierarchy relevant to `cwd`.
 *
 * Walks UP from `cwd` to the git root (or home dir), collecting AGENTS.md at
 * every level. Then walks DOWN exactly one level into each direct child dir
 * of `cwd` to pick up immediately-nested AGENTS.md files that would apply if
 * the agent navigates there.
 *
 * Returns entries sorted by depth ascending (root first, most-specific last).
 * The caller should treat the LAST entry as highest precedence.
 */
export async function loadAgentsMdHierarchy(
  cwd: string,
  walkUpToRoot: boolean = true,
): Promise<AgentsMdSection[]> {
  const startDir = path.resolve(cwd);
  const sections: AgentsMdSection[] = [];

  // Track realpaths to defend against symlink loops and duplicate scans.
  const visited = new Set<string>();
  const addRealpath = async (p: string): Promise<boolean> => {
    try {
      const real = await fs.realpath(p);
      if (visited.has(real)) return false;
      visited.add(real);
      return true;
    } catch {
      // Path doesn't exist or not accessible — nothing to dedupe against.
      return true;
    }
  };

  // 1. Determine the boundary for the upward walk.
  let boundary: string | null = null;
  if (walkUpToRoot) {
    boundary = await findGitRoot(startDir);
    if (!boundary) {
      // No git root — stop at home dir for safety so we don't scrape
      // arbitrary parent directories.
      boundary = os.homedir();
    }
  } else {
    boundary = startDir;
  }
  boundary = path.resolve(boundary);

  // 2. Walk UP from cwd to the boundary (inclusive).
  const upwardDirs: string[] = [];
  {
    let current = startDir;
    for (let i = 0; i < 128; i++) {
      upwardDirs.push(current);
      if (current === boundary) break;
      const parent = path.dirname(current);
      if (parent === current) break; // Hit filesystem root.
      // Don't walk above the boundary.
      const insideBoundary =
        current.startsWith(boundary + path.sep) || current === boundary;
      if (!insideBoundary) break;
      current = parent;
    }
  }

  // Reverse so we collect root-first (shallow depth first).
  upwardDirs.reverse();

  for (const dir of upwardDirs) {
    const candidate = path.join(dir, AGENTS_FILENAME);
    if (!(await addRealpath(candidate))) continue;
    const section = await readAgentsMd(candidate);
    if (section) sections.push(section);
  }

  // 3. Walk DOWN exactly one level into each direct child dir of cwd.
  let children: string[] = [];
  try {
    const entries = await fs.readdir(startDir, { withFileTypes: true });
    children = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => path.join(startDir, e.name));
  } catch {
    children = [];
  }

  for (const childDir of children) {
    const candidate = path.join(childDir, AGENTS_FILENAME);
    if (!(await addRealpath(candidate))) continue;
    const section = await readAgentsMd(candidate);
    if (section) sections.push(section);
  }

  // 4. Sort by depth ascending. Ties broken alphabetically by path for
  // deterministic ordering between peer directories.
  sections.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });

  return sections;
}
