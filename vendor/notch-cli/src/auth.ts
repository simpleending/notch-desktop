/** Local provider-key storage. No FreeSyntax account or network service is used. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';

export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? os.homedir(), 'notch');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return path.join(xdg ?? path.join(os.homedir(), '.config'), 'notch');
}

export interface SyncedByokKeys {
  email: string;
  keys: Partial<Record<string, string>>;
  localEndpoint: string | null;
}

export function getByokSyncPath(): string {
  return path.join(getConfigDir(), 'byok-sync.json');
}

export async function saveLocalByokKey(providerId: string, apiKey: string): Promise<SyncedByokKeys> {
  const existing = await loadSyncedByokKeys();
  const next: SyncedByokKeys & { syncedAt: string; source: string } = {
    email: existing?.email ?? 'local',
    keys: {
      ...(existing?.keys ?? {}),
      [providerId]: apiKey,
    },
    localEndpoint: existing?.localEndpoint ?? null,
    syncedAt: new Date().toISOString(),
    source: 'local-wizard',
  };

  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getByokSyncPath(),
    JSON.stringify(next, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
  invalidateSyncedKeysCache();
  return next;
}

/**
 * Read the last synced BYOK stash without hitting the network. Returns
 * null if no sync has happened yet — callers should treat that as
 * "nothing to merge" rather than an error.
 */
export async function loadSyncedByokKeys(): Promise<SyncedByokKeys | null> {
  try {
    const raw = await fs.readFile(getByokSyncPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.keys) return parsed as SyncedByokKeys;
    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronous variant — used by `providers/byok.ts::resolveByokModel` on
 * the hot path where we can't await. Cached after first read since the
 * keys don't change mid-session (local key changes invalidate the cache).
 */
let syncedKeysCache: SyncedByokKeys | null | undefined;
export function loadSyncedByokKeysSync(): SyncedByokKeys | null {
  if (syncedKeysCache !== undefined) return syncedKeysCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = readFileSync(getByokSyncPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.keys) {
      syncedKeysCache = parsed as SyncedByokKeys;
    } else {
      syncedKeysCache = null;
    }
  } catch {
    syncedKeysCache = null;
  }
  return syncedKeysCache;
}

/** Invalidate the cache — call after local key changes so next resolve picks up fresh. */
export function invalidateSyncedKeysCache(): void {
  syncedKeysCache = undefined;
}
