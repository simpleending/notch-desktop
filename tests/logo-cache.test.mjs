import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { labLogo } from '../src/logo-cache.mjs';
test('logo requests coalesce and disk cache prevents a second network fetch', async () => {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'notch-logos-')); let calls = 0;
  const fetcher = async url => {
    calls++;
    return url.includes('/api/') ? Response.json({ avatarUrl: 'https://cdn-avatars.huggingface.co/example.png' })
      : new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  try {
    const [first, concurrent] = await Promise.all([labLogo('example', { cacheDirectory, fetcher }), labLogo('example', { cacheDirectory, fetcher })]);
    assert.equal(first.dataUrl, concurrent.dataUrl); assert.equal(calls, 2);
    const cached = await labLogo('example', { cacheDirectory, fetcher });
    assert.equal(cached.source, 'cache'); assert.equal(calls, 2);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
test('logos reject unsafe owners and remote hosts, then retain a usable fallback', async () => {
  await assert.rejects(labLogo('../../secrets'), /publisher/);
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'notch-logos-')); let calls = 0;
  try {
    const result = await labLogo('example', { cacheDirectory, fetcher: async () => { calls++; return Response.json({ avatarUrl: 'http://127.0.0.1/private' }); } });
    assert.equal(result.initials, 'EX'); assert.equal(result.source, 'fallback'); assert.equal(calls, 1);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
