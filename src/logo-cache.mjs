import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const pending = new Map();
const lifetime = 24 * 60 * 60 * 1000;

function validLogo(value, owner) {
  return value?.owner === owner && Number.isFinite(value.fetchedAt) && value.fetchedAt <= Date.now()
    && typeof value.dataUrl === 'string' && value.dataUrl.length <= 400000
    && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl);
}

async function smallBody(response, limit) {
  if (!response.ok || !response.body) throw new Error(`Logo fetch failed (${response.status}).`);
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
      if (bytes > limit) throw new Error('Logo response was too large.'); chunks.push(chunk.value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

async function fetchLogo(owner, file, fetcher) {
  // This public profile endpoint is optional; initials remain usable if it changes.
  const response = await fetcher(`https://huggingface.co/api/organizations/${owner}/overview`, { signal: AbortSignal.timeout(8000) });
  const profile = JSON.parse((await smallBody(response, 128 * 1024)).toString('utf8'));
  const url = new URL(profile.avatarUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn-avatars.huggingface.co' || url.username || url.password) throw new Error('Unsupported profile logo host.');
  const image = await fetcher(url.href, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  const type = image.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw new Error('Unsupported logo image format.');
  const bytes = await smallBody(image, 256 * 1024);
  if (!bytes.length) throw new Error('Empty logo.');
  const value = { owner, fetchedAt: Date.now(), dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }
  catch { await unlink(temporary).catch(() => {}); }
  return value;
}

/** Return cached raster logos; coalesce concurrent fetches and retain initials on failure. */
export async function labLogo(owner, { cacheDirectory = path.join(os.homedir(), '.notch-desktop/cache/logos'), fetcher = fetch } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(owner)) throw new Error('Invalid model publisher.');
  const file = path.join(cacheDirectory, `${owner}.json`);
  let cached;
  try { const value = JSON.parse(await readFile(file, 'utf8')); if (validLogo(value, owner)) cached = value; } catch { /* Optional cache. */ }
  if (cached && Date.now() - cached.fetchedAt < lifetime) return { ...cached, source: 'cache' };
  if (!pending.has(file)) pending.set(file, fetchLogo(owner, file, fetcher).then(value => ({ ...value, source: 'live' }), () => cached ? { ...cached, source: 'cache' } : { owner, initials: owner.slice(0, 2).toUpperCase(), source: 'fallback' }).finally(() => pending.delete(file)));
  return pending.get(file);
}
