/**
 * Notch CLI — Plugin Manager
 *
 * Orchestrates plugin discovery, loading, lifecycle, and integration
 * with the tool system and hooks.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { NotchTool } from '../tools/types.js';
import type { Hook } from '../hooks/index.js';
import type { LoadedPlugin } from './types.js';
import { discoverPlugins } from './discovery.js';
import { loadPlugin } from './loader.js';

export type { NotchPlugin, PluginContext, PluginManifest, LoadedPlugin } from './types.js';

class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private initialized = false;

  /**
   * Discover and load all plugins. Call once at startup.
   */
  async init(
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<number> {
    if (this.initialized) return this.plugins.length;

    const discovered = await discoverPlugins(projectRoot);
    if (discovered.length === 0) {
      this.initialized = true;
      return 0;
    }

    for (const d of discovered) {
      const loaded = await loadPlugin(d, projectRoot, log);
      if (loaded) {
        this.plugins.push(loaded);
      }
    }

    this.initialized = true;
    return this.plugins.length;
  }

  /** All tools registered by plugins */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(): NotchTool<any>[] {
    return this.plugins.flatMap((p) => p.tools);
  }

  /** All hooks registered by plugins */
  getHooks(): Hook[] {
    return this.plugins.flatMap((p) => p.hooks);
  }

  /** List all loaded plugins */
  list(): LoadedPlugin[] {
    return [...this.plugins];
  }

  /** Shut down all plugins gracefully */
  async shutdown(): Promise<void> {
    for (const p of this.plugins) {
      try {
        await p.instance.deactivate?.();
      } catch (err: any) {
        console.warn(`  Plugin ${p.name} deactivation failed: ${err.message}`);
      }
    }
    this.plugins = [];
    this.initialized = false;
  }
}

/** Singleton plugin manager instance */
export const pluginManager = new PluginManager();
