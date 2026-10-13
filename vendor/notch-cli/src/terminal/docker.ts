/**
 * Notch CLI — Docker terminal backend.
 *
 * Runs every command inside an ephemeral container derived from a
 * configured image. The workspace is bind-mounted read/write by default
 * (configurable). Intended for agent workflows where host isolation is
 * wanted — e.g. trialing risky commands without touching the host.
 *
 * Requires `docker` on PATH. Container lifecycle is per-command: spawn,
 * run, exit. No long-lived container. For lower per-command overhead,
 * use a `docker exec` variant (future work).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';

const exec = promisify(execFile);
const DEFAULT_MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface DockerTerminalOptions {
  /** Base image (e.g. `alpine:3.19`, `ubuntu:24.04`, `node:22-slim`). Required. */
  image: string;
  /**
   * Host path to bind-mount at `/workspace`. Typically the project root.
   * If omitted, the container runs with no mount (stateless).
   */
  hostWorkspace?: string;
  /**
   * Path inside the container where the workspace is mounted.
   * Default `/workspace`.
   */
  containerWorkspace?: string;
  /** When true, mount the workspace read-only. Default false. */
  readOnly?: boolean;
  /** Extra args passed to `docker run` (e.g. `--network none`). */
  extraRunArgs?: readonly string[];
  /**
   * Env vars to pass to EVERY command (merged with per-request env).
   * Useful for CI_* flags or credentials that shouldn't rotate per call.
   */
  baseEnv?: Readonly<Record<string, string>>;
  /**
   * Override the shell inside the container. Default `/bin/sh` — change
   * to `/bin/bash` for images that have it.
   */
  shell?: string;
}

export class DockerTerminal implements TerminalBackend {
  readonly id = 'docker';
  readonly description: string;

  constructor(private readonly opts: DockerTerminalOptions) {
    if (!opts.image) throw new Error('DockerTerminal: image is required');
    this.description = `Execute inside ephemeral \`${opts.image}\` containers.`;
  }

  async readyCheck(): Promise<void> {
    try {
      await exec('docker', ['version', '--format', '{{.Client.Version}}'], { timeout: 5000 });
    } catch {
      throw new Error('docker CLI not available (checked `docker version`). Install Docker or switch backend.');
    }
  }

  run(req: TerminalRunRequest): Promise<TerminalRunResult> {
    const start = Date.now();
    const maxChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const shell = this.opts.shell ?? '/bin/sh';
    const containerWorkspace = this.opts.containerWorkspace ?? '/workspace';

    // Translate host cwd under the hostWorkspace to the container path,
    // so commands like `cd src && npm test` work the same way agents
    // expect. If req.cwd is outside the host workspace, fall back to the
    // container workspace root.
    let containerCwd = containerWorkspace;
    if (req.cwd && this.opts.hostWorkspace) {
      const rel = path.relative(this.opts.hostWorkspace, req.cwd);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        containerCwd = path.posix.join(containerWorkspace, rel.split(path.sep).join('/'));
      }
    }

    const envEntries = Object.entries({ ...(this.opts.baseEnv ?? {}), ...(req.env ?? {}) });
    const runArgs: string[] = ['run', '--rm', '-i', '-w', containerCwd];
    if (this.opts.hostWorkspace) {
      const mountMode = this.opts.readOnly ? 'ro' : 'rw';
      runArgs.push('-v', `${this.opts.hostWorkspace}:${containerWorkspace}:${mountMode}`);
    }
    for (const [k, v] of envEntries) {
      runArgs.push('-e', `${k}=${v}`);
    }
    if (this.opts.extraRunArgs) runArgs.push(...this.opts.extraRunArgs);
    runArgs.push(this.opts.image, shell, '-lc', req.command);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const child = spawn('docker', runArgs, { windowsHide: true });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill();
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }

      const onData = (buf: Buffer, which: 'stdout' | 'stderr'): void => {
        const currentLen = which === 'stdout' ? stdout.length : stderr.length;
        const remaining = maxChars - currentLen;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const text = buf.toString('utf-8');
        if (text.length <= remaining) {
          if (which === 'stdout') stdout += text;
          else stderr += text;
        } else {
          if (which === 'stdout') stdout += text.slice(0, remaining);
          else stderr += text.slice(0, remaining);
          truncated = true;
        }
      };

      child.stdout?.on('data', (b) => onData(b, 'stdout'));
      child.stderr?.on('data', (b) => onData(b, 'stderr'));

      child.on('close', (code, sig) => {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (timedOut) {
          stderr = (stderr ? `${stderr}\n` : '') + `[timeout] killed after ${timeoutMs}ms`;
        }
        resolve({
          exitCode: sig ? null : code ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          truncated,
          diagnostics: {
            backend: 'docker',
            image: this.opts.image,
            cwd: containerCwd,
          },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs: Date.now() - start,
          diagnostics: { backend: 'docker', error: err.message },
        });
      });
    });
  }
}
