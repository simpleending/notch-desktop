/**
 * Notch CLI — Bundled Skill Types
 *
 * Skills are opinionated, reusable prompt bundles that ship inside the CLI
 * binary. They may carry a `files` record — reference Markdown / snippets
 * embedded as strings — which get lazily extracted to a temp directory on
 * first invocation. The agent is then told the base directory so it can
 * `Read`/`Grep` those files on demand (same contract as disk-based skills
 * in leaked Claude Code).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

/**
 * A skill definition as it lives in source — with inline `files`.
 *
 * `files` keys are relative paths (forward slashes, no `..`); values are the
 * file contents. Keep files small — they ship in the binary.
 */
export interface Skill {
  /** Stable machine id. Used in `/skill run <id>`. Must be filesystem-safe. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description shown in `/skill list`. */
  description: string;
  /**
   * The skill prompt. When `files` is present and extraction succeeds, the
   * string `Base directory for this skill: <dir>\n\n` is prepended at load
   * time so the agent can read the reference files.
   */
  prompt: string;
  /**
   * Optional reference files shipped with the skill. Relative paths only,
   * no leading slash, no `..` traversal. Omit entirely if the skill has
   * no reference files — do NOT ship `files: {}`.
   */
  files?: Record<string, string>;
  /**
   * Optional whitelist of tool names the subagent may use. When omitted,
   * the agent gets the general-purpose toolset.
   */
  allowedTools?: string[];
}

/**
 * A skill that has been loaded — reference files (if any) have been
 * extracted to `extractDir`, and the prompt has been prefixed with the
 * base-directory line.
 */
export interface LoadedSkill extends Skill {
  /**
   * Absolute path where reference files were extracted. Equal to the
   * parent temp dir when the skill has no files (extraction is a no-op).
   */
  extractDir: string;
}

/**
 * Registry storage type. Keyed by `skill.id`.
 */
export type SkillRegistry = Map<string, Skill>;
