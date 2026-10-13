/**
 * Notch CLI — Bundled Skills Auto-Registration
 *
 * Import this module (side-effectfully) to register every bundled skill
 * that ships with the CLI. Each skill module calls `registerSkill()` at
 * import time — this barrel just guarantees they all get loaded.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

// Side-effect imports — each module calls registerSkill() on load.
import './commit-message.js';
import './api-design.js';
import './debug-assist.js';
import './refactor-plan.js';

export { commitMessageSkill } from './commit-message.js';
export { apiDesignSkill } from './api-design.js';
export { debugAssistSkill } from './debug-assist.js';
export { refactorPlanSkill } from './refactor-plan.js';
