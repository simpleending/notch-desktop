import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotchQuery } from './notch-query.mjs';
import { createWorkspaceSearch } from './workspace-search.mjs';
import { detectLocalHardware, modelFit } from '../vendor/notch-core/desktop-harness.js';

const localIdentity = Object.freeze({ status: 'signed-in', mode: 'local', user: { id: 'local-notch', name: 'Local workspace', nickname: 'Local workspace', email: null }, error: null, loginUrl: null });
function sessionFile(directory, id) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid Notch session ID.');
  return path.join(directory, `${id}.json`);
}
export function createHost(dataDirectory) {
  const sessions = path.join(dataDirectory, 'notch-sessions');
  let models = [], fetchedAt = 0, pending, defaultModel;
  const endpoints = new Map();
  const profiles = new Map();
  const host = {
    workspaceSearch: createWorkspaceSearch(),
    identity: localIdentity,
    getCachedModels: () => models,
    async listModels(force = false) {
      if (!force && Date.now() - fetchedAt < 30000) return models;
      if (pending) return pending;
      pending = (async () => {
        const results = await Promise.allSettled(['http://127.0.0.1:11436', 'http://127.0.0.1:11434'].map(async root => {
          const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) });
          if (!response.ok) throw new Error(`Ollama unavailable (${response.status}).`);
          const data = await response.json(); return { root, rows: data.models || [] };
        }));
        const unique = new Map(), hardware = await detectLocalHardware(); endpoints.clear(); profiles.clear();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const row of result.value.rows) {
            if (typeof row.name !== 'string' || !row.name) continue;
            const key = `ollama/${row.name}`;
            if (unique.has(key)) continue;
            const size = typeof row.size === 'number' && row.size > 0 ? row.size : Infinity;
            const fit = modelFit({ bytes: size }, hardware);
            profiles.set(key, { bytes: size, contextWindow: fit.contextLength });
            endpoints.set(key, `${result.value.root}/v1`);
            unique.set(key, { key, displayName: row.name.startsWith('notch-hf-') ? 'Hugging Face local model' : row.name,
              description: fit.fits ? 'local Ollama · no account required' : 'exceeds current available memory', source: 'system', enabled: fit.fits,
              isDefault: row.name.startsWith('notch-hf-'), isNew: false, priceFactor: 0, tags: ['local'],
              maxInputTokens: fit.contextLength, maxOutputTokens: 4096, availableContextWindows: fit.contextLength === 16384 ? [8192, 16384] : [8192], defaultContextWindow: fit.contextLength,
              efforts: [], defaultEffort: null, supportsDisabled: true });
          }
        }
        models = [...unique.values()];
        defaultModel = models.find(row => row.isDefault && row.enabled)?.key || models.find(row => row.enabled)?.key;
        if (defaultModel) models.unshift({ ...models.find(row => row.key === defaultModel), key: 'auto', displayName: 'local model', isDefault: true });
        fetchedAt = Date.now(); return models;
      })().finally(() => { pending = undefined; });
      return pending;
    },
    async loadSession(id, cwd) {
      await fs.mkdir(sessions, { recursive: true });
      const realCwd = await fs.realpath(cwd || process.cwd());
      try {
        const raw = await fs.readFile(sessionFile(sessions, id), 'utf8');
        const state = JSON.parse(raw);
        if (state.version !== 1 || state.cwd !== realCwd || !Array.isArray(state.messages)) throw new Error('Notch session belongs to a different workspace or has an unsupported format.');
        return state;
      } catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, cwd: realCwd, messages: [], createdAt: new Date().toISOString() }; }
    },
    async saveSession(id, state) {
      await fs.mkdir(sessions, { recursive: true });
      const file = sessionFile(sessions, id), temporary = `${file}.${randomUUID()}.tmp`, data = JSON.stringify(state);
      if (Buffer.byteLength(data) > 64 * 2 ** 20) throw new Error('Session exceeds the 64 MiB storage limit; history was not overwritten.');
      try { await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    },
    async journal(id, event) { await fs.mkdir(sessions, { recursive: true }); await fs.appendFile(`${sessionFile(sessions, id)}.actions`, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }); },
    async hasSession(id) { try { await fs.access(sessionFile(sessions, id)); return true; } catch { return false; } },
    query(request) {
      const model = request.model === 'auto' || !request.model ? defaultModel : request.model;
      if (!model) throw new Error('No local model fits current available memory. Close applications or install a smaller model with notch models.');
      return new NotchQuery(host, { ...request, model, cwd: request.cwd || process.cwd() }, {
        runTurn: async turn => {
          const { runDesktopTurn } = await import('../vendor/notch-core/desktop-harness.js');
          return runDesktopTurn({ ...turn, baseUrl: endpoints.get(turn.model), contextWindow: profiles.get(turn.model)?.contextWindow || 8192, ollamaBatch: 64 });
        },
      });
    },
    async prepare(request) { let attached = false; return { attach(prompt) { if (attached) throw new Error('Prepared session already attached.'); attached = true; return host.query({ ...request, prompt }); }, async close() { attached = true; } }; },
  };
  return host;
}
