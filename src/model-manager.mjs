import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cloudModelRows, normalizeOpenRouterFallbacks, openRouterModelKey } from './model-policy.mjs';
import { localContextProfile } from './model-policy.mjs';
import { installLocalModel } from './cli-bridge.mjs';
import {createHubCatalog} from './hub-catalog.mjs';
import { prepareColibri, colibriCatalog, colibriStatus, colibriPlan, colibriModels, installColibri, validateColibri, stopColibri, colibriCompatibility, setColibriPreference } from '../vendor/notch-core/desktop-harness.js';

import { prepareStrata, strataCatalog, strataModels, strataStatus, strataPlan, installStrata, stopStrata, setStrataDirectory, detectLocalHardware } from '../vendor/notch-core/desktop-harness.js';

export function createModelManager(directory, { safeStorage, fetcher = fetch, recommend: recommendModels, install = installLocalModel,
  hardware: detectHardware = detectLocalHardware, chooseModelDirectory, strata = {prepareStrata,strataCatalog,strataModels,strataStatus,strataPlan,installStrata,stopStrata,setStrataDirectory},
  colibri = { prepareColibri, colibriCatalog, colibriStatus, colibriPlan, colibriModels, installColibri, validateColibri, stopColibri, colibriCompatibility, setColibriPreference } } = {}) {
  const keys = new Map(), preferences = new Map(), fallbacks = new Map();
  const keyFile = path.join(directory, 'provider-keys.encrypted.json'), contextFile = path.join(directory, 'model-context.json'), catalogFile = path.join(directory, 'openrouter-models.json');
  const fallbackFile = path.join(directory, 'openrouter-fallbacks.json');
  const mlxFile = path.join(directory,'mlx-models.json');
  const workspaceFile = path.join(directory,'task-workspace.json');
  let workspaceMode = 'shared';
  const hub=createHubCatalog(directory,{fetcher});
  let cached, pending, job, keyLoadError, installedMlx = [];
  let persistent = false;
  const secure = () => persistent;
  const ready = (async () => {
    try { const value = JSON.parse(await fs.readFile(workspaceFile,'utf8')); if (!['shared','isolated'].includes(value.mode)) throw new Error('Invalid task workspace setting.'); workspaceMode = value.mode; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    persistent = !!safeStorage && await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (secure()) try { const values = JSON.parse(await fs.readFile(keyFile, 'utf8')); for (const provider of ['openrouter','huggingface']) if (typeof values[provider] === 'string') keys.set(provider, (await safeStorage.decryptStringAsync(Buffer.from(values[provider], 'base64'))).result); } catch (error) { if (error.code !== 'ENOENT') { keys.clear(); keyLoadError = 'Saved provider keys could not be decrypted. Reconnect the provider.'; } }
    try { const values = JSON.parse(await fs.readFile(contextFile, 'utf8')); for (const [model,value] of Object.entries(values)) if (Number.isSafeInteger(value) && value >= 2048) preferences.set(model,value); } catch { /* Context choices are optional. */ }
    try { const values = JSON.parse(await fs.readFile(fallbackFile, 'utf8')); for (const [model,ids] of Object.entries(values)) { const next = normalizeOpenRouterFallbacks(model, ids); if (next.length) fallbacks.set(model, next); } } catch { /* Fallback chains are optional. */ }
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
    async getWorkspaceMode() { await ready; return workspaceMode; },
    async setWorkspaceMode(mode) { await ready; if (!['shared','isolated'].includes(mode)) throw new Error('Choose Project folder or Isolated worktrees.'); await atomic(workspaceFile,{mode}); workspaceMode=mode; return mode; },
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
    async cloudCatalog(force = false, browse = false) {
      await ready;
      if (!keys.has('openrouter') && !browse) return [];
      if (force || !cached || Date.now()-cached.at > 6*3600000) {
        pending ??= (async () => {
          const response = await fetcher('https://openrouter.ai/api/v1/models', { headers: keys.has('openrouter')?{ Authorization: `Bearer ${keys.get('openrouter')}` }:{}, redirect: 'error', signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`OpenRouter model refresh failed (HTTP ${response.status}).`);
          const body = await response.json(); cloudModelRows(body.data,true);
          cached = { at: Date.now(), data: body.data }; await atomic(catalogFile,cached);
        })().finally(()=>{pending=undefined;});
        try { await pending; } catch (error) { if (!cached) throw error; }
      }
      return cloudModelRows(cached.data,keys.has('openrouter')).map(row=>({ ...row, defaultContextWindow: service.context(row.key,row.availableContextWindows,row.defaultContextWindow) }));
    },
    context(model, choices, fallback) { const value = preferences.get(model); return choices.includes(value) ? value : value ? choices.filter(n=>n<=value).at(-1) || fallback : fallback; },
    requestedContext(model) { return preferences.get(model); },
    async mlxModels(hardware) {
      await ready; if (!hardware.mlxSupported) return [];
      // shortcut: older installs lack native metadata; keep their conservative 8K limit until reinstalled.
      return installedMlx.map(row=>{ const nativeContext=Number.isSafeInteger(row.contextLength) && row.contextLength>=2048 ? row.contextLength : 8192;
        const fit=localContextProfile(row.bytes,hardware,{capabilities:['tools'],model_info:{'general.architecture':'mlx','mlx.context_length':nativeContext}});
        return { key:`mlx/${row.repo}`,displayName:row.repo,provider:'mlx',bytes:row.bytes,description:fit.fits?'local MLX · estimated memory fit':fit.reason,
          source:'system',enabled:fit.fits,isDefault:true,isNew:false,priceFactor:0,tags:['local'],maxInputTokens:nativeContext,maxOutputTokens:2048,availableContextWindows:fit.choices,
          defaultContextWindow:service.context(`mlx/${row.repo}`,fit.choices,fit.contextWindow),recommendedContextWindow:fit.contextWindow,requestedContextWindow:service.requestedContext(`mlx/${row.repo}`),efforts:[],defaultEffort:null,supportsDisabled:true }; });
    },
    async strataModels(hardware) {
      return (await strata.strataModels(hardware)).map(row=>({...row,defaultContextWindow:service.context(row.key,row.availableContextWindows,row.defaultContextWindow),requestedContextWindow:service.requestedContext(row.key)}));
    },
    async strata(action, value) {
      await ready;
      if(!['catalog','setup','install','unload','directory'].includes(action))throw new Error('Choose a supported Strata action.');
      if(action==='catalog')return {...await strata.strataCatalog(await detectHardware(true)),...await strata.strataStatus()};
      if(action==='unload'){await strata.stopStrata();return service.strata('catalog');}
      if(job?.public.state==='running')throw new Error('A model download is already running.');
      if(action==='directory'){
        const directory=value===undefined?await chooseModelDirectory?.():value;
        if(directory)await strata.setStrataDirectory(directory);
        return service.strata('catalog');
      }
      if(action==='install'&&(typeof value!=='string'||!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)))throw new Error('Choose a Strata catalog model.');
      const controller=new AbortController();job={controller,public:{id:randomUUID(),repo:action==='setup'?'Strata engine':value,runner:'strata',state:'running',message:'Preparing experimental Strata…'}};
      const current=job,output=text=>{current.public.message=text.replace(/\x1b\[[0-9;]*m/g,'').trim().slice(-500);};
      void (async()=>{
        if(action==='setup')await strata.prepareStrata(controller.signal,output);
        else await strata.installStrata(value,await detectHardware(true),controller.signal,output);
        current.public.state='complete';current.public.message=action==='setup'?'Strata control is ready. Choose a model below.':'Strata model prepared. Select it in Installed; hardware and context are checked before loading. Speed benchmarks are off.';
      })().catch(error=>{current.public.state=controller.signal.aborted?'cancelled':'failed';current.public.message=String(error.message).slice(-500);});
      return service.status();
    },
    async colibriModels(hardware) {
      return (await colibri.colibriModels(hardware)).map(row=>({...row,defaultContextWindow:service.context(row.key,row.availableContextWindows,row.defaultContextWindow),requestedContextWindow:service.requestedContext(row.key)}));
    },
    async colibri(action, model) {
      await ready;
      if (!['catalog','setup','install','unload','backend','benchmark'].includes(action)) throw new Error('Choose a supported Colibri action.');
      if (action==='catalog') {
        const status=await colibri.colibriStatus();
        let compatibility={};
        if(status.installed && colibri.colibriCompatibility)try{compatibility=await colibri.colibriCompatibility();}catch{compatibility={backends:['cpu','vulkan','cuda','metal'].map(backend=>({backend,label:backend.toUpperCase(),available:false,reason:'Hardware compatibility could not be verified. Refresh and check the Colibri log.'}))};}
        return {...status,...compatibility,models:status.installed?await colibri.colibriCatalog():[]};
      }
      if (action==='unload') { await colibri.stopColibri(); return service.colibri('catalog'); }
      if (job?.public.state==='running') throw new Error('A model download is already running.');
      if(action==='backend' || action==='benchmark') { await colibri.setColibriPreference(action==='backend'?'backend':'benchmarkEnabled',model); return service.colibri('catalog'); }
      if (action==='install' && (typeof model!=='string' || !/^[a-z0-9-]{1,80}$/.test(model))) throw new Error('Choose a Colibri catalog model.');
      const controller=new AbortController();
      job={controller,public:{id:randomUUID(),repo:action==='setup'?'Colibri engine':model,runner:'colibri',state:'running',message:action==='setup'?'Preparing Colibri…':'Preparing resumable model download…'}};
      const current=job,output=text=>{const line=text.replace(/\x1b\[[0-9;]*m/g,'').trim().split(/[\r\n]+/).filter(Boolean).at(-1);if(line)current.public.message=line.replace(/(?:sk-or-|hf_)[\w-]+/g,'[redacted]').slice(-500);};
      void (async()=>{
        if(action==='setup')await colibri.prepareColibri(controller.signal,output);
        else { let installed=false; try {
          await colibri.installColibri(model,{signal:controller.signal,token:keys.get('huggingface'),output});
          installed=true;
        } finally {if(installed)await colibri.stopColibri();} }
        current.public.state='complete';current.public.message=action==='setup'?'Colibri is ready. Choose a coding model below.':'Tool validation passed. Open Installed to select the model; weights load when you send a message.';
      })().catch(error=>{current.public.state=controller.signal.aborted?'cancelled':'failed';current.public.message=String(error.message).replace(/(?:sk-or-|hf_)[\w-]+/g,'[redacted]').slice(-500);});
      return service.status();
    },
    fallbacks(model) { return [...(fallbacks.get(model) || [])]; },
    allFallbacks() { return Object.fromEntries(fallbacks); },
    async setFallbacks(model, ids, models) {
      await ready;
      const key = openRouterModelKey(model);
      const row = Array.isArray(models) ? models.find(item => item.key === key && item.provider === 'openrouter') : undefined;
      if (!row) throw new Error('Choose an OpenRouter model before setting fallbacks.');
      const allowed = new Set(models.filter(item => item.provider === 'openrouter' && item.tools !== false).map(item => item.key));
      const next = normalizeOpenRouterFallbacks(key, ids, allowed);
      if (Array.isArray(ids) && ids.length && !next.length) throw new Error('Choose tool-capable OpenRouter models that are not already selected.');
      if (next.length) fallbacks.set(key, next); else fallbacks.delete(key);
      await atomic(fallbackFile, Object.fromEntries(fallbacks));
      return service.allFallbacks();
    },
    async setContext(model, tokens, models) { await ready; const row = models.find(row=>row.key===model && (row.enabled || ['colibri','strata'].includes(row.provider))); if (!row || (tokens!=='auto' && !row.availableContextWindows.includes(tokens))) throw new Error('Choose a supported context limit for this model.');
      if(row.provider==='strata'){if((await strata.strataStatus()).running)throw new Error('Unload Strata before changing context.');if(!(await strata.strataPlan(tokens==='auto'?undefined:tokens)).fits)throw new Error('This Strata context exceeds current free memory.');}
      if(row.provider==='colibri'){if((await colibri.colibriStatus()).running)throw new Error('Unload Colibri before changing context so free memory can be checked accurately.');if(!(await colibri.colibriPlan(tokens==='auto'?undefined:tokens)).fits)throw new Error('This Colibri context exceeds current free memory. Close applications or choose a smaller context.');}
      if(tokens==='auto')preferences.delete(model);else preferences.set(model,tokens); await atomic(contextFile,Object.fromEntries(preferences)); },
    async hubCatalog(runner, options={}) { await ready; if (runner !== undefined && !['ollama','mlx'].includes(runner)) throw new Error('Choose Ollama or MLX.'); if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(key=>!['query','page','force'].includes(key)))throw new Error('Invalid model search.'); return (recommendModels || (args=>hub.list(args)))({ ...options,runner,token:keys.get('huggingface') }); },
    async startInstall(repo, runner) {
      await ready; if (job?.public.state==='running') throw new Error('A model download is already running.');
      const row=recommendModels?(await service.hubCatalog(runner)).models.find(row=>row.repo===repo && row.fits):await hub.selected(repo,runner,keys.get('huggingface'));
      if (!row?.fits) throw new Error('Choose a compatible model that fits current memory.');
      const cwd = path.join(directory,'model-installs'); await fs.mkdir(cwd,{recursive:true});
      if (job?.public.state==='running') throw new Error('A model download is already running.');
      const controller = new AbortController(); job = { controller, public: { id: randomUUID(), repo, runner, state: 'running', message: 'Preparing download…' } }; const current = job;
      void install(repo,runner,{ cwd, signal: controller.signal, env: keys.has('huggingface') ? { HF_TOKEN: keys.get('huggingface') } : {}, onOutput: ({text})=>{
        const line=text.replace(/\x1b\[[0-9;]*m/g,'').trim().split(/[\r\n]+/).filter(Boolean).at(-1);if(!line)return;
        current.public.message=line.replace(/(?:sk-or-|hf_)[\w-]+/g,'[redacted]').slice(-500);
        const percent=line.match(/^(\d{1,3})% - /);current.public.percent=percent?Math.min(100,Number(percent[1])):undefined;
      } })
        .then(async()=>{if(runner==='mlx'){installedMlx=[...installedMlx.filter(item=>item.repo!==repo),{repo,bytes:row.bytes,...(Number.isSafeInteger(row.contextLength) && row.contextLength>=2048 ? {contextLength:row.contextLength} : {})}];await atomic(mlxFile,installedMlx);}current.public.state='complete';current.public.message='Ready. Open Installed to select this model. It loads when you send a message.';})
        .catch(error=>{current.public.state=controller.signal.aborted?'cancelled':'failed';current.public.message=controller.signal.aborted?'Download cancelled; cached files are retained.':String(error.message).replace(/(?:sk-or-|hf_)[\w-]+/g,'[redacted]').slice(-500);});
      return service.status();
    },
    async cancelInstall() { job?.controller.abort(); return service.status(); },
  };
  return service;
}
