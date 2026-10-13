import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, access } from 'node:fs/promises';
import { detectDaemon, showModel, type OllamaShowResult } from './ollama.js';
import { ollamaRoot } from './ollama-url.js';
import { detectLocalHardware } from './local-models.js';
import { createServer } from 'node:net';

const exec = promisify(execFile);
const mlxDir = () => path.join(os.homedir(), '.notch', 'runtimes', 'mlx');
const mlxPython = () => path.join(mlxDir(), 'bin', 'python');
export const MLX_URL = 'http://127.0.0.1:11435/v1';
let mlxChild: ChildProcess | undefined;
let mlxModel: string | undefined;
let mlxBaseUrl = MLX_URL;

async function mlxPort(): Promise<number> {
  for (const requested of [11435, 0]) {
    try { return await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.once('error', reject);
      server.listen(requested, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('No local MLX port available.')); return; }
        server.close(error => error ? reject(error) : resolve(address.port));
      });
    }); } catch (error) { if (requested === 0) throw error; }
  }
  throw new Error('No local MLX port available.');
}

export async function ensureOllama(host?: string, signal?: AbortSignal): Promise<string> {
  const root = ollamaRoot(host);
  if (await detectDaemon(root)) return root;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(root).hostname)) throw new Error(`Ollama at ${root} is offline. Start it on the server; local hardware estimates do not describe that host.`);
  if (root !== 'http://localhost:11434' && root !== 'http://127.0.0.1:11434') throw new Error(`Start Ollama at ${root} before installing a model.`);
  const candidates = ['ollama', ...(os.platform() === 'win32' ? [path.join(process.env.LOCALAPPDATA || '', 'Programs/Ollama/ollama.exe'), path.join(process.env.LOCALAPPDATA || '', 'Ollama/ollama.exe')] : [])];
  for (const executable of candidates) {
    try {
      await exec(executable, ['--version'], { timeout: 5000, windowsHide: true, signal });
      const child = spawn(executable, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {}); child.unref();
      for (let attempt = 0; attempt < 30; attempt++) {
        signal?.throwIfAborted();
        if (await detectDaemon(root, { timeoutMs: 1000 })) return root;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Ollama did not start. Run ollama serve and retry.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const { managedOllama } = await import('./ollama-runtime.js');
  return managedOllama('0.30.0', signal);
}

async function runPython(executable: string, args: string[], signal?: AbortSignal): Promise<void> {
  const child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, signal });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Python command failed (exit ${code}).`)));
  });
}

export async function prepareMlx(signal?: AbortSignal): Promise<string> {
  const hardware = await detectLocalHardware();
  if (!hardware.mlxSupported) throw new Error('MLX requires an Apple Silicon Mac (M1 or newer), macOS 14 or newer, and native Python 3.11+.');
  const python = mlxPython();
  let exists = false; try { await access(python); exists = true; } catch { /* First install. */ }
  if (!exists) {
    let nativePython: string | undefined;
    for (const candidate of ['python3.12', 'python3.11', 'python3']) {
      try {
        const { stdout } = await exec(candidate, ['-c', 'import platform,sys; print("ok" if platform.machine()=="arm64" and sys.version_info>=(3,11) else "unsupported")'], { timeout: 5000, signal });
        if (stdout.trim() === 'ok') { nativePython = candidate; break; }
      } catch { signal?.throwIfAborted(); }
    }
    if (!nativePython) throw new Error('Install native Apple Silicon Python 3.11+ (for example: brew install python@3.12), then retry.');
    await mkdir(path.dirname(mlxDir()), { recursive: true });
    await runPython(nativePython, ['-m', 'venv', mlxDir()], signal);
  }
  try {
    const { stdout } = await exec(python, ['-c', 'import importlib.metadata; print(importlib.metadata.version("mlx-lm"))'], { timeout: 10000, signal });
    if (stdout.trim() === '0.32.0') return python;
  } catch { signal?.throwIfAborted(); }
  console.log('Installing MLX LM in a Notch-only Python environment...');
  await runPython(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'mlx-lm==0.32.0'], signal);
  return python;
}

export async function downloadMlx(repo: string, signal?: AbortSignal): Promise<void> {
  const python = await prepareMlx(signal);
  await runPython(python, ['-c', 'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1], allow_patterns=["*.safetensors","*.json","*.model","*.tiktoken","*.txt","*.jinja"])', repo], signal);
}

export async function stopMlx(): Promise<boolean> {
  const child = mlxChild;
  mlxChild = undefined; mlxModel = undefined;
  if (!child || child.exitCode !== null) return false;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
  return true;
}

export async function startMlx(repo: string, signal?: AbortSignal): Promise<string> {
  if (mlxChild && mlxModel === repo && mlxChild.exitCode === null) return mlxBaseUrl;
  await stopMlx();
  const python = await prepareMlx(signal);
  const port = await mlxPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  mlxBaseUrl = `${serverUrl}/v1`;
  const log = await open(path.join(mlxDir(), 'server.log'), 'a', 0o600);
  const child = spawn(python, ['-m', 'mlx_lm.server', '--model', repo, '--host', '127.0.0.1', '--port', String(port), '--prefill-step-size', '512', '--prompt-concurrency', '1', '--decode-concurrency', '1', '--chat-template-args', '{"enable_thinking":false}', '--prompt-cache-size', '2', '--prompt-cache-bytes', '512M'], { stdio: ['ignore', log.fd, log.fd], windowsHide: true });
  await log.close();
  let failure: Error | undefined; child.on('error', error => { failure = error; });
  mlxChild = child; mlxModel = repo; child.unref();
  const cleanup = () => child.kill('SIGTERM');
  process.once('exit', cleanup);
  child.once('close', () => {
    process.removeListener('exit', cleanup);
    if (mlxChild === child) { mlxChild = undefined; mlxModel = undefined; }
  });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      signal?.throwIfAborted();
      if (failure || child.exitCode !== null) throw failure ?? new Error(`MLX stopped. See ${path.join(mlxDir(), 'server.log')}.`);
      const ready = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
      if (ready) return mlxBaseUrl;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`MLX did not become ready. See ${path.join(mlxDir(), 'server.log')}.`);
  } catch (error) { await stopMlx(); throw error; }
}

export async function unloadOllama(model: string, host?: string): Promise<void> {
  const response = await fetch(`${ollamaRoot(host)}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, keep_alive: 0 }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Could not unload model (HTTP ${response.status}).`);
}

export async function checkOllamaTools(model: string, host: string): Promise<OllamaShowResult> {
  const info = await showModel(model, host);
  if (!info.capabilities?.includes('tools')) throw new Error(`${model} does not advertise tool support. It was downloaded, but will not replace the current coding model.`);
  return info;
}
