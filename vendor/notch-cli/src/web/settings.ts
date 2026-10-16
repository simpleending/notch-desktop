import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { getConfigDir } from '../auth.js';

export const webSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  searchProvider: z.enum(['duckduckgo', 'tavily']).default('duckduckgo'),
  browser: z.enum(['auto', 'msedge', 'chrome', 'chromium']).default('auto'),
});
export type WebSettings = z.infer<typeof webSettingsSchema> & { tavilyKey?: string };
const file = () => path.join(getConfigDir(), 'web-research.json');
export const validSearchKey = (key: string) => /^[\x21-\x7e]{12,4096}$/.test(key);

export async function loadWebSettings(): Promise<WebSettings> {
  let stored: unknown = {};
  try { stored = JSON.parse(await fs.readFile(file(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read web settings. Check web-research.json in your notch configuration folder.'); }
  const settings = webSettingsSchema.parse(stored);
  const savedKey = (stored as { tavilyKey?: unknown }).tavilyKey;
  return { ...settings, tavilyKey: process.env.TAVILY_API_KEY || (typeof savedKey === 'string' && validSearchKey(savedKey) ? savedKey : undefined) };
}

export async function saveWebSettings(patch: Partial<WebSettings>): Promise<void> {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(await fs.readFile(file(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const settings = webSettingsSchema.parse({ ...stored, ...patch });
  const key = 'tavilyKey' in patch ? patch.tavilyKey : stored.tavilyKey;
  if (key !== undefined && (typeof key !== 'string' || !validSearchKey(key))) throw new Error('Enter a valid Tavily API key.');
  const target = file(), temporary = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...settings, ...(key ? { tavilyKey: key } : {}) }), { mode: 0o600 });
    await fs.rename(temporary, target); await fs.chmod(target, 0o600);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function installResearchBrowser(onOutput: (text: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const interrupted = new AbortController();
  const activeSignal = AbortSignal.any([...(signal ? [signal] : []), interrupted.signal, AbortSignal.timeout(15 * 60_000)]);
  const interrupt = () => interrupted.abort();
  activeSignal.throwIfAborted(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium', '--only-shell'], {
      windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stopping = false;
    const stop = () => {
      if (stopping || !child.pid || child.exitCode !== null) return;
      stopping = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
    };
    activeSignal.addEventListener('abort', stop, { once: true }); if (activeSignal.aborted) stop();
    child.stdout.on('data', data => onOutput(String(data))); child.stderr.on('data', data => onOutput(String(data)));
    child.on('error', error => { activeSignal.removeEventListener('abort', stop); reject(error); });
    child.on('close', code => {
      activeSignal.removeEventListener('abort', stop);
      if (activeSignal.aborted) reject(new Error('Browser installation canceled or timed out. Retry in Web research settings.'));
      else if (code === 0) resolve();
      else reject(new Error(`Browser installation failed (${code}). Check your connection, then retry in Web research settings.`));
    });
  }); } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
