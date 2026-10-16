/**
 * Notch CLI — Local terminal backend.
 *
 * Runs the command in the host process via `child_process.exec` with
 * stdout/stderr size caps, wall-clock timeout, and cooperative abort.
 * Default backend when `.notch.json`'s `terminal.backend` is `"local"`
 * or absent.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn } from 'node:child_process';
import type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';

const DEFAULT_MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export class LocalTerminal implements TerminalBackend {
  readonly id = 'local';
  readonly description = 'Execute on the host via child_process.spawn.';

  async readyCheck(): Promise<void> {
    // Always ready — we're the host.
  }

  run(req: TerminalRunRequest): Promise<TerminalRunResult> {
    if (req.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: '[aborted]', durationMs: 0 });
    const maxChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', `"${req.command}"`] : ['-lc', req.command];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let aborted = false;

      const child = spawn(shell, shellArgs, {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        windowsHide: true,
        windowsVerbatimArguments: isWin,
        detached: !isWin,
      });

      let stopping = false;
      const stop = () => {
        if (stopping || !child.pid || child.exitCode !== null) return;
        stopping = true;
        if (isWin) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        stop();
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }

      const onData = (text: string, which: 'stdout' | 'stderr'): void => {
        const current = which === 'stdout' ? stdout : stderr;
        const remaining = maxChars - current.length;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        if (text.length <= remaining) {
          if (which === 'stdout') stdout += text;
          else stderr += text;
        } else {
          if (which === 'stdout') stdout += text.slice(0, remaining);
          else stderr += text.slice(0, remaining);
          truncated = true;
        }
      };

      child.stdout.setEncoding('utf8').on('data', (text: string) => onData(text, 'stdout'));
      child.stderr.setEncoding('utf8').on('data', (text: string) => onData(text, 'stderr'));

      child.on('close', (code, sig) => {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (timedOut && !stderr.includes('[timeout]')) {
          stderr = (stderr ? `${stderr}\n` : '') + `[timeout] killed after ${timeoutMs}ms`;
        }
        if (aborted && !stderr.includes('[aborted]')) {
          stderr = (stderr ? `${stderr}\n` : '') + `[aborted]`;
        }
        resolve({
          exitCode: sig ? null : code ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          truncated,
          diagnostics: { backend: 'local', shell, pid: child.pid, signal: sig },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        resolve({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs: Date.now() - start,
          diagnostics: { backend: 'local', error: err.message },
        });
      });
    });
  }
}
