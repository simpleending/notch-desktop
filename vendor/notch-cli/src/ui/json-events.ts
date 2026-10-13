/**
 * Notch CLI — JSONL Event Stream
 *
 * When `--json` is passed, the CLI emits one JSON object per line to stdout
 * instead of human-formatted chat output. Each event has a `type` discriminator.
 * This makes notch scriptable from CI, other agents, and parent processes.
 *
 * Events are append-only and never span multiple lines. All machine output goes
 * to stdout; human progress (spinners, warnings) is redirected to stderr when
 * JSON mode is active so pipes stay clean.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export type JsonEvent =
  | { type: 'session-start'; model: string; cwd: string; systemPrompt?: string; outputSchema?: unknown }
  | { type: 'user-message'; content: string }
  | { type: 'text-delta'; content: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string; isError: boolean }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; cost: number }
  | { type: 'assistant-message'; content: string }
  | { type: 'structured-output'; value: unknown }
  | { type: 'session-end'; turns: number; durationMs: number; status?: 'completed' | 'max-iterations' }
  | { type: 'error'; message: string; code?: string };

export class JsonEmitter {
  private startedAt = Date.now();
  constructor(private enabled: boolean) {}

  emit(event: JsonEvent): void {
    if (!this.enabled) return;
    // Always single-line — no indent, newline-terminated, append-only.
    process.stdout.write(JSON.stringify(event) + '\n');
  }

  get isActive(): boolean { return this.enabled; }
  get elapsedMs(): number { return Date.now() - this.startedAt; }
}

/** Human progress output — routed to stderr in JSON mode so stdout stays clean. */
export function humanLog(enabled: boolean, msg: string): void {
  if (enabled) process.stderr.write(msg);
  else process.stdout.write(msg);
}
