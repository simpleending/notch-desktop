/**
 * Notch CLI — Command Exports
 *
 * Import this module to register all built-in commands.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export { registerCommand, dispatchCommand, registeredCommandNames, type CommandContext, type CommandHandler } from './registry.js';

// Side-effect imports — each module calls registerCommand() on load
import './doctor.js';
import './copy.js';
import './btw.js';
import './security-review.js';
import './loop.js';
import './batch.js';
import './plugin.js';
import './commit.js';
import './pr.js';
import './worktree.js';
import './tasks.js';
import './debug.js';
import './rewind.js';
import './insights.js';
import './rename.js';
import './sandbox.js';
import './skill.js';
import './microcompact.js';
import './update.js';
import './cloud.js';
import './agent-builder.js';
