/**
 * Notch CLI — Ollama credentials tests
 *
 * Runs each test inside an isolated temp dir by pointing $XDG_CONFIG_HOME
 * at it, so we exercise the real fs helpers without touching the
 * developer's ~/.config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  notchConfigDir,
  ollamaCredsPath,
  readOllamaCreds,
  writeOllamaCreds,
  clearOllamaCreds,
} from './ollama-credentials.js';

let tmpDir: string;
let origXdg: string | undefined;
let origAppdata: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-ollama-creds-'));
  origXdg = process.env.XDG_CONFIG_HOME;
  origAppdata = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = tmpDir;
  // On Windows we also need to neutralise APPDATA so the XDG override wins.
  delete process.env.APPDATA;
});

afterEach(async () => {
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  if (origAppdata === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = origAppdata;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('notchConfigDir', () => {
  it('honours XDG_CONFIG_HOME', () => {
    expect(notchConfigDir()).toBe(path.join(tmpDir, 'notch'));
  });
});

describe('readOllamaCreds', () => {
  it('returns null when file missing', async () => {
    expect(await readOllamaCreds()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await fs.mkdir(path.dirname(ollamaCredsPath()), { recursive: true });
    await fs.writeFile(ollamaCredsPath(), '{ oops');
    expect(await readOllamaCreds()).toBeNull();
  });

  it('returns null when required fields missing', async () => {
    await fs.mkdir(path.dirname(ollamaCredsPath()), { recursive: true });
    await fs.writeFile(ollamaCredsPath(), JSON.stringify({ apiKey: 'k' }));
    expect(await readOllamaCreds()).toBeNull();
  });

  it('round-trips via write + read', async () => {
    await writeOllamaCreds({ apiKey: 'sk-abc', endpoint: 'https://ollama.com', createdAt: 1700000000000 });
    const got = await readOllamaCreds();
    expect(got).toEqual({ apiKey: 'sk-abc', endpoint: 'https://ollama.com', createdAt: 1700000000000 });
  });

  it('fills createdAt with now when omitted in the stored file', async () => {
    await fs.mkdir(path.dirname(ollamaCredsPath()), { recursive: true });
    await fs.writeFile(ollamaCredsPath(), JSON.stringify({ apiKey: 'k', endpoint: 'e' }));
    const got = await readOllamaCreds();
    expect(got?.apiKey).toBe('k');
    expect(got?.endpoint).toBe('e');
    expect(typeof got?.createdAt).toBe('number');
  });
});

describe('clearOllamaCreds', () => {
  it('is a no-op when file is absent', async () => {
    await expect(clearOllamaCreds()).resolves.toBeUndefined();
  });

  it('removes the file when present', async () => {
    await writeOllamaCreds({ apiKey: 'k', endpoint: 'e', createdAt: 1 });
    expect(await readOllamaCreds()).not.toBeNull();
    await clearOllamaCreds();
    expect(await readOllamaCreds()).toBeNull();
  });
});
