/**
 * Notch CLI — Stored Ollama credentials
 *
 * Shared credential file used by both `notch ollama login/logout` (which
 * writes) and the main `loadConfig` flow (which reads). Split into its
 * own module so config.ts can import without pulling in the whole
 * `notch ollama` subcommand tree.
 *
 * Location:
 *   Windows:       %APPDATA%\notch\ollama.json
 *   macOS / Linux: $XDG_CONFIG_HOME/notch/ollama.json  (fallback ~/.config)
 *
 * File mode: 0600 (parent dir 0700) on every platform that honours it.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface StoredOllamaCreds {
  /** OLLAMA_API_KEY captured via `notch ollama login`. */
  apiKey: string;
  /** Normalised endpoint the key was captured for. */
  endpoint: string;
  /** Unix ms of capture — for audit and forced-rotation. */
  createdAt: number;
}

/**
 * Resolve the config directory for Notch in a cross-platform way.
 * Throws when no home directory is discoverable so callers get a clear
 * error instead of silently writing to the wrong place.
 */
export function notchConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'notch');
  const appdata = process.env.APPDATA;
  if (appdata && process.platform === 'win32') return path.join(appdata, 'notch');
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('Cannot determine home directory for credential storage.');
  }
  return path.join(home, '.config', 'notch');
}

export function ollamaCredsPath(): string {
  return path.join(notchConfigDir(), 'ollama.json');
}

export async function readOllamaCreds(): Promise<StoredOllamaCreds | null> {
  try {
    const raw = await fs.readFile(ollamaCredsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredOllamaCreds>;
    if (typeof parsed.apiKey !== 'string' || typeof parsed.endpoint !== 'string') return null;
    return {
      apiKey: parsed.apiKey,
      endpoint: parsed.endpoint,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function writeOllamaCreds(creds: StoredOllamaCreds): Promise<void> {
  const dir = notchConfigDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = ollamaCredsPath();
  await fs.writeFile(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export async function clearOllamaCreds(): Promise<void> {
  try {
    await fs.unlink(ollamaCredsPath());
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}
