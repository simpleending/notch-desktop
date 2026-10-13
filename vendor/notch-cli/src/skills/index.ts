/**
 * Notch CLI — Skills Barrel
 *
 * Public API for the bundled-skills system.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export type { Skill, LoadedSkill, SkillRegistry } from './types.js';
export {
  registerSkill,
  getSkill,
  listSkills,
  clearSkills,
  loadSkill,
  cleanupSkills,
  composeSkillPrompt,
} from './registry.js';
