/**
 * Notch CLI — Terminal backend interface
 *
 * A TerminalBackend runs a shell command somewhere — locally, inside a
 * Docker container, over SSH to a remote host, or on a serverless
 * runtime. The `shell` tool can switch backends via `.notch.json`
 * without rewriting its security layer.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export interface TerminalRunRequest {
  /** Command string exactly as the user / model issued it. */
  command: string;
  /** Absolute working directory (interpreted by the backend — may be a host OR container path). */
  cwd?: string;
  /** Extra env vars (merged over backend defaults). */
  env?: Record<string, string>;
  /** Max stdout + stderr chars to return (default 32_000). */
  maxOutputChars?: number;
  /** Timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface TerminalRunResult {
  /** 0 = success. Non-zero = failure. Null when the process was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Soft-truncated output flag. */
  truncated?: boolean;
  /** Backend-specific diagnostic info (image, host, container id, etc.). */
  diagnostics?: Record<string, unknown>;
}

export interface TerminalBackend {
  /** Short machine id (e.g. `local`, `docker`, `ssh`, `modal`). */
  readonly id: string;
  /** Human-readable one-liner shown in `notch doctor`. */
  readonly description: string;
  /** Best-effort readiness probe. Throws if the backend isn't usable. */
  readyCheck(): Promise<void>;
  /** Execute the request. */
  run(req: TerminalRunRequest): Promise<TerminalRunResult>;
  /** Tear down any persistent state (containers, sessions). */
  dispose?(): Promise<void>;
}
