/**
 * Notch CLI — SSH terminal backend.
 *
 * Runs every command on a remote host over SSH. Assumes SSH is already
 * configured on the host (keys, known_hosts, ~/.ssh/config). No password
 * prompts — if the connection would prompt, the backend fails fast.
 *
 * Requires `ssh` on PATH.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';

const exec = promisify(execFile);
const DEFAULT_MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface SSHTerminalOptions {
  /** Remote target — `user@host` or an entry from `~/.ssh/config`. */
  target: string;
  /** Optional port override (takes precedence over ssh_config). */
  port?: number;
  /** Working directory on the remote side. Default: user's `$HOME`. */
  defaultCwd?: string;
  /** Extra SSH args (`-o`, `-i`, `-L`, etc.). Passed verbatim. */
  extraSshArgs?: readonly string[];
  /**
   * Env vars exported on every command. Remote sshd must accept them —
   * easiest is to use the host's sshd_config `AcceptEnv` directive.
   */
  baseEnv?: Readonly<Record<string, string>>;
  /** Shell on the remote side. Default `/bin/sh`. */
  shell?: string;
}

export class SSHTerminal implements TerminalBackend {
  readonly id = 'ssh';
  readonly description: string;

  constructor(private readonly opts: SSHTerminalOptions) {
    if (!opts.target) throw new Error('SSHTerminal: target is required');
    this.description = `Execute over SSH on \`${opts.target}\`.`;
  }

  async readyCheck(): Promise<void> {
    try {
      // Non-interactive probe: BatchMode refuses to prompt for a password.
      await exec(
        'ssh',
        [
          ...this.sshBaseArgs(),
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          this.opts.target,
          'true',
        ],
        { timeout: 10_000 },
      );
    } catch (err: any) {
      throw new Error(
        `SSH probe to ${this.opts.target} failed. ` +
          `Ensure keys are configured and ssh_config is correct. (${err.message ?? err})`,
      );
    }
  }

  run(req: TerminalRunRequest): Promise<TerminalRunResult> {
    const start = Date.now();
    const maxChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const shell = this.opts.shell ?? '/bin/sh';

    // Build a safe remote command that:
    //   1. cd's into the requested cwd (or default)
    //   2. exports declared env vars
    //   3. runs the user command through `-lc`
    const cwd = req.cwd ?? this.opts.defaultCwd ?? '';
    const envLines: string[] = [];
    const envMerged = { ...(this.opts.baseEnv ?? {}), ...(req.env ?? {}) };
    for (const [k, v] of Object.entries(envMerged)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue; // drop weird keys
      envLines.push(`export ${k}=${shellEscape(v)}`);
    }
    const preamble = [
      cwd ? `cd ${shellEscape(cwd)}` : '',
      ...envLines,
    ]
      .filter(Boolean)
      .join('\n');
    const fullScript = preamble ? `${preamble}\n${req.command}` : req.command;

    const sshArgs = [
      ...this.sshBaseArgs(),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      this.opts.target,
      shell,
      '-lc',
      fullScript,
    ];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const child = spawn('ssh', sshArgs, { windowsHide: true });

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
          diagnostics: { backend: 'ssh', target: this.opts.target, cwd },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs: Date.now() - start,
          diagnostics: { backend: 'ssh', error: err.message },
        });
      });
    });
  }

  private sshBaseArgs(): string[] {
    const args: string[] = [];
    if (this.opts.port) args.push('-p', String(this.opts.port));
    if (this.opts.extraSshArgs) args.push(...this.opts.extraSshArgs);
    return args;
  }
}

/** Minimal shell escape — single-quote wrap, escape embedded single quotes. */
function shellEscape(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
