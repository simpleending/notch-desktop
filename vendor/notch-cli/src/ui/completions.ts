/**
 * Notch CLI — Tab Completion
 *
 * Readline completer for commands, file paths, and model names.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listByokProviders } from '../providers/registry.js';
import { THEME_IDS } from './themes.js';
import { registeredCommandNames } from '../commands/registry.js';

const COMMANDS = [
  '/settings', '/workspace', '/workspace shared', '/workspace isolated',
  '/help', '/quit', '/exit', '/q', '/clear',
  '/model', '/model coding', '/models', '/models coding', '/models install', '/models recommend', '/models status', '/models unload', '/status', '/undo', '/usage',
  '/compact', '/diff', '/export', '/save', '/sessions',
  '/resume', '/search', '/memory', '/memory compact', '/memory search', '/memory clear', '/remember',
  '/permissions', '/permissions approve', '/permissions read-only', '/permissions full-access', '/yolo',
  '/plan', '/plan approve', '/plan cancel', '/plan edit',
  '/theme', '/themes', '/mascot', '/cost', '/branch', '/branches',
  // Utility commands
  '/doctor', '/copy', '/btw', '/security-review',
  '/loop', '/loop stop', '/batch',
  '/plugin', '/plugin list', '/plugin install', '/plugin remove',
  '/providers', '/setup-keys', '/sync-keys',
  // Git workflow
  '/commit', '/pr',
  // Worktree
  '/worktree', '/worktree list', '/worktree create', '/worktree remove', '/worktree switch',
  // Task management
  '/tasks', '/ralph plan', '/ralph run', '/ralph status', '/ralph clear',
  // UX commands
  '/debug', '/debug on', '/debug off', '/debug status',
  '/rewind', '/insights', '/rename', '/sandbox', '/dry-run',
];

/**
 * Build a readline completer function.
 */
export function buildCompleter(cwd: string) {
  return function completer(line: string): [string[], string] {
    // /model <provider/model> completion
    if (line.startsWith('/model ')) {
      const partial = line.slice(7);
      const allNames = [
        'coding',
        ...listByokProviders()
          .filter((p) => p.defaultModel)
          .map((p) => `${p.id}/${p.defaultModel}`),
      ];
      const matches = allNames.filter((m) => m.startsWith(partial));
      return [matches.map((m) => `/model ${m}`), line];
    }

    // /theme <name> completion
    if (line.startsWith('/theme ')) {
      const partial = line.slice(7);
      const matches = THEME_IDS.filter((t) => t.startsWith(partial));
      return [matches.map((t) => `/theme ${t}`), line];
    }

    // Readline owns Tab, Enter and history navigation.
    if (line.startsWith('/')) {
      return [[...new Set([...COMMANDS, ...registeredCommandNames()])].filter((c) => c.startsWith(line)), line];
    }

    // @file completion
    const atMatch = line.match(/@([^\s]*)$/);
    if (atMatch) {
      const partial = atMatch[1]!;
      const completions = completeFilePath(partial, cwd);
      return [completions.map((c) => line.slice(0, -partial.length) + c), line];
    }

    // No completion
    return [[], line];
  };
}

/**
 * Complete a partial file path.
 */
function completeFilePath(partial: string, cwd: string): string[] {
  try {
    const dir = partial.includes('/')
      ? path.resolve(cwd, path.dirname(partial))
      : cwd;

    const prefix = partial.includes('/')
      ? path.basename(partial)
      : partial;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip hidden
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      if (entry.name.startsWith(prefix)) {
        const relative = partial.includes('/')
          ? path.dirname(partial) + '/' + entry.name
          : entry.name;

        if (entry.isDirectory()) {
          matches.push(relative + '/');
        } else {
          matches.push(relative);
        }
      }
    }

    return matches.slice(0, 20); // Cap at 20 suggestions
  } catch {
    return [];
  }
}
