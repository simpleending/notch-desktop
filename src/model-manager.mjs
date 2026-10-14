import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cloudModelRows } from './model-policy.mjs';
import { localContextProfile } from './model-policy.mjs';
import { installLocalModel } from './cli-bridge.mjs';
import { detectLocalHardware, modelFit, inspectHubModel, LOCAL_MODEL_CATALOG } from '../vendor/notch-core/desktop-harness.js';

async function recommend({ runner, token }) {
  const hardware = await detectLocalHardware();
  runner ||= hardware.mlxSupported ? 'mlx' : 'ollama';
  if (!['ollama','mlx'].includes(runner) || (runner === 'mlx' && !hardware.mlxSupported)) throw new Error('MLX requires an Apple Silicon Mac running macOS 14 or newer.');
  const results = await Promise.allSettled(LOCAL_MODEL_CATALOG.map(row=>inspectHubModel(runner==='mlx'?row.mlx:row.gguf,runner,undefined,token)));
  const models = results.filter(result=>result.status==='fulfilled').map(result=>({ ...result.value, ...modelFit(result.value,hardware) })).sort((a,b)=>Date.parse(b.createdAt || 0)-Date.parse(a.createdAt || 0));
  if (!models.length) throw new Error('Hugging Face is unavailable. Retry when connected.');
  return { hardware, runner, models };
}

export function createModelManager(directory, { safeStorage, fetcher = fetch, recommend: recommendModels = recommend, install = installLocalModel } = {}) {
  const keys = new Map(), preferences = new Map();
  const keyFile = path.join(directory, 'provider-keys.encrypted.json'), contextFile = path.join(directory, 'model-context.json'), catalogFile = path.join(directory, 'openrouter-models.json');
  const mlxFile = path.join(directory,'mlx-models.json');
  let cached, pending, job, keyLoadError, installedMlx = [];
  let persistent = false;
  const secure = () => persistent;
  const ready = (async () => {
    persistent = !!safeStorage && await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (secure()) try { const values = JSON.parse(await fs.readFile(keyFile, 'utf8')); for (const provider of ['openrouter','huggingface']) if (typeof values[provider] === 'string') keys.set(provider, (await safeStorage.decryptStringAsync(Buffer.from(values[provider], 'base64'))).result); } catch (error) { if (error.code !== 'ENOENT') { keys.clear(); keyLoadError = 'Saved provider keys could not be decrypted. Reconnect the provider.'; } }
    try { const values = JSON.parse(await fs.readFile(contextFile, 'utf8')); for (const [model,value] of Object.entries(values)) if (Number.isSafeInteger(value) && value >= 2048) preferences.set(model,value); } catch { /* Context choices are optional. */ }
    try { const value = JSON.parse(await fs.readFile(catalogFile, 'utf8')); if (Array.isArray(value.data) && value.at <= Date.now()) cached = value; } catch { /* Refresh invalid cache. */ }
    try { const rows = JSON.parse(await fs.readFile(mlxFile,'utf8')); if (Array.isArray(rows)) installedMlx = rows.filter(row=>row && typeof row.repo==='string' && /^[\w.-]+\/[\w.-]+$/.test(row.repo) && Number.isSafeInteger(row.bytes) && row.bytes>0); } catch { /* No installed MLX models yet. */ }
  })();
  void ready.catch(()=>{});
  async function atomic(file, value) {
    await fs.mkdir(directory, { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp,file); } finally { await fs.unlink(temp).catch(()=>{}); }
  }
  async function saveKeys() {
    if (!secure()) return;
    const values = await Promise.all([...keys].map(async ([provider,key])=>[provider,(await safeStorage.encryptStringAsync(key)).toString('base64')]));
    await atomic(keyFile, Object.fromEntries(values));
  }
  const service = {
    async status() { await ready; return { openrouter: keys.has('openrouter'), huggingface: keys.has('huggingface'), persistentKeys: !!secure(), keyLoadError, job: job ? { ...job.public } : null }; },
    async key(provider) { await ready; return keys.get(provider); },
    async connect(provider, key) {
      await ready;
      if (!['openrouter','huggingface'].includes(provider) || typeof key !== 'string' || !/^[\x21-\x7e]{12,4096}$/.test(key)) throw new Error('Enter a valid provider API key.');
      const url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/key' : 'https://huggingface.co/api/whoami-v2';
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Provider rejected the key (HTTP ${response.status}).`);
      const old = keys.get(provider); keys.set(provider,key);
      try { await saveKeys(); keyLoadError = undefined; } catch (error) { if (old) keys.set(provider,old); else keys.delete(provider); throw error; }
      return service.status();
    },
    async disconnect(provider) { await ready; if (!['openrouter','huggingface'].includes(provider)) throw new Error('Invalid provider.'); keys.delete(provider); await saveKeys(); return service.status(); },
    async cloudCatalog(force = false) {
      await ready;
      if (!keys.has('openrouter')) return [];
      if (force || !cached || Date.now()-cached.at > 6*3600000) {
        pending ??= (async () => {
          const response = await fetcher('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${keys.get('openrouter')}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`OpenRouter model refresh failed (HTTP ${response.status}).`);
          const body = await response.json(); cloudModelRows(body.data,true);
          cached = { at: Date.now(), data: body.data }; await atomic(catalogFile,cached);
        })().finally(()=>{pending=undefined;});
        try { await pending; } catch (error) { if (!cached) throw error; }
      }
      return cloudModelRows(cached.data,true).map(row=>({ ...row, defaultContextWindow: service.context(row.key,row.availableContextWindows,row.defaultContextWindow) }));
    },
    context(model, choices, fallback) { const value = preferences.get(model); return choices.includes(value) ? value : fallback; },
    async mlxModels(hardware) {
      await ready; if (!hardware.mlxSupported) return [];
      return installedMlx.map(row=>{ const fit=localContextProfile(row.bytes,hardware,{capabilities:['tools'],model_info:{'general.architecture':'mlx','mlx.context_length':8192}});
        return { key:`mlx/${row.repo}`,displayName:row.repo,provider:'mlx',bytes:row.bytes,description:fit.fits?'local MLX · estimated memory fit':fit.reason,
          source:'system',enabled:fit.fits,isDefault:true,isNew:false,priceFactor:0,tags:['local'],maxInputTokens:8192,maxOutputTokens:2048,availableContextWindows:fit.choices,
          defaultContextWindow:service.context(`mlx/${row.repo}`,fit.choices,fit.contextWindow),efforts:[],defaultEffort:null,supportsDisabled:true }; });
    },
    async setContext(model, tokens, models) { await ready; const row = models.find(row=>row.key===model && row.enabled); if (!row || !row.availableContextWindows.includes(tokens)) throw new Error('Choose a supported context limit for this model.'); preferences.set(model,tokens); await atomic(contextFile,Object.fromEntries(preferences)); },
    async hubCatalog(runner) { await ready; if (runner !== undefined && !['ollama','mlx'].includes(runner)) throw new Error('Choose Ollama or MLX.'); return recommendModels({ runner, token: keys.get('huggingface') }); },
    async startInstall(repo, runner) {
      await ready; if (job?.public.state==='running') throw new Error('A model download is already running.');
      const catalog = await service.hubCatalog(runner), row = catalog.models.find(row=>row.repo===repo && row.fits);
      if (!row) throw new Error('Choose a recommended model that fits current memory.');
      const cwd = path.join(directory,'model-installs'); await fs.mkdir(cwd,{recursive:true});
      const controller = new AbortController(); job = { controller, public: { id: randomUUID(), repo, runner, state: 'running', message: 'Preparing download…' } }; const current = job;
      void install(repo,runner,{ cwd, signal: controller.signal, env: keys.has('huggingface') ? { HF_TOKEN: keys.get('huggingface') } : {}, onOutput: ({text})=>{ current.public.message = text.trim().slice(-500).replace(/\x1b\[[0-9;]*m/g,''); } })
        .then(async()=>{if(runner==='mlx'){installedMlx=[...installedMlx.filter(item=>item.repo!==repo),{repo,bytes:row.bytes}];await atomic(mlxFile,installedMlx);}current.public.state='complete';current.public.message='Installed. Refresh Installed to select it.';})
        .catch(error=>{current.public.state=controller.signal.aborted?'cancelled':'failed';current.public.message=controller.signal.aborted?'Download cancelled; cached files are retained.':String(error.message).replace(/(?:sk-or-|hf_)[\w-]+/g,'[redacted]').slice(-500);});
      return service.status();
    },
    async cancelInstall() { job?.controller.abort(); return service.status(); },
  };
  return service;
}
