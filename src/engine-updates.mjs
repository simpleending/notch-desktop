import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COLIBRI_VERSION, STRATA_VERSION } from '../vendor/notch-core/desktop-harness.js';

const engines = { colibri: { repo: 'JustVugg/colibri', version: COLIBRI_VERSION }, strata: { repo: 'Niko1221/Strata', version: STRATA_VERSION } };
export function createEngineUpdates(directory, { fetcher = fetch, now = Date.now } = {}) {
  const file = path.join(directory, 'engine-updates.json'); let cache = {}, pending;
  const ready = fs.readFile(file, 'utf8').then(text => { cache = JSON.parse(text); }).catch(() => {});
  function status(provider) {
    if (!engines[provider]) throw Error('Choose a supported engine.');
    const engine = engines[provider], row = cache[provider];
    const latest = /^\d+\.\d+\.\d+$/.test(row?.latest) ? row.latest : engine.version;
    const newer = latest.split('.').map(Number).reduce((result, part, i) => result || Math.sign(part - Number(engine.version.split('.')[i])), 0) > 0;
    return { version: engine.version, latest, available: newer, checkedAt: row?.checkedAt ?? null, error: row?.error ?? null, url: `https://github.com/${engine.repo}/releases/latest`, message: newer ? 'A newer upstream release is available. Notch keeps the tested engine version until a compatible update is shipped.' : 'Using the engine version tested with this Notch release.' };
  }
  async function check(force = false) {
    await ready; if (pending) return pending;
    pending = (async () => {
      for (const [provider, engine] of Object.entries(engines)) {
        if (!force && now() - (cache[provider]?.checkedAt ?? 0) < 86400000) continue;
        try {
          const response = await fetcher(`https://api.github.com/repos/${engine.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw Error('Update check unavailable.');
          const data = await response.json(), latest = String(data.tag_name).replace(/^v/, '');
          if (data.draft || data.prerelease || !/^\d+\.\d+\.\d+$/.test(latest)) throw Error('No stable engine release found.');
          cache[provider] = { latest, checkedAt: now() };
        } catch { cache[provider] = { ...cache[provider], checkedAt: now(), error: 'Could not check upstream. The installed engine remains available.' }; }
      }
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
      return Object.fromEntries(Object.keys(engines).map(key => [key, status(key)]));
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return { check, async status(provider) { await ready; return status(provider); } };
}

