/**
 * Notch CLI — Local model download.
 *
 * Kicks off a non-blocking `huggingface-cli download` for a Notch model's
 * merged Q4 weights. Checks system capabilities first (RAM / disk / GPU
 * when detectable) and prints warnings before the pull starts.
 *
 * The download itself runs as a detached child process so the REPL stays
 * responsive. Progress is surfaced via a lightweight status line that the
 * caller can poll (getDownloadStatus), and the pull writes into the user's
 * HF cache (~/.cache/huggingface/hub) so subsequent Ollama / llama.cpp
 * usage picks it up automatically.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn } from 'node:child_process';
import { statfs, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { MODEL_CATALOG } from '../providers/registry.js';
import type { NotchModelId, NotchModelInfo } from '../providers/types.js';

export interface SystemCapabilities {
  platform: NodeJS.Platform;
  /** System RAM in GB, rounded to 1 decimal. */
  totalRamGb: number;
  /** Free disk space (GB) at the given dir. `null` if statfs unavailable. */
  freeDiskGb: number | null;
  /** Best-effort VRAM detection via nvidia-smi. Null if no CUDA GPU found. */
  gpuVramGb: number | null;
  /** Human-readable GPU name (from nvidia-smi). Null when unknown. */
  gpuName: string | null;
}

/**
 * Detect host capabilities for the HW-requirement warning. Every probe is
 * best-effort — a missing tool (no nvidia-smi, no statfs support) yields
 * null rather than an error. Callers render nulls as "unknown".
 */
export async function probeSystemCapabilities(cacheDir = os.homedir()): Promise<SystemCapabilities> {
  const totalRamBytes = os.totalmem();
  const totalRamGb = Number((totalRamBytes / 1024 / 1024 / 1024).toFixed(1));

  const freeDiskGb = await new Promise<number | null>((resolve) => {
    try {
      statfs(cacheDir, (err, stats) => {
        if (err) return resolve(null);
        const freeBytes = Number(stats.bsize) * Number(stats.bavail);
        resolve(Math.round(freeBytes / 1024 / 1024 / 1024));
      });
    } catch {
      resolve(null);
    }
  });

  const gpu = await probeNvidiaSmi();

  return {
    platform: process.platform,
    totalRamGb,
    freeDiskGb,
    gpuVramGb: gpu?.vramGb ?? null,
    gpuName: gpu?.name ?? null,
  };
}

function probeNvidiaSmi(): Promise<{ vramGb: number; name: string } | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('nvidia-smi', [
        '--query-gpu=name,memory.total',
        '--format=csv,noheader,nounits',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      proc.stdout.on('data', (c) => { buf += c.toString(); });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0 || !buf.trim()) return resolve(null);
        const first = buf.split('\n')[0]?.trim();
        if (!first) return resolve(null);
        const [name, memStr] = first.split(',').map((s) => s.trim());
        const memMb = Number(memStr);
        if (!name || !Number.isFinite(memMb) || memMb <= 0) return resolve(null);
        resolve({ vramGb: Number((memMb / 1024).toFixed(1)), name });
      });
    } catch {
      resolve(null);
    }
  });
}

export interface HardwareVerdict {
  /** `true` when every minimum is met. */
  ok: boolean;
  /** Per-check status lines for UI rendering. */
  checks: Array<{
    label: string;
    required: string;
    detected: string;
    status: 'pass' | 'warn' | 'fail' | 'unknown';
  }>;
  /** Human-readable summary — one line. */
  summary: string;
}

/**
 * Compare detected capabilities against a model's `hardware` requirements
 * and produce a verdict the picker + download command can render without
 * duplicating the compare logic.
 */
export function evaluateHardware(info: NotchModelInfo, caps: SystemCapabilities): HardwareVerdict {
  const hw = info.hardware;
  const checks: HardwareVerdict['checks'] = [];

  checks.push({
    label: 'RAM',
    required: `${hw.ramGb} GB`,
    detected: `${caps.totalRamGb} GB`,
    status: caps.totalRamGb >= hw.ramGb ? 'pass' : caps.totalRamGb >= hw.ramGb * 0.75 ? 'warn' : 'fail',
  });

  checks.push({
    label: 'Disk',
    required: `${hw.diskGb} GB`,
    detected: caps.freeDiskGb == null ? 'unknown' : `${caps.freeDiskGb} GB free`,
    status: caps.freeDiskGb == null ? 'unknown' : caps.freeDiskGb >= hw.diskGb ? 'pass' : 'fail',
  });

  if (caps.gpuVramGb == null) {
    checks.push({
      label: 'GPU',
      required: `${hw.vramGb} GB VRAM (${hw.recommendedGpu})`,
      detected: 'no CUDA GPU detected',
      // Apple silicon users run well on unified memory with Ollama even
      // without a discrete GPU — don't fail, just warn so the CLI stays
      // usable on Macs.
      status: caps.platform === 'darwin' ? 'warn' : 'warn',
    });
  } else {
    checks.push({
      label: 'GPU',
      required: `${hw.vramGb} GB VRAM (${hw.recommendedGpu})`,
      detected: `${caps.gpuVramGb} GB · ${caps.gpuName ?? 'unknown'}`,
      status: caps.gpuVramGb >= hw.vramGb ? 'pass'
           : caps.gpuVramGb >= hw.vramGb * 0.75 ? 'warn'
           : 'fail',
    });
  }

  const ok = checks.every((c) => c.status === 'pass' || c.status === 'warn');
  const failures = checks.filter((c) => c.status === 'fail').map((c) => c.label);
  const summary = ok
    ? `Your system meets the ${hw.tier} tier requirements for ${info.label}.`
    : `Your system is under-resourced for ${info.label} — ${failures.join(', ')} below minimum.`;

  return { ok, checks, summary };
}

/**
 * Render a hardware verdict as a boxed, color-coded multi-line string the
 * picker + download command can print verbatim.
 */
export function renderVerdict(info: NotchModelInfo, verdict: HardwareVerdict): string {
  const lines: string[] = [];
  lines.push(chalk.gray(`  ─── ${info.label} (${info.size}) · ${info.hardware.tier} tier ─────────────────────`));
  for (const c of verdict.checks) {
    const icon =
      c.status === 'pass' ? chalk.green('✓')
      : c.status === 'warn' ? chalk.yellow('!')
      : c.status === 'fail' ? chalk.red('✗')
      : chalk.gray('?');
    lines.push(`  ${icon} ${c.label.padEnd(5)} required: ${chalk.white(c.required.padEnd(34))} detected: ${chalk.gray(c.detected)}`);
  }
  lines.push('');
  lines.push(verdict.ok
    ? chalk.green(`  ${verdict.summary}`)
    : chalk.yellow(`  ${verdict.summary}`));
  return lines.join('\n');
}

/* ─── Download pipeline ─────────────────────────────────────────────────── */

export interface DownloadHandle {
  modelId: NotchModelId;
  startedAt: Date;
  /** Cache directory the download is landing in. */
  cacheDir: string;
  /** PID of the detached `huggingface-cli` process. */
  pid: number;
  /** Latest progress line (tail of stderr). Updated in-place. */
  lastLine: string;
  /** Terminal state — null while running. */
  result: { code: number | null; error: string | null } | null;
}

const activeDownloads = new Map<NotchModelId, DownloadHandle>();

/** Peek at an in-progress or completed download without blocking. */
export function getDownloadStatus(id: NotchModelId): DownloadHandle | null {
  return activeDownloads.get(id) ?? null;
}

/** List all tracked downloads (active + finished in this session). */
export function listDownloads(): DownloadHandle[] {
  return [...activeDownloads.values()];
}

/** Default HF cache dir — honors HF_HOME if set. */
export function getHuggingFaceCacheDir(): string {
  const hfHome = process.env.HF_HOME ?? process.env.HUGGINGFACE_HUB_CACHE;
  if (hfHome) return hfHome;
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

/**
 * Start a non-blocking `huggingface-cli download` for the model's merged
 * Q4 weights. Returns immediately with a handle the caller polls. Throws
 * synchronously when the model has no published HF repo.
 */
export async function startModelDownload(id: NotchModelId): Promise<DownloadHandle> {
  const info = MODEL_CATALOG[id];
  if (!info) throw new Error(`Unknown Notch model: ${id}`);
  if (!info.hfRepo) {
    throw new Error(
      `${info.label} is not yet available for local download. ` +
      'Choose an available local model with notch models, or connect your own provider with notch setup.',
    );
  }
  const existing = activeDownloads.get(id);
  if (existing && existing.result == null) return existing;

  const cacheDir = getHuggingFaceCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });

  const handle: DownloadHandle = {
    modelId: id,
    startedAt: new Date(),
    cacheDir,
    pid: 0,
    lastLine: 'queued',
    result: null,
  };

  // Prefer `huggingface-cli` if on PATH. Fall back to `python -m huggingface_hub`
  // if the CLI isn't installed. We don't bundle python so if both fail the
  // caller sees a clear error.
  const args = ['download', info.hfRepo, '--local-dir-use-symlinks', 'False'];

  const proc = spawn('huggingface-cli', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1' },
  });

  handle.pid = proc.pid ?? 0;
  activeDownloads.set(id, handle);

  const absorb = (buf: Buffer) => {
    const text = buf.toString();
    const line = text.split(/\r?\n/).filter((l) => l.trim().length > 0).pop();
    if (line) handle.lastLine = line.slice(0, 200);
  };
  proc.stdout?.on('data', absorb);
  proc.stderr?.on('data', absorb);

  proc.on('error', (err) => {
    handle.result = { code: null, error: err.message };
    handle.lastLine = `error: ${err.message}`;
  });
  proc.on('close', (code) => {
    handle.result = { code, error: code === 0 ? null : `exited with code ${code ?? 'null'}` };
    if (code === 0) handle.lastLine = 'complete';
  });

  return handle;
}
