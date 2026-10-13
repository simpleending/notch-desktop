/**
 * Notch CLI — Authentication
 *
 * Browser-based OAuth-style login flow. Opens freesyntax.dev in the user's
 * browser, which generates a Notch API key and redirects back to a
 * short-lived localhost server that captures the token.
 *
 * Security:
 *   - CSRF state parameter (32 random hex chars, verified on callback)
 *   - Credentials stored in ~/.config/notch/credentials.json (mode 0600)
 *   - Localhost server shuts down immediately after capturing token
 *   - 5-minute timeout if user never completes auth
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import http from 'node:http';
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const FREESYNTAX_URL = 'https://freesyntax.dev';
const PREFERRED_PORT = 9721;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Credential storage ───────────────────────────────────────────────────────

export interface Credentials {
  token: string;
  email: string;
  createdAt: string;
}

export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? os.homedir(), 'notch');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return path.join(xdg ?? path.join(os.homedir(), '.config'), 'notch');
}

export function getCredentialsPath(): string {
  return path.join(getConfigDir(), 'credentials.json');
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(getCredentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.token === 'string' && typeof parsed.email === 'string') {
      return parsed as Credentials;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveCredentials(token: string, email: string): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  const credPath = getCredentialsPath();
  const creds: Credentials = { token, email, createdAt: new Date().toISOString() };
  await fs.writeFile(credPath, JSON.stringify(creds, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(getCredentialsPath());
  } catch {
    // Already removed — nothing to do
  }
}

/* ─── BYOK key sync ─────────────────────────────────────────────────────── */

/**
 * Exportable key shape returned by `GET /api/cli/keys`. Mirrors the
 * EXPORTABLE_KEY_FIELDS allow-list on the server.
 */
export interface SyncedByokKeys {
  email: string;
  keys: Partial<Record<string, string>>;
  localEndpoint: string | null;
}

export function getByokSyncPath(): string {
  return path.join(getConfigDir(), 'byok-sync.json');
}

/**
 * Fetch the user's BYOK stash from freesyntax.dev using the stored Notch
 * API key. Writes a cached copy to `~/.config/notch/byok-sync.json` so the
 * sync is reproducible between runs and downstream resolvers (byok.ts) can
 * read it without a live network call on every `resolveModel`.
 *
 * Key loading priority at resolution time (handled elsewhere): env vars
 * win over the sync file — keys the user exports in their shell always
 * take precedence so CI / scripted runs are unaffected.
 */
export async function syncByokKeys(token: string, baseUrl = FREESYNTAX_URL): Promise<SyncedByokKeys> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/cli/keys`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Key sync failed (${res.status}): ${body.slice(0, 200) || res.statusText}`);
  }
  const data = await res.json() as SyncedByokKeys;
  // Persist to disk so downstream readers (providers/byok.ts) can pick
  // up the keys on next CLI invocation.
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getByokSyncPath(),
    JSON.stringify({ ...data, syncedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
  return data;
}

/**
 * Store or update a provider key locally. This uses the same cache file as
 * `syncByokKeys` so model resolution has a single provider-key lookup path.
 */
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
 * keys don't change mid-session (rotation requires `notch sync-keys`).
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

/** Invalidate the cache — call after `syncByokKeys` so next resolve picks up fresh. */
export function invalidateSyncedKeysCache(): void {
  syncedKeysCache = undefined;
}

// ─── Browser launcher ─────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'win32') {
    // Escape special chars for cmd.exe
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {}); // fire and forget
}

// ─── Port finder ──────────────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(PREFERRED_PORT, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // Preferred port busy — let the OS pick one
      const fallback = http.createServer();
      fallback.listen(0, () => {
        const port = (fallback.address() as { port: number }).port;
        fallback.close(() => resolve(port));
      });
    });
  });
}

// ─── CSRF state ───────────────────────────────────────────────────────────────

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Login flow ───────────────────────────────────────────────────────────────

/**
 * Launch the browser-based login flow.
 * Resolves with the captured credentials on success.
 * Rejects on error or timeout.
 */
export async function login(): Promise<Credentials> {
  const state = generateState();
  const port = await findFreePort();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        server.close(fn);
      }
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const receivedState = url.searchParams.get('state');
      const token = url.searchParams.get('token');
      const email = url.searchParams.get('email');
      const error = url.searchParams.get('error');

      // Always respond to the browser before closing
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (error || receivedState !== state || !token || !email) {
        res.end(HTML_ERROR);
        finish(() => reject(new Error(error ?? 'Authentication failed. Please try again.')));
        return;
      }

      res.end(HTML_SUCCESS);
      finish(async () => {
        await saveCredentials(token, email);
        resolve({ token, email, createdAt: new Date().toISOString() });
      });
    });

    server.on('error', (err) => {
      finish(() => reject(new Error(`Failed to start local server: ${err.message}`)));
    });

    server.listen(port, () => {
      const authUrl = `${FREESYNTAX_URL}/cli-auth?port=${port}&state=${state}`;
      openBrowser(authUrl);
      // Printed by the caller for UX consistency
      process.stdout.write(`\n  If browser did not open automatically, visit:\n  ${authUrl}\n\n`);
    });

    // Timeout guard
    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('Authentication timed out after 5 minutes.')));
    }, AUTH_TIMEOUT_MS);
  });
}

// ─── HTML responses sent to the browser ──────────────────────────────────────

const HTML_BASE = (body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Notch CLI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@200;400&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: #000;
      color: #cfcfcf;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card { text-align: center; }
    .brand { color: #CE2127; font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; }
    h1 { font-weight: 200; font-size: 22px; margin: 14px 0 10px; letter-spacing: 0.05em; }
    p { font-size: 11px; color: #555; letter-spacing: 0.1em; line-height: 1.8; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;

const HTML_SUCCESS = HTML_BASE(`
  <div class="brand">notch_</div>
  <h1>CLI authorized</h1>
  <p>You can close this tab and return to your terminal.</p>
`);

const HTML_ERROR = HTML_BASE(`
  <div class="brand">notch_</div>
  <h1>Authorization failed</h1>
  <p style="color:#CE2127">Run <code>notch login</code> again to retry.</p>
`);
