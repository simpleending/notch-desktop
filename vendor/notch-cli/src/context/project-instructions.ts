/**
 * Notch CLI — Project Instructions (.notch.md)
 *
 * Loads per-project behavioral instructions from .notch.md files,
 * similar to how Claude Code uses CLAUDE.md. Supports hierarchical
 * loading: home dir → project root → subdirectories.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const INSTRUCTION_FILES = ['.notch.md', 'NOTCH.md', '.notch/instructions.md'];

interface InstructionSource {
  path: string;
  content: string;
  scope: 'global' | 'project';
}

/**
 * Load all .notch.md instruction files in priority order.
 * Global (~/.notch.md) is loaded first, then project-level files.
 */
export async function loadProjectInstructions(projectRoot: string): Promise<string> {
  const sources: InstructionSource[] = [];

  // 1. Global instructions from home directory
  const homeDir = os.homedir();
  for (const file of INSTRUCTION_FILES) {
    const globalPath = path.join(homeDir, file);
    const content = await safeRead(globalPath);
    if (content) {
      sources.push({ path: globalPath, content, scope: 'global' });
      break; // Only use first found global file
    }
  }

  // 2. Project-level instructions
  for (const file of INSTRUCTION_FILES) {
    const projectPath = path.join(projectRoot, file);
    const content = await safeRead(projectPath);
    if (content) {
      sources.push({ path: projectPath, content, scope: 'project' });
      break; // Only use first found project file
    }
  }

  if (sources.length === 0) return '';

  const sections = sources.map((s) => {
    const label = s.scope === 'global' ? 'Global Instructions' : 'Project Instructions';
    return `## ${label}\n_Source: ${s.path}_\n\n${s.content}`;
  });

  return `\n# Custom Instructions\n\n${sections.join('\n\n')}`;
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
