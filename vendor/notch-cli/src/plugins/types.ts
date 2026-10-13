/**
 * Notch CLI — Plugin System Types
 *
 * Defines the interface contract between plugins and the CLI host.
 * Plugins declare capabilities in package.json under "notch-plugin" and
 * implement the NotchPlugin interface.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { NotchTool } from '../tools/types.js';
import type { HookEvent, Hook } from '../hooks/index.js';
import type { CommandHandler } from '../commands/registry.js';

/** Plugin manifest — stored in package.json under "notch-plugin" */
export interface PluginManifest {
  /** What the plugin provides */
  provides?: {
    tools?: string[];
    commands?: string[];
    hooks?: string[];
  };
  /** Entry point relative to plugin root */
  main: string;
}

/** Plugin package.json shape (only the fields we care about) */
export interface PluginPackageJson {
  name: string;
  version: string;
  description?: string;
  'notch-plugin': PluginManifest;
}

/** Context provided to plugins during activation */
export interface PluginContext {
  /** Register a tool that the agent can use */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(tool: NotchTool<any>): void;

  /** Register a slash command (name should include the leading /) */
  registerCommand(name: string, handler: CommandHandler): void;

  /** Register a hook handler for a specific event */
  registerHook(hook: Hook): void;

  /** Project root directory */
  cwd: string;

  /** Log a message to the terminal */
  log(message: string): void;
}

/** Interface that plugins must implement */
export interface NotchPlugin {
  /** Called when the plugin is loaded. Register tools, commands, hooks here. */
  activate(ctx: PluginContext): Promise<void>;

  /** Called when the plugin is unloaded. Clean up resources here. */
  deactivate?(): Promise<void>;
}

/** Internal representation of a loaded plugin */
export interface LoadedPlugin {
  /** Plugin name (from package.json) */
  name: string;
  /** Plugin version */
  version: string;
  /** Plugin description */
  description: string;
  /** Absolute path to the plugin root */
  path: string;
  /** The plugin instance */
  instance: NotchPlugin;
  /** Tools registered by this plugin */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: NotchTool<any>[];
  /** Hooks registered by this plugin */
  hooks: Hook[];
}
