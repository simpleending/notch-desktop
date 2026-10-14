import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotchQuery } from './notch-query.mjs';
import { createWorkspaceSearch } from './workspace-search.mjs';
import { detectLocalHardware } from '../vendor/notch-core/desktop-harness.js';
import { localContextProfile } from './model-policy.mjs';

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
    getDefaultModel: () => defaultModel,
    resolveModelChoice(model) {
      const chosen = !model || model === 'auto' ? defaultModel : model;
      if (!chosen || !models.some(row => row.key === chosen && row.enabled)) throw new Error('The selected model is unavailable or does not fit current memory. Choose a model in the composer.');
      return chosen;
    },
    async listModels(force = false) {
      if (host.modelManager) await host.modelManager.status();
      if (!force && Date.now() - fetchedAt < 30000) {
        for (const row of models) {
          const key = row.key==='auto' ? defaultModel : row.key;
          row.defaultContextWindow=host.modelManager?.context(key,row.availableContextWindows,row.defaultContextWindow) || row.defaultContextWindow;
          if (profiles.has(key)) profiles.get(key).contextWindow=row.defaultContextWindow;
        }
        return models;
      }
      if (pending) return pending;
      pending = (async () => {
        const results = await Promise.allSettled(['http://127.0.0.1:11436', 'http://127.0.0.1:11434'].map(async root => {
          const [response,running] = await Promise.all([
            fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) }),
            fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(1500) }).then(response=>response.ok?response.json():{models:[]}).catch(()=>({models:[]})),
          ]);
          if (!response.ok) throw new Error(`Ollama unavailable (${response.status}).`);
          const data = await response.json(); return { root, rows: data.models || [], mounted: Array.isArray(running.models)?running.models:[] };
        }));
        const unique = new Map(), hardware = await detectLocalHardware(); endpoints.clear(); profiles.clear();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const row of result.value.rows) {
            if (typeof row.name !== 'string' || !row.name) continue;
            const key = `ollama/${row.name}`;
            if (unique.has(key)) continue;
            const size = typeof row.size === 'number' && row.size > 0 ? row.size : Infinity;
            let metadata = {};
            try { const response = await fetch(`${result.value.root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: row.name }), signal: AbortSignal.timeout(3000) }); if (response.ok) metadata = await response.json(); } catch { /* Unverified models remain visible but cannot run tools. */ }
            const mounted = result.value.mounted.find(model=>model.name===row.name && (!row.digest || model.digest===row.digest));
            const fit = localContextProfile(size,hardware,metadata,mounted);
            const contextWindow = host.modelManager?.context(key,fit.choices,fit.contextWindow) || fit.contextWindow;
            profiles.set(key, { ...fit, contextWindow });
            endpoints.set(key, `${result.value.root}/v1`);
            const label = metadata.model_info?.['general.base_model.0.name'];
            unique.set(key, { key, displayName: typeof label === 'string' && label ? label : row.name,
              description: fit.fits ? 'local Ollama · estimated memory fit' : fit.reason, provider: 'ollama', bytes: size, source: 'system', enabled: fit.fits,
              isDefault: row.name.startsWith('notch-hf-'), isNew: false, priceFactor: 0, tags: ['local'],
              maxInputTokens: fit.nativeContext, maxOutputTokens: 4096, availableContextWindows: fit.choices, defaultContextWindow: contextWindow,
              efforts: [], defaultEffort: null, supportsDisabled: true });
          }
        }
        if (host.modelManager) for (const row of await host.modelManager.mlxModels(hardware)) { unique.set(row.key,row); profiles.set(row.key,{contextWindow:row.defaultContextWindow,maxOutputTokens:row.maxOutputTokens}); }
        models = [...unique.values()];
        defaultModel = models.find(row => row.isDefault && row.enabled)?.key || models.find(row => row.enabled)?.key;
        if (host.modelManager) {
          const cloud = await host.modelManager.cloudCatalog().catch(()=>[]);
          for (const row of cloud) profiles.set(row.key, { contextWindow: row.defaultContextWindow, maxOutputTokens: row.maxOutputTokens });
          models.push(...cloud);
        }
        if (hardware.mlxSupported) defaultModel = models.find(row=>row.provider==='mlx' && row.enabled)?.key || defaultModel;
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
    async archiveTranscript(id, messages) {
      sessionFile(sessions, id);
      const directory = path.join(sessions, `${id}.archives`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ version: 1, messages }), { mode: 0o600, flag: 'wx' });
    },
    async journal(id, event) { await fs.mkdir(sessions, { recursive: true }); await fs.appendFile(`${sessionFile(sessions, id)}.actions`, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }); },
    async hasSession(id) { try { await fs.access(sessionFile(sessions, id)); return true; } catch { return false; } },
    query(request) {
      const model = host.resolveModelChoice(request.model);
      return new NotchQuery(host, { ...request, model, cwd: request.cwd || process.cwd() }, {
        runTurn: async turn => {
          const { runDesktopTurn } = await import('../vendor/notch-core/desktop-harness.js');
          const model = host.resolveModelChoice(turn.model);
          const apiKey = model.startsWith('openrouter/') ? await host.modelManager?.key('openrouter') : undefined;
          if (model.startsWith('openrouter/') && !apiKey) throw new Error('Connect an OpenRouter API key in the model picker.');
          return runDesktopTurn({ ...turn, model, apiKey, baseUrl: model.startsWith('openrouter/') ? 'https://openrouter.ai/api/v1' : endpoints.get(model), contextWindow: profiles.get(model)?.contextWindow || 8192, maxOutputTokens: profiles.get(model)?.maxOutputTokens, ollamaBatch: 64 });
        },
      });
    },
    async prepare(request) { let attached = false; return { attach(prompt) { if (attached) throw new Error('Prepared session already attached.'); attached = true; return host.query({ ...request, prompt }); }, async close() { attached = true; } }; },
  };
  return host;
}
