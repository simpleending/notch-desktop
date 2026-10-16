import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotchQuery } from './notch-query.mjs';
import { createWorkspaceSearch } from './workspace-search.mjs';
import { detectLocalHardware, runDesktopTurn, CheckpointManager } from '../vendor/notch-core/desktop-harness.js';
import { localContextProfile } from './model-policy.mjs';
import { validateLocalPlugin } from './plugin-validation.mjs';

const localIdentity = Object.freeze({ status: 'signed-in', mode: 'local', user: { id: 'local-notch', name: 'Local workspace', nickname: 'Local workspace', email: null }, error: null, loginUrl: null });
function sessionFile(directory, id) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid Notch session ID.');
  return path.join(directory, `${id}.json`);
}
export function createHost(dataDirectory, { hardware: detectHardware = detectLocalHardware, fetcher = fetch, runTurn = runDesktopTurn } = {}) {
  const sessions = path.join(dataDirectory, 'notch-sessions');
  let models = [], fetchedAt = 0, pending, defaultModel, discoveryWarning;
  let endpoints = new Map(), profiles = new Map(), unverifiedModels = new Set();
  const queries = new Map();
  const rewinding = new Set();
  const host = {
    workspaceSearch: createWorkspaceSearch(),
    identity: localIdentity,
    validatePlugin: validateLocalPlugin,
    assertTurnAvailable(id) { if (rewinding.has(id)) throw new Error('Finish undo before starting another turn.'); },
    getCachedModels: () => models,
    getDefaultModel: () => defaultModel,
    getModelDiscoveryWarning: () => discoveryWarning,
    getQueueStatus: () => [...queries.values()].filter(query => query.queueMessage).map(query => ({ sessionId: query.id, message: query.queueMessage })),
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
          row.defaultContextWindow=host.modelManager?.context(key,row.availableContextWindows,row.recommendedContextWindow || row.defaultContextWindow) || row.defaultContextWindow;
          row.requestedContextWindow=host.modelManager?.requestedContext(key);
          if (profiles.has(key)) profiles.get(key).contextWindow=row.defaultContextWindow;
        }
        return models;
      }
      if (pending) return pending;
      pending = (async () => {
        const roots=['http://127.0.0.1:11436','http://127.0.0.1:11434'];
        const results = await Promise.allSettled(roots.map(async root => {
          const [response,running] = await Promise.all([
            fetcher(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) }),
            fetcher(`${root}/api/ps`, { signal: AbortSignal.timeout(1500) }).then(response=>response.ok?response.json():{models:[]}).catch(()=>({models:[]})),
          ]);
          if (!response.ok) throw new Error(`Ollama unavailable (${response.status}).`);
          const data = await response.json();
          if(!Array.isArray(data.models))throw new Error('Invalid Ollama model inventory.');
          return { root, rows: data.models, mounted: Array.isArray(running.models)?running.models:[] };
        }));
        const failed=new Set(roots.filter((_root,index)=>results[index].status==='rejected'));
        const retained=models.filter(row=>row.key!=='auto'&&row.provider==='ollama'&&failed.has(endpoints.get(row.key)?.replace(/\/v1$/,'')));
        const unique=new Map(),nextEndpoints=new Map(),nextProfiles=new Map(),unverified=new Set(),hardware=await detectHardware(force);
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const row of result.value.rows) {
            if (typeof row.name !== 'string' || !row.name) continue;
            const key = `ollama/${row.name}`;
            if (unique.has(key)) continue;
            const size = typeof row.size === 'number' && row.size > 0 ? row.size : Infinity;
            let metadata = {};
            try { const response = await fetcher(`${result.value.root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: row.name }), signal: AbortSignal.timeout(3000) }); if (response.ok) metadata = await response.json(); } catch { /* Unverified models remain visible but cannot run tools. */ }
            const mounted = result.value.mounted.find(model=>model.name===row.name && (!row.digest || model.digest===row.digest));
            const fit = localContextProfile(size,hardware,metadata,mounted);
            const contextWindow = host.modelManager?.context(key,fit.choices,fit.contextWindow) || fit.contextWindow;
            nextProfiles.set(key, { ...fit, contextWindow });
            nextEndpoints.set(key, `${result.value.root}/v1`);
            const label = metadata.model_info?.['general.base_model.0.name'];
            unique.set(key, { key, displayName: typeof label === 'string' && label ? label : row.name,
              description: fit.fits ? 'local Ollama · estimated memory fit' : fit.reason, provider: 'ollama', bytes: size, source: 'system', enabled: fit.fits,
              isDefault: row.name.startsWith('notch-hf-'), isNew: false, priceFactor: 0, tags: ['local'],
              maxInputTokens: fit.nativeContext, maxOutputTokens: 4096, availableContextWindows: fit.choices, defaultContextWindow: contextWindow,
              recommendedContextWindow:fit.contextWindow, requestedContextWindow:host.modelManager?.requestedContext(key),
              efforts: [], defaultEffort: null, supportsDisabled: true });
          }
        }
        // A failed transport is not an empty inventory; stale entries cannot start a local turn.
        for(const row of retained)if(!unique.has(row.key)){unique.set(row.key,{...row});nextEndpoints.set(row.key,endpoints.get(row.key));nextProfiles.set(row.key,{...profiles.get(row.key)});unverified.add(row.key);}
        if (host.modelManager) for (const row of await host.modelManager.mlxModels(hardware)) { unique.set(row.key,row); nextProfiles.set(row.key,{contextWindow:row.defaultContextWindow,nativeContext:row.maxInputTokens,maxOutputTokens:row.maxOutputTokens}); }
        const nextModels=[...unique.values()];
        let nextDefault=nextModels.find(row=>row.isDefault&&row.enabled)?.key||nextModels.find(row=>row.enabled)?.key;
        if (host.modelManager) {
          const cloud = await host.modelManager.cloudCatalog().catch(()=>[]);
          for (const row of cloud) nextProfiles.set(row.key, { contextWindow: row.defaultContextWindow, nativeContext:row.maxInputTokens, maxOutputTokens: row.maxOutputTokens });
          nextModels.push(...cloud);
        }
        if(hardware.mlxSupported)nextDefault=nextModels.find(row=>row.provider==='mlx'&&row.enabled)?.key||nextDefault;
        if(nextDefault)nextModels.unshift({...nextModels.find(row=>row.key===nextDefault),key:'auto',displayName:'local model',isDefault:true});
        models=nextModels;defaultModel=nextDefault;endpoints=nextEndpoints;profiles=nextProfiles;unverifiedModels=unverified;
        discoveryWarning=unverified.size?'Could not refresh Ollama. Showing cached models; start Ollama or refresh to retry.':undefined;
        fetchedAt=unverified.size?0:Date.now();return models;
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
      try { await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx', flush: true }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    },
    async openCheckpoints(id, cwd) {
      const file = sessionFile(path.join(dataDirectory, 'notch-undo'), id);
      return CheckpointManager.open(cwd, file);
    },
    async acquireRewind(id) {
      if (queries.get(id)?.active || rewinding.has(id)) throw new Error('Finish the active turn or undo before restoring files.');
      const stored = JSON.parse(await fs.readFile(sessionFile(sessions, id), 'utf8'));
      const state = await host.loadSession(id, stored.cwd);
      const checkpoints = await host.openCheckpoints(id, state.cwd);
      if (queries.get(id)?.active || rewinding.has(id)) throw new Error('Finish the active turn or undo before restoring files.');
      rewinding.add(id);
      let released = false;
      const rewindFiles = async (messageId, options = {}) => {
        if (released) throw new Error('Undo access has been released.');
        const dryRun = typeof options === 'boolean' ? options : options.dryRun;
        const result = await checkpoints.preview(messageId);
        if (!dryRun && result.canRewind) {
          await checkpoints.undo(messageId);
          state.messages.push({ role: 'user', content: 'Files from the selected turn and later turns were restored by the user. Inspect current files before continuing; do not replay undone actions.' });
          state.contextUsage = null;
          await host.saveSession(id, state);
          const query = queries.get(id);
          if (query) query.state = structuredClone(state);
          host.workspaceSearch.invalidate(state.cwd);
        }
        return result;
      };
      return { rewindFiles, async rewind(messageId, scope, dryRun) {
        if (scope !== 'files') throw new Error('Choose file undo to restore changes. Conversation rewind is unavailable.');
        const result = await rewindFiles(messageId, { dryRun });
        return { ...result, status: result.canRewind ? (dryRun ? 'ready' : 'success') : 'unavailable' };
      }, async prepareReplacement() {}, async release() { released = true; rewinding.delete(id); } };
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
      const id = request.resumeSessionId || request.sessionId;
      const current = queries.get(id);
      if (id && ((current && !current.closed && !current.ended) || rewinding.has(id))) throw new Error('This session is already open or restoring files.');
      const query = new NotchQuery(host, { ...request, model, cwd: request.cwd || process.cwd() }, {
        runTurn: async turn => {
          if (rewinding.has(turn.sessionId)) throw new Error('Finish undo before starting another turn.');
          // Memory may have changed since the picker opened; size again before loading.
          if (!turn.model?.startsWith('openrouter/')) await host.listModels(true);
          const model = host.resolveModelChoice(turn.model);
          if(unverifiedModels.has(model))throw new Error('Could not verify the local model. Start Ollama or refresh to retry.');
          const apiKey = model.startsWith('openrouter/') ? await host.modelManager?.key('openrouter') : undefined;
          if (model.startsWith('openrouter/') && !apiKey) throw new Error('Connect an OpenRouter API key in the model picker.');
          return runTurn({ ...turn, model, apiKey, webSettings: async () => await host.webResearch?.configuration() ?? { enabled: true, searchProvider: 'duckduckgo', browser: 'auto' }, workspaceMode: await host.modelManager?.getWorkspaceMode?.() ?? 'shared', workspaceSearch: (operation, params, cwd, signal) => host.workspaceSearch.tool(operation, cwd, params, signal),
            onLifecycle: async (event, payload) => {
              if (event === 'pre-tool' && !['read', 'grep', 'glob'].includes(payload.tool)) host.workspaceSearch.invalidate(turn.cwd);
              if (event === 'post-tool' && !['read', 'grep', 'glob'].includes(payload.tool)) host.workspaceSearch.invalidate(turn.cwd);
              await turn.onLifecycle?.(event, payload);
            },
            ripgrepPath: process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'notch-rg.exe') : undefined,
            baseUrl: model.startsWith('openrouter/') ? 'https://openrouter.ai/api/v1' : endpoints.get(model), contextWindow: profiles.get(model)?.contextWindow || 8192, nativeContextWindow:profiles.get(model)?.nativeContext, maxOutputTokens: profiles.get(model)?.maxOutputTokens, ollamaBatch: 64 });
        },
      });
      queries.set(query.id, query);
      void query.task.finally(() => { if (queries.get(query.id) === query) queries.delete(query.id); });
      return query;
    },
    async prepare(request) { let attached = false; return { attach(prompt) { if (attached) throw new Error('Prepared session already attached.'); attached = true; return host.query({ ...request, prompt }); }, async close() { attached = true; } }; },
  };
  return host;
}
