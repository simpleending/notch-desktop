/**
 * Notch CLI — Plugin Loader
 *
 * Dynamically imports and activates plugin modules.
 * Handles validation, error isolation, and resource tracking.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NotchTool } from '../tools/types.js';
import type { Hook } from '../hooks/index.js';
import { registerCommand, type CommandHandler } from '../commands/registry.js';
import type { NotchPlugin, PluginContext, LoadedPlugin } from './types.js';
import type { DiscoveredPlugin } from './discovery.js';

/**
 * Load and activate a single discovered plugin.
 * Returns null if the plugin fails to load (logs warning instead of throwing).
 */
export async function loadPlugin(
  discovered: DiscoveredPlugin,
  projectRoot: string,
  log: (msg: string) => void,
): Promise<LoadedPlugin | null> {
  const entryPath = path.resolve(discovered.path, discovered.manifest.main);

  // Track registrations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: NotchTool<any>[] = [];
  const hooks: Hook[] = [];

  const ctx: PluginContext = {
    cwd: projectRoot,
    log,
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name: string, handler: CommandHandler) {
      registerCommand(name, handler);
    },
    registerHook(hook: Hook) {
      hooks.push(hook);
    },
  };

  try {
    // Dynamic import — use file:// URL for Windows compatibility
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = await import(moduleUrl);
    const plugin: NotchPlugin = mod.default ?? mod;

    if (typeof plugin.activate !== 'function') {
      log(`Plugin ${discovered.name}: no activate() function — skipping`);
      return null;
    }

    await plugin.activate(ctx);

    return {
      name: discovered.name,
      version: discovered.version,
      description: discovered.description,
      path: discovered.path,
      instance: plugin,
      tools,
      hooks,
    };
  } catch (err: any) {
    log(`Plugin ${discovered.name} failed to load: ${err.message}`);
    return null;
  }
}
