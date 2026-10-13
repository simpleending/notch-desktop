/**
 * Notch CLI — Plugin Discovery
 *
 * Scans plugin directories for installed plugins.
 * Checks both global (~/.notch/plugins/) and project (.notch/plugins/) paths.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PluginPackageJson } from './types.js';

export interface DiscoveredPlugin {
  name: string;
  version: string;
  description: string;
  path: string;
  manifest: PluginPackageJson['notch-plugin'];
}

/**
 * Discover all installed plugins from global and project directories.
 * Project plugins override global plugins with the same name.
 */
export async function discoverPlugins(projectRoot: string): Promise<DiscoveredPlugin[]> {
  const globalDir = path.join(os.homedir(), '.notch', 'plugins');
  const projectDir = path.join(projectRoot, '.notch', 'plugins');

  const plugins = new Map<string, DiscoveredPlugin>();

  // Scan global plugins first (lower precedence)
  for (const plugin of await scanDirectory(globalDir)) {
    plugins.set(plugin.name, plugin);
  }

  // Scan project plugins (higher precedence — overrides global)
  for (const plugin of await scanDirectory(projectDir)) {
    plugins.set(plugin.name, plugin);
  }

  return [...plugins.values()];
}

/**
 * Scan a directory for plugin packages.
 */
async function scanDirectory(dir: string): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(dir, entry.name);
      const pkgPath = path.join(pluginDir, 'package.json');

      try {
        const raw = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw) as Partial<PluginPackageJson>;

        if (pkg['notch-plugin'] && pkg.name) {
          results.push({
            name: pkg.name,
            version: pkg.version ?? '0.0.0',
            description: pkg.description ?? '',
            path: pluginDir,
            manifest: pkg['notch-plugin'],
          });
        }
      } catch {
        // Not a valid plugin — skip silently
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }

  return results;
}
