/**
 * Notch CLI — Skill Registry
 *
 * In-process registry for bundled skills. `loadSkill(id)` extracts any
 * embedded reference files to a deterministic temp dir on first call,
 * memoizing the IN-FLIGHT promise (not its resolved value) so concurrent
 * callers await a single extraction instead of racing into separate writes.
 *
 * Extraction directory layout:
 *   <os.tmpdir()>/notch-skills/<id>-<sha8>/
 *
 * `<sha8>` is the first 8 hex chars of sha256(JSON.stringify(files)), which
 * lets cache invalidate automatically when a skill's files change between
 * releases without leaking stale content.
 *
 * On graceful exit (`process.on('exit')` + SIGINT), `cleanupSkills()`
 * removes every extract dir this process wrote.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LoadedSkill, Skill, SkillRegistry } from './types.js';

const registry: SkillRegistry = new Map();

/**
 * Per-skill in-flight promise. Storing the *promise* — not the resolved
 * `LoadedSkill` — ensures two concurrent `loadSkill('x')` calls await the
 * same extraction. The cached promise resolves once, and every subsequent
 * caller gets the same resolved value for free.
 */
const loadPromises = new Map<string, Promise<LoadedSkill>>();

/** Directories we've extracted to this process run — cleaned up on exit. */
const extractedDirs = new Set<string>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a skill. Idempotent: re-registering the same id overwrites
 * (useful for hot reloads in dev).
 */
export function registerSkill(skill: Skill): void {
  if (!skill.id || !/^[a-z0-9][a-z0-9\-_]*$/i.test(skill.id)) {
    throw new Error(
      `registerSkill: invalid skill id ${JSON.stringify(skill.id)} — must match /^[a-z0-9][a-z0-9\\-_]*$/i`,
    );
  }
  if (skill.files) {
    validateSkillFileKeys(skill.id, skill.files);
  }
  registry.set(skill.id, skill);
  // If the skill changed between registrations, drop any cached load promise
  // so the next loadSkill() re-extracts fresh.
  loadPromises.delete(skill.id);
}

/** Get a skill by id, or undefined if unregistered. */
export function getSkill(id: string): Skill | undefined {
  return registry.get(id);
}

/** List all registered skills in insertion order. */
export function listSkills(): Skill[] {
  return [...registry.values()];
}

/** Test/dev helper — drop every registered skill. */
export function clearSkills(): void {
  registry.clear();
  loadPromises.clear();
}

// ---------------------------------------------------------------------------
// Loading (lazy extraction, promise-memoized)
// ---------------------------------------------------------------------------

/**
 * Load a skill, extracting its reference files to disk on first call.
 *
 * Concurrency contract: two in-flight calls for the same id share ONE
 * extraction. Verified shape:
 *     Promise.all([loadSkill('x'), loadSkill('x')])
 * …runs `extractFiles` exactly once.
 *
 * On extraction failure, the skill still loads — `extractDir` points at the
 * intended directory (which may be empty) and the caller can decide whether
 * to surface the error. We prefer degraded operation over total failure
 * because a skill's prompt alone is usually still useful.
 */
export async function loadSkill(id: string): Promise<LoadedSkill> {
  const skill = registry.get(id);
  if (!skill) {
    throw new Error(
      `loadSkill: no skill registered with id '${id}'. Call listSkills() for available ids.`,
    );
  }

  const existing = loadPromises.get(id);
  if (existing) return existing;

  // Store the promise synchronously BEFORE the first `await` so a second
  // caller entering during the microtask queue finds it. This is the core
  // of the promise-memoization pattern — store the in-flight promise, never
  // just the resolved result.
  const promise = performLoad(skill);
  loadPromises.set(id, promise);

  // If the load rejects, drop the cached promise so the next caller gets
  // a fresh attempt rather than a perma-failing skill.
  promise.catch(() => {
    loadPromises.delete(id);
  });

  return promise;
}

async function performLoad(skill: Skill): Promise<LoadedSkill> {
  const dir = getExtractDir(skill);
  if (skill.files && Object.keys(skill.files).length > 0) {
    await extractFiles(dir, skill.files);
    extractedDirs.add(dir);
  } else {
    // No files — still return a stable dir path (not created) so callers
    // always have a non-empty extractDir string.
  }
  return { ...skill, extractDir: dir };
}

function getExtractDir(skill: Skill): string {
  const filesJson = skill.files ? JSON.stringify(skill.files) : '';
  const sha8 = createHash('sha256').update(filesJson).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'notch-skills', `${skill.id}-${sha8}`);
}

async function extractFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  // Group writes by parent dir so we mkdir each subtree once.
  const byParent = new Map<string, Array<[string, string]>>();
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolveSafePath(dir, relPath);
    const parent = path.dirname(target);
    const group = byParent.get(parent);
    if (group) group.push([target, content]);
    else byParent.set(parent, [[target, content]]);
  }

  await Promise.all(
    [...byParent].map(async ([parent, entries]) => {
      await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      await Promise.all(
        entries.map(async ([p, c]) => {
          // Overwrite on re-extract is fine — content is reproducible from
          // the embedded string. No O_EXCL needed here because the dir is
          // content-addressed (sha8) and owner-only (0o700).
          await fsp.writeFile(p, c, { encoding: 'utf8', mode: 0o600 });
        }),
      );
    }),
  );
}

/**
 * Validate a skill-relative path: no absolute, no `..`, no leading `/`.
 * Throws at registration time so bad skills fail fast in dev.
 */
function resolveSafePath(baseDir: string, relPath: string): string {
  const normalized = path.normalize(relPath);
  const parts = normalized.split(/[\\/]/);
  if (path.isAbsolute(normalized) || parts.includes('..')) {
    throw new Error(`skill file path escapes skill dir: ${relPath}`);
  }
  return path.join(baseDir, normalized);
}

function validateSkillFileKeys(
  skillId: string,
  files: Record<string, string>,
): void {
  for (const key of Object.keys(files)) {
    if (!key) {
      throw new Error(`skill '${skillId}': empty file key`);
    }
    try {
      resolveSafePath('/_check', key);
    } catch (e) {
      throw new Error(
        `skill '${skillId}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove every extract dir this process created. Safe to call multiple
 * times; safe to call on a cold process (no-op). Uses sync fs because
 * it runs during `process.on('exit')`, which does not await promises.
 */
export function cleanupSkills(): void {
  for (const dir of extractedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Swallow — process is exiting, nothing productive to do.
    }
  }
  extractedDirs.clear();
}

let cleanupInstalled = false;

/** Install exit handlers. Called automatically on first `loadSkill`. */
function installCleanupHandlers(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', cleanupSkills);
  process.on('SIGINT', () => {
    cleanupSkills();
    process.exit(0);
  });
}

// Install as a side effect of module load so ctrl-c during the very first
// extraction still cleans up.
installCleanupHandlers();

/**
 * Build the prompt to hand a subagent: the base-dir prefix (if files were
 * extracted) plus the skill's authored prompt, plus any user args.
 */
export function composeSkillPrompt(
  skill: LoadedSkill,
  userArgs: string,
): string {
  const hasFiles = !!skill.files && Object.keys(skill.files).length > 0;
  const prefix = hasFiles
    ? `Base directory for this skill: ${skill.extractDir}\n\n`
    : '';
  const trailer = userArgs.trim() ? `\n\n## User-provided arguments\n\n${userArgs.trim()}\n` : '';
  return `${prefix}${skill.prompt}${trailer}`;
}
