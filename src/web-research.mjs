import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { webSettingsSchema, validSearchKey, installResearchBrowser } from '../vendor/notch-core/desktop-harness.js';

export function createWebResearch(directory, { safeStorage, signal, install = installResearchBrowser } = {}) {
  const file = path.join(directory, 'web-research.json');
  let settings = webSettingsSchema.parse({}), key, persistent = false, installing = false;
  const ready = (async () => {
    persistent = !!safeStorage && await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8')); settings = webSettingsSchema.parse(stored);
      if (stored.encryptedKey) { if (!persistent) throw Error('Unlock your system key storage to load the saved search key.'); key = (await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedKey, 'base64'))).result; }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Web research settings could not be loaded. Your saved file was preserved. ' + error.message); }
  })();
  void ready.catch(() => {});
  const status = async () => { await ready; return { ...settings, hasKey: !!(process.env.TAVILY_API_KEY || key), environmentKey: !!process.env.TAVILY_API_KEY, persistentKey: persistent, installing }; };
  return {
    status,
    async configuration() { await ready; return { ...settings, tavilyKey: process.env.TAVILY_API_KEY || key }; },
    async update(patch) {
      await ready;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(name => !['enabled','browser','key'].includes(name))) throw Error('Invalid web settings.');
      const next = webSettingsSchema.parse({ ...settings, ...patch });
      const nextKey = 'key' in patch ? patch.key === null ? undefined : patch.key : key;
      if (nextKey !== undefined && (typeof nextKey !== 'string' || !validSearchKey(nextKey))) throw Error('Enter a valid Tavily API key.');
      const encryptedKey = persistent && nextKey ? (await safeStorage.encryptStringAsync(nextKey)).toString('base64') : undefined;
      await fs.mkdir(directory, { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify({ ...next, ...(encryptedKey ? { encryptedKey } : {}) }), { mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.unlink(temp).catch(() => {}); }
      settings = next; key = nextKey; return status();
    },
    async install() {
      if (installing) throw Error('A browser installation is already running.');
      installing = true;
      try { await install(() => {}, signal); return await status(); }
      finally { installing = false; }
    },
  };
}
