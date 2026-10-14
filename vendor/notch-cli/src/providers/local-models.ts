import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export const GiB = 2 ** 30;
export type LocalRunner = 'ollama' | 'mlx';
export interface LocalHardware {
  platform: string; arch: string; appleSilicon: boolean; mlxSupported: boolean;
  totalMemory: number; availableMemory: number; availableVram: number;
  totalVram?: number;
  installedMemory?: number;
}
export function supportsMlx(platform: string, appleSilicon: boolean, darwinMajor: number): boolean {
  return platform === 'darwin' && appleSilicon && darwinMajor >= 23;
}

export function parseNvidiaMemory(stdout: string): { totalVram: number; availableVram: number } {
  const rows = stdout.trim().split(/\r?\n/).map(row => row.split(',').map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(n => Number.isSafeInteger(n) && n >= 0) && row[0]! > 0 && row[1]! <= row[0]!);
  const selected = rows.sort((a,b) => b[1] - a[1])[0];
  if (!selected) throw new Error('GPU memory telemetry is unavailable.');
  return { totalVram: selected[0] * 2 ** 20, availableVram: selected[1] * 2 ** 20 };
}

export async function linuxGpuMemory(root = '/sys/class/drm'): Promise<{ totalVram: number; availableVram: number }> {
  let selected = { totalVram: 0, availableVram: 0 };
  for (const card of (await readdir(root)).filter(name => /^card\d+$/.test(name))) {
    try {
      const device = path.join(root,card,'device');
      const [total,used] = (await Promise.all(['mem_info_vram_total','mem_info_vram_used'].map(name => readFile(path.join(device,name),'utf8')))).map(Number);
      if (Number.isSafeInteger(total) && total! > 0 && Number.isSafeInteger(used) && used! >= 0 && used! <= total! && total! - used! > selected.availableVram) selected = { totalVram: total!, availableVram: total! - used! };
    } catch { /* Ignore adapters without verified dedicated VRAM telemetry. */ }
  }
  return selected;
}

export async function detectLocalHardware(refresh = false): Promise<LocalHardware> {
  const platform = os.platform();
  const arch = os.arch();
  let appleSilicon = platform === 'darwin' && arch === 'arm64';
  if (platform === 'darwin' && !appleSilicon) {
    try { appleSilicon = (await exec('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 2000 })).stdout.trim() === '1'; } catch { /* Intel or unavailable. */ }
  }
  let availableVram = 0;
  let totalVram = 0;
  let installedMemory = os.totalmem();
  if (!appleSilicon) {
    const candidates = ['nvidia-smi', ...(platform === 'win32' ? [path.join(process.env.WINDIR || 'C:/Windows', 'System32/nvidia-smi.exe')] : [])];
    for (const executable of candidates) {
      try {
        const { stdout } = await exec(executable, ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: 2500, windowsHide: true });
        ({ availableVram, totalVram } = parseNvidiaMemory(stdout));
        break;
      } catch { /* GPU telemetry is optional; unknown memory is not assumed available. */ }
    }
  }
  if (platform === 'win32' && availableVram === 0) {
    try {
      const { windowsMemory } = await import('./windows-memory.js');
      const result = await windowsMemory(refresh);
      installedMemory = result.installedMemory; availableVram = result.availableVram; totalVram = result.totalVram;
    } catch { /* Keep the conservative RAM-only estimate if native telemetry is unavailable. */ }
  }
  if (platform === 'linux' && totalVram === 0) {
    try { ({ availableVram, totalVram } = await linuxGpuMemory()); } catch { /* Retain RAM-only sizing. */ }
  }
  return { platform, arch, appleSilicon, mlxSupported: supportsMlx(platform, appleSilicon, Number(os.release().split('.')[0])),
    totalMemory: os.totalmem(), installedMemory, availableMemory: Math.min(os.freemem(), process.availableMemory()), availableVram, totalVram };
}

export const LOCAL_MODEL_CATALOG = [
  { label: 'Qwen3.5 4B', gguf: 'unsloth/Qwen3.5-4B-GGUF', mlx: 'mlx-community/Qwen3.5-4B-4bit', ollamaBase: 'qwen3.5:4b' },
  { label: 'Qwen3.5 9B', gguf: 'unsloth/Qwen3.5-9B-GGUF', mlx: 'mlx-community/Qwen3.5-9B-4bit', ollamaBase: 'qwen3.5:9b' },
  { label: 'Qwen3 Coder 30B', gguf: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', mlx: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit', ollamaBase: 'qwen3-coder:30b' },
];

export interface HubModel {
  repo: string; runner: LocalRunner; model: string; bytes: number; license?: string;
  ollamaBase?: string;
  createdAt?: string;
  fetchedAt?: number;
  source?: 'live' | 'cache';
  contextLength?: number;
}
async function fetchHubModel(repo: string, runner: LocalRunner, signal?: AbortSignal, token?: string): Promise<HubModel> {
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error('Use a Hugging Face repository id in owner/model form.');
  const response = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Cannot inspect ${repo} (HTTP ${response.status}). Choose an accessible public model.`);
  const body = await response.json() as { sha?: string; createdAt?: string; gated?: boolean | string; cardData?: { license?: string }; siblings?: { rfilename: string; size?: number; lfs?: { size: number } }[] };
  if (body.gated) throw new Error(`${repo} is gated. The guided installer supports public models that need no account.`);
  const weights = body.siblings?.filter(file => runner === 'mlx'
    ? /\.safetensors$/i.test(file.rfilename)
    : /Q4_K_M(?:-\d+-of-\d+)?\.gguf$/i.test(file.rfilename) && !/mmproj/i.test(file.rfilename)) ?? [];
  const bytes = weights.reduce((sum, file) => sum + (file.size ?? file.lfs?.size ?? 0), 0);
  if (!weights.length || !Number.isSafeInteger(bytes) || bytes <= 0 || weights.some(file => !Number.isSafeInteger(file.size ?? file.lfs?.size) || (file.size ?? file.lfs?.size ?? 0) <= 0)) {
    throw new Error(`${repo} has no verifiable ${runner === 'mlx' ? 'MLX safetensors' : 'Q4_K_M GGUF'} weights.`);
  }
  let contextLength: number | undefined;
  if (runner === 'mlx') {
    const revision = typeof body.sha === 'string' && /^[a-f0-9]{40}$/.test(body.sha) ? body.sha : 'main';
    const configResponse = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/config.json`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!configResponse.ok) throw new Error(`Cannot verify ${repo}'s native context limit (HTTP ${configResponse.status}).`);
    const config = await configResponse.json();
    contextLength = config.text_config?.max_position_embeddings ?? config.max_position_embeddings ?? config.max_seq_len ?? config.seq_length;
    if (!Number.isSafeInteger(contextLength) || contextLength! < 2048) throw new Error(`${repo} has no verifiable native context limit.`);
  }
  return { repo, runner, model: runner === 'mlx' ? repo : `hf.co/${repo}:Q4_K_M`, bytes, license: body.cardData?.license, ...(contextLength ? { contextLength } : {}),
    ...(typeof body.createdAt === 'string' && Number.isFinite(Date.parse(body.createdAt)) ? { createdAt: new Date(body.createdAt).toISOString() } : {}),
    fetchedAt: Date.now(), source: 'live',
    ...(runner === 'ollama' ? { ollamaBase: LOCAL_MODEL_CATALOG.find(row => row.gguf === repo)?.ollamaBase } : {}) };
}

export async function inspectHubModel(repo: string, runner: LocalRunner, signal?: AbortSignal, token?: string, refresh = false): Promise<HubModel> {
  signal?.throwIfAborted();
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error('Use a Hugging Face repository id in owner/model form.');
  const file = path.join(os.homedir(), '.notch', 'cache', 'hub-models', `${runner}-${repo.replace('/', '--')}.json`);
  let cached: HubModel | undefined;
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as HubModel;
    if (value.repo === repo && value.runner === runner && value.model === (runner === 'mlx' ? repo : `hf.co/${repo}:Q4_K_M`)
      && Number.isSafeInteger(value.bytes) && value.bytes > 0 && Number.isFinite(value.fetchedAt) && value.fetchedAt! <= Date.now()) cached = value;
    if (!refresh && cached && Date.now() - cached.fetchedAt! < 6 * 60 * 60 * 1000) return { ...cached, source: 'cache' };
  } catch { /* Cache is optional, including corrupt or stale files. */ }
  try {
    const value = await fetchHubModel(repo, runner, signal, token);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, file);
    } catch { await unlink(temporary).catch(() => {}); }
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (!refresh && cached) return { ...cached, source: 'cache' };
    throw error;
  }
}

/** Reserve room for the OS, context/cache and loading; this is an estimate, not a fit guarantee. */
export function modelFit(model: HubModel, hardware: LocalHardware) {
  const usableRam = Math.max(0, Math.min(hardware.availableMemory - GiB, hardware.totalMemory * 0.75));
  const usableVram = hardware.appleSilicon ? 0 : Math.max(0, hardware.availableVram - GiB);
  const required = model.bytes * 1.2 + 1.5 * GiB;
  const budget = usableRam + usableVram;
  return { fits: required <= budget, required, budget, contextLength: required + 2 * GiB <= budget ? 16384 : 8192, batchSize: 64 };
}
