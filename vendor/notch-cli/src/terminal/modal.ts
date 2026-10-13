/**
 * Notch CLI — Modal terminal backend.
 *
 * Routes command execution to a pre-configured Modal function. Modal
 * auth + function definition live OUTSIDE this module — the backend
 * just invokes a Python sandbox endpoint that wraps `subprocess.run`.
 *
 * The Modal endpoint is expected to accept:
 *   POST <endpoint>
 *   { command: string, cwd?: string, env?: object, timeoutMs?: number }
 * and return:
 *   { exitCode, stdout, stderr, durationMs }
 *
 * See notch-pipeline/ for the companion Modal sandbox function. Users
 * configure endpoint + token in `.notch.json` under `terminal.modal`.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';

const DEFAULT_MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ModalTerminalOptions {
  /** Public HTTPS endpoint of your Modal function. Required. */
  endpoint: string;
  /** Bearer token / proxy auth header value (if your function requires it). */
  authToken?: string;
  /** Header name for the auth token. Default `Authorization` with `Bearer` prefix. */
  authHeaderName?: string;
  /**
   * Workspace / app name — attached to diagnostics so the user can
   * identify which Modal app ran a given command.
   */
  app?: string;
  /** Extra HTTP headers to include on every request. */
  extraHeaders?: Readonly<Record<string, string>>;
}

export class ModalTerminal implements TerminalBackend {
  readonly id = 'modal';
  readonly description: string;

  constructor(private readonly opts: ModalTerminalOptions) {
    if (!opts.endpoint) throw new Error('ModalTerminal: endpoint is required');
    try {
      new URL(opts.endpoint);
    } catch {
      throw new Error(`ModalTerminal: endpoint is not a valid URL: ${opts.endpoint}`);
    }
    this.description = `Execute via Modal function at \`${opts.endpoint}\`.`;
  }

  async readyCheck(): Promise<void> {
    // Lightweight GET probe — the endpoint should answer something non-5xx
    // when hit without a body. If it refuses GET entirely, assume callable.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(this.opts.endpoint, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500) {
        throw new Error(`Modal endpoint returned ${res.status} on readiness probe`);
      }
    } catch (err: any) {
      // Probe failure is informational only — many serverless endpoints
      // respond differently to GET vs POST. Only throw if the URL is
      // clearly unreachable (fetch threw).
      if (err?.name === 'AbortError') return;
      if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
        throw new Error(`Modal endpoint unreachable: ${err.message}`);
      }
      // Other responses (401, 405, etc.) are treated as "the server is up".
    }
  }

  async run(req: TerminalRunRequest): Promise<TerminalRunResult> {
    const start = Date.now();
    const maxChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);

    // Bridge the request AbortSignal to ours.
    let requestAbortBridge: (() => void) | undefined;
    if (req.signal) {
      requestAbortBridge = (): void => controller.abort();
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', requestAbortBridge, { once: true });
    }

    try {
      const body = JSON.stringify({
        command: req.command,
        cwd: req.cwd,
        env: req.env,
        timeoutMs,
      });
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.buildHeaders(),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (req.signal && requestAbortBridge) {
        req.signal.removeEventListener('abort', requestAbortBridge);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          exitCode: null,
          stdout: '',
          stderr: `Modal HTTP ${res.status}: ${errText.slice(0, 1000)}`,
          durationMs: Date.now() - start,
          diagnostics: { backend: 'modal', status: res.status, app: this.opts.app },
        };
      }

      const payload = (await res.json()) as {
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
        durationMs?: number;
      };

      let stdout = payload.stdout ?? '';
      let stderr = payload.stderr ?? '';
      let truncated = false;
      if (stdout.length > maxChars) {
        stdout = stdout.slice(0, maxChars);
        truncated = true;
      }
      if (stderr.length > maxChars) {
        stderr = stderr.slice(0, maxChars);
        truncated = true;
      }

      return {
        exitCode: payload.exitCode ?? 0,
        stdout,
        stderr,
        durationMs: payload.durationMs ?? Date.now() - start,
        truncated,
        diagnostics: { backend: 'modal', app: this.opts.app, endpoint: this.opts.endpoint },
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (req.signal && requestAbortBridge) {
        req.signal.removeEventListener('abort', requestAbortBridge);
      }
      const aborted = err?.name === 'AbortError';
      return {
        exitCode: null,
        stdout: '',
        stderr: aborted ? `[timeout] no Modal response within ${timeoutMs}ms` : String(err?.message ?? err),
        durationMs: Date.now() - start,
        diagnostics: { backend: 'modal', error: String(err?.message ?? err), aborted },
      };
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.opts.extraHeaders ?? {}) };
    if (this.opts.authToken) {
      const name = this.opts.authHeaderName ?? 'Authorization';
      headers[name] = this.opts.authHeaderName ? this.opts.authToken : `Bearer ${this.opts.authToken}`;
    }
    return headers;
  }
}
