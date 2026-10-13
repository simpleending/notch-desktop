/**
 * Notch CLI — Auto-Updater
 *
 * True silent self-update (inspired by `openai/codex`). Polls the npm registry
 * at a throttled interval, installs globally when a newer version is available,
 * and can restart the CLI in-place by re-execing through the current Node
 * binary.
 *
 * Features:
 *   - Throttled checks (every 4h by default) with atomic cache file.
 *   - Channel support: latest / next / beta via npm dist-tags.
 *   - Global vs local install detection — only auto-upgrades globals.
 *   - Structured log at `~/.notch/update-log.txt` (trimmed to last 500 lines).
 *   - Cross-platform restart: re-execs `process.execPath` on the resolved
 *     `process.argv[1]`, so it works even when `notch` isn't on PATH or the
 *     actual binary is `notch.cmd` (Windows npm shim).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PACKAGE_NAME = '@freesyntax/notch-cli';
export const CHECK_INTERVAL_HOURS = 4;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;

const NOTCH_DIR = path.join(os.homedir(), '.notch');
export const CACHE_FILE = path.join(NOTCH_DIR, 'update-check.json');
export const LOG_FILE = path.join(NOTCH_DIR, 'update-log.txt');
export const CONFIG_FILE = path.join(NOTCH_DIR, 'config.json');

const MAX_LOG_LINES = 500;
const REGISTRY_BASE = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;

export type UpdateChannel = 'latest' | 'next' | 'beta';
const VALID_CHANNELS: readonly UpdateChannel[] = ['latest', 'next', 'beta'] as const;

export function isValidChannel(c: string): c is UpdateChannel {
  return (VALID_CHANNELS as readonly string[]).includes(c);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
  channel: UpdateChannel;
}

export type UpdateStatus =
  | 'up-to-date'
  | 'newer-available'
  | 'installed'
  | 'install-failed'
  | 'check-failed'
  | 'skipped';

export interface UpdateResult {
  status: UpdateStatus;
  current: string;
  latest?: string;
  channel: UpdateChannel;
  message?: string;
  /** true if this result came from the cache (no network I/O happened). */
  cached?: boolean;
}

export interface CheckOptions {
  channel?: UpdateChannel;
  force?: boolean;
  autoInstall?: boolean;
}

export interface InstallResult {
  success: boolean;
  error?: string;
  /** True if the running install is a local (project) install rather than -g. */
  local?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check npm for a newer published version of the CLI.
 *
 * Behaviour:
 *   - Honours `NOTCH_AUTO_UPDATE=0` (returns `skipped`) unless `force`.
 *   - If a cached check is fresher than CHECK_INTERVAL_HOURS and
 *     `!force`, returns the cached result without network I/O.
 *   - Otherwise fetches `registry.npmjs.org/<pkg>/<channel>` and caches.
 *   - If a newer version is found and `autoInstall`, attempts `installUpdate`.
 */
export async function checkForUpdates(
  currentVersion: string,
  opts: CheckOptions = {},
): Promise<UpdateResult> {
  const channel: UpdateChannel = opts.channel ?? (await readSavedChannel()) ?? 'latest';
  const force = !!opts.force;
  const autoInstall = opts.autoInstall !== false; // default true

  // Respect opt-out unless explicitly forced (e.g. `notch update`).
  if (!force && process.env.NOTCH_AUTO_UPDATE === '0') {
    return { status: 'skipped', current: currentVersion, channel, message: 'NOTCH_AUTO_UPDATE=0' };
  }

  // Try cache first.
  const cache = await loadCache();
  if (!force && cache && cache.channel === channel && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    const latest = cache.latestVersion;
    if (latest && isNewer(latest, currentVersion)) {
      return {
        status: 'newer-available',
        current: currentVersion,
        latest,
        channel,
        cached: true,
      };
    }
    return { status: 'up-to-date', current: currentVersion, latest: latest ?? undefined, channel, cached: true };
  }

  // Fresh check.
  let latest: string;
  try {
    latest = await fetchLatest(channel);
  } catch (err: unknown) {
    await appendLog(`check: channel=${channel} cached=${cache?.latestVersion ?? 'none'} action=error err=${errMsg(err)}`);
    // Don't clobber a valid cache on failure — just note the failed check time.
    await saveCache({
      lastCheck: Date.now(),
      latestVersion: cache?.latestVersion ?? null,
      channel,
    });
    return {
      status: 'check-failed',
      current: currentVersion,
      channel,
      message: errMsg(err),
    };
  }

  await saveCache({ lastCheck: Date.now(), latestVersion: latest, channel });

  if (!isNewer(latest, currentVersion)) {
    await appendLog(`check: channel=${channel} latest=${latest} cached=${cache?.latestVersion ?? 'none'} action=none`);
    return { status: 'up-to-date', current: currentVersion, latest, channel };
  }

  if (!autoInstall) {
    await appendLog(`check: channel=${channel} latest=${latest} cached=${cache?.latestVersion ?? 'none'} action=available`);
    return { status: 'newer-available', current: currentVersion, latest, channel };
  }

  const install = await installUpdate(latest, channel);
  if (install.success) {
    await appendLog(`check: channel=${channel} latest=${latest} cached=${cache?.latestVersion ?? 'none'} action=updated`);
    return {
      status: 'installed',
      current: currentVersion,
      latest,
      channel,
      message: `Updated ${currentVersion} → ${latest}`,
    };
  }

  await appendLog(
    `check: channel=${channel} latest=${latest} cached=${cache?.latestVersion ?? 'none'} action=install-failed err=${install.error ?? 'unknown'}`,
  );
  return {
    status: 'install-failed',
    current: currentVersion,
    latest,
    channel,
    message: install.error ?? 'install failed',
  };
}

/**
 * Install a specific version of the CLI.
 *
 * Detects whether the running binary belongs to a global or local
 * (project-scoped) install. If local, refuses auto-install and asks the caller
 * to run npm in their own project.
 */
export async function installUpdate(version: string, channel: UpdateChannel): Promise<InstallResult> {
  const location = await detectInstallLocation();
  if (location === 'local') {
    const msg = `local install — run \`npm install ${PACKAGE_NAME}@${version}\` in your project`;
    await appendLog(`install: version=${version} channel=${channel} location=local action=skip`);
    return { success: false, local: true, error: msg };
  }

  const cmd = `npm install -g ${PACKAGE_NAME}@${version}`;
  try {
    const out = execSync(cmd, {
      stdio: 'pipe',
      timeout: INSTALL_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    await appendLog(`install: version=${version} channel=${channel} location=global action=ok`);
    if (out && out.trim().length > 0) {
      await appendLogRaw(`install-stdout:\n${indent(out.trim())}`);
    }
    return { success: true };
  } catch (err: any) {
    const stderr: string = (err?.stderr?.toString?.() ?? '').trim();
    const stdout: string = (err?.stdout?.toString?.() ?? '').trim();
    const message: string = err?.message ?? 'npm install failed';
    await appendLog(`install: version=${version} channel=${channel} location=global action=fail err=${firstLine(message)}`);
    if (stderr) await appendLogRaw(`install-stderr:\n${indent(stderr)}`);
    if (stdout) await appendLogRaw(`install-stdout:\n${indent(stdout)}`);
    return { success: false, error: firstLine(message) };
  }
}

/**
 * Re-exec the CLI in-place, preserving argv[2..] and stdio.
 *
 * Resolves the current entry script via `process.argv[1]` and spawns via
 * `process.execPath`, so it works on:
 *   - Linux/macOS where the installed binary is a symlink/shim to `node dist/index.js`
 *   - Windows where the actual user-facing binary is `notch.cmd` (a shim
 *     generated by npm). On Windows `process.argv[1]` points at the .js
 *     entry (dist/index.js), so we invoke it with Node directly and
 *     bypass the .cmd shim entirely.
 *
 * Never returns on success. Exits with the child's exit code.
 */
export function restartCli(extraArgs?: string[]): never {
  const entry = process.argv[1];
  if (!entry) {
    // Nothing safe to re-exec — just exit 0 and let the user re-run.
    process.exit(0);
  }
  const args = extraArgs ?? process.argv.slice(2);
  const result = spawnSync(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    windowsHide: false,
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Channel / config persistence
// ---------------------------------------------------------------------------

interface NotchUserConfig {
  updateChannel?: UpdateChannel;
  [k: string]: unknown;
}

export async function readSavedChannel(): Promise<UpdateChannel | null> {
  const cfg = await readUserConfig();
  const c = cfg?.updateChannel;
  return c && isValidChannel(c) ? c : null;
}

export async function saveChannel(channel: UpdateChannel): Promise<void> {
  const cfg = (await readUserConfig()) ?? {};
  cfg.updateChannel = channel;
  await ensureNotchDir();
  await atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

async function readUserConfig(): Promise<NotchUserConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? (parsed as NotchUserConfig) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export async function loadCache(): Promise<UpdateCache | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.lastCheck === 'number' &&
      (parsed.latestVersion === null || typeof parsed.latestVersion === 'string')
    ) {
      const channel: UpdateChannel = isValidChannel(parsed.channel) ? parsed.channel : 'latest';
      return {
        lastCheck: parsed.lastCheck,
        latestVersion: parsed.latestVersion,
        channel,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveCache(cache: UpdateCache): Promise<void> {
  try {
    await ensureNotchDir();
    await atomicWrite(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Best-effort; never block the CLI.
  }
}

// ---------------------------------------------------------------------------
// Installation-location detection
// ---------------------------------------------------------------------------

type InstallLocation = 'global' | 'local' | 'unknown';

/**
 * Decide whether the running CLI is a global install. We compare the real
 * path of `process.argv[1]` against `npm root -g` and the nearest
 * `node_modules` walking up from cwd.
 */
export async function detectInstallLocation(): Promise<InstallLocation> {
  const entry = process.argv[1];
  if (!entry) return 'unknown';

  let entryReal: string;
  try {
    entryReal = await fs.realpath(entry);
  } catch {
    entryReal = entry;
  }

  // Is it under npm's global root?
  const globalRoot = await tryExec('npm root -g');
  if (globalRoot && pathIsInside(entryReal, globalRoot)) {
    return 'global';
  }

  // Is it under a local node_modules walking up from cwd?
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    const localNM = path.join(dir, 'node_modules');
    if (pathIsInside(entryReal, localNM)) return 'local';
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to comparing against `npm root` run from cwd.
  const localRoot = await tryExec('npm root');
  if (localRoot && pathIsInside(entryReal, localRoot)) return 'local';

  // If we can't prove local, assume global — `npm install -g` is the safe
  // default action because it can't break a project's lockfile.
  return 'global';
}

function pathIsInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function tryExec(cmd: string): Promise<string | null> {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry fetch
// ---------------------------------------------------------------------------

async function fetchLatest(channel: UpdateChannel): Promise<string> {
  const url = `${REGISTRY_BASE}/${encodeURIComponent(PACKAGE_NAME).replace('%40', '@')}/${channel}`;
  // Use a manual AbortController rather than `AbortSignal.timeout`, which on
  // Windows + Node 22 can leave an internal libuv timer handle in a half-
  // closed state and emit an assertion error at process exit.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`no '${channel}' dist-tag published for ${PACKAGE_NAME}`);
      }
      throw new Error(`registry responded ${res.status}`);
    }
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== 'string' || data.version.length === 0) {
      throw new Error('registry response missing version');
    }
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// SemVer comparison (major.minor.patch, prerelease-aware best-effort)
// ---------------------------------------------------------------------------

export function isNewer(latest: string, current: string): boolean {
  const cmp = compareSemver(latest, current);
  return cmp > 0;
}

function compareSemver(a: string, b: string): number {
  const [aCore, aPre] = splitPre(a);
  const [bCore, bPre] = splitPre(b);
  const aNums = aCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bNums = bCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = aNums[i] ?? 0;
    const bv = bNums[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // prerelease: any prerelease is LESS than same core without prerelease
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (!aPre && !bPre) return 0;
  return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
}

function splitPre(v: string): [string, string] {
  const i = v.indexOf('-');
  if (i < 0) return [v, ''];
  return [v.slice(0, i), v.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function ensureNotchDir(): Promise<void> {
  await fs.mkdir(NOTCH_DIR, { recursive: true });
}

/**
 * Append a single structured line to ~/.notch/update-log.txt and trim to
 * the last MAX_LOG_LINES. Best-effort — never throws.
 *
 * Line shape:
 *   [2026-04-19T12:34:56.789Z] check: latest=0.5.20 cached=0.5.19 action=updated
 */
export async function appendLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  await appendLogRaw(line);
}

async function appendLogRaw(line: string): Promise<void> {
  try {
    await ensureNotchDir();
    let existing = '';
    try {
      existing = await fs.readFile(LOG_FILE, 'utf-8');
    } catch {
      existing = '';
    }
    // Normalise: drop any trailing newline on existing content, drop
    // embedded blank lines that earlier writes may have left behind.
    const existingLines = existing.split('\n').map((l) => l).filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
    const allLines = [...existingLines.filter((l) => l.length > 0), line];
    const trimmed = allLines.length > MAX_LOG_LINES ? allLines.slice(allLines.length - MAX_LOG_LINES) : allLines;
    await atomicWrite(LOG_FILE, trimmed.join('\n') + '\n');
  } catch {
    // Best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents, 'utf-8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows: rename across volumes or onto an open file can fail — fall
    // back to copy+unlink so we don't leave a stray .tmp file behind.
    try {
      await fs.copyFile(tmp, file);
      await fs.unlink(tmp).catch(() => {});
    } catch {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return firstLine(err.message);
  return firstLine(String(err));
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return (idx < 0 ? s : s.slice(0, idx)).trim();
}

function indent(block: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
