import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { webSettingsSchema, validSearchKey, installResearchBrowser } from '../vendor/notch-core/desktop-harness.js';
import { searchProviders } from './web-search-providers.mjs';

export function createWebResearch(directory, { safeStorage, signal, install = installResearchBrowser } = {}) {
  const file = path.join(directory, 'web-research.json');
  let settings = webSettingsSchema.parse({}), keys = {}, persistent = false, installing = false;
  const ready = (async () => {
    persistent = !!safeStorage && await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8')); settings = webSettingsSchema.parse(stored);
      for (const provider of searchProviders) {
        if (!stored[provider.stored]) continue;
        if (!persistent) throw Error('Unlock your system key storage to load the saved search keys.');
        keys[provider.key] = (await safeStorage.decryptStringAsync(Buffer.from(stored[provider.stored], 'base64'))).result;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Web research settings could not be loaded. Your saved file was preserved. ' + error.message); }
  })();
  void ready.catch(() => {});
  const status = async () => {
    await ready;
    const credentials = Object.fromEntries(searchProviders.map(provider => [provider.id, {
      saved: !!keys[provider.key], environment: !!process.env[provider.env],
    }]));
    return { ...settings, hasKey: credentials.tavily.saved || credentials.tavily.environment, environmentKey: credentials.tavily.environment, credentials, persistentKey: persistent, installing };
  };
  const allowed = ['enabled', 'browser', 'searchProvider', ...searchProviders.map(provider => provider.key)];
  let pending = Promise.resolve();
  return {
    status,
    async configuration() {
      await ready;
      return { ...settings, ...Object.fromEntries(searchProviders.map(provider => [
        `${provider.id}Key`, process.env[provider.env] || keys[provider.key],
      ])) };
    },
    update(patch) {
      const result = pending.then(async () => {
        await ready;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(name => !allowed.includes(name))) throw Error('Invalid web settings.');
        const next = webSettingsSchema.parse({ ...settings, ...patch });
        const nextKeys = { ...keys }, encrypted = {};
        for (const provider of searchProviders) {
          if (Object.hasOwn(patch, provider.key)) {
            const value = patch[provider.key];
            if (value !== null && (typeof value !== 'string' || !validSearchKey(value))) throw Error(`Enter a valid ${provider.label} API key.`);
            nextKeys[provider.key] = value ?? undefined;
          }
          const value = nextKeys[provider.key];
          if (persistent && value) encrypted[provider.stored] = (await safeStorage.encryptStringAsync(value)).toString('base64');
        }
        await fs.mkdir(directory, { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify({ ...next, ...encrypted }), { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.unlink(temp).catch(() => {}); }
        settings = next; keys = nextKeys; return status();
      });
      pending = result.catch(() => {});
      return result;
    },
    async install() {
      if (installing) throw Error('A browser installation is already running.');
      installing = true;
      try { await install(() => {}, signal); return await status(); }
      finally { installing = false; }
    },
  };
}
