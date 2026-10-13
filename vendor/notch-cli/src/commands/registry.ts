/**
 * Notch CLI — Command Registry
 *
 * Centralised registry for slash commands. Enables programmatic dispatch
 * (e.g. from /loop) and plugin command registration.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export interface CommandContext {
  /** Project root */
  cwd: string;
  /** Active model ID */
  modelId: string;
  /** Message history (mutable — commands that run the agent should update in place) */
  messages: import('ai').ModelMessage[];
  /** Run the agent loop with a prompt and return the response text */
  runPrompt: (prompt: string, messages: import('ai').ModelMessage[]) => Promise<string>;
  /** Print to terminal */
  log: (msg: string) => void;
  /** Last assistant response text */
  lastResponse: string;
  /** Resolved language model instance (for commands that spawn subagents directly). */
  model?: import('ai').LanguageModel;
  /** Tool context for subagent execution (shares cwd, permissions, confirm, hooks). */
  toolContext?: import('../tools/types.js').ToolContext;
  /** Ask the user a yes/no question (falls back to toolContext.confirm when omitted). */
  confirm?: (message: string) => Promise<boolean>;
}

export type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;

/**
 * Registry of slash commands that can be dispatched programmatically.
 * Commands registered here are checked *before* the "Unknown command" catch-all.
 */
const registry = new Map<string, CommandHandler>();

/** Register a slash command (name should include the leading /). */
export function registerCommand(name: string, handler: CommandHandler): void {
  registry.set(name, handler);
}

/**
 * Try to dispatch a slash command. Returns true if a handler was found and executed.
 */
export async function dispatchCommand(input: string, ctx: CommandContext): Promise<boolean> {
  // Try exact match first, then prefix match
  for (const [name, handler] of registry) {
    if (input === name || input.startsWith(name + ' ')) {
      const args = input.slice(name.length).trim();
      await handler(args, ctx);
      return true;
    }
  }
  return false;
}

/** Get all registered command names (for tab completion). */
export function registeredCommandNames(): string[] {
  return [...registry.keys()];
}
