import {withLocalInference, startMlx, stopMlx, loadedMlxModel, startColibri, stopColibri, colibriStatus, startStrata, stopStrata, strataStatus} from '../vendor/notch-core/desktop-harness.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export const localRuntime = {withLocalInference, startMlx, stopMlx, loadedMlxModel, startColibri, stopColibri, colibriStatus, startStrata, stopStrata, strataStatus};
export function createLocalModelLifecycle({fetcher=fetch, runtime=localRuntime, catalog, endpoint, context, assertIdle, invalidate=()=>{}, preferenceFile}) {
  let pending;
  const pinned = new Set();
  let loading;
  const ready = () => loading ??= preferenceFile ? fs.readFile(preferenceFile,'utf8').then(text=>{const keys=JSON.parse(text);if(Array.isArray(keys))for(const key of keys)if(typeof key==='string'&&/^ollama\/.{1,500}$/.test(key))pinned.add(key);}).catch(error=>{if(error.code!=='ENOENT')throw error;}) : Promise.resolve();
  async function pin(key, enabled) {
    await ready();
    if(enabled)pinned.add(key);else pinned.delete(key);
    if(preferenceFile){await fs.mkdir(path.dirname(preferenceFile),{recursive:true});await fs.writeFile(preferenceFile+'.tmp',JSON.stringify([...pinned]));await fs.rename(preferenceFile+'.tmp',preferenceFile);}
  }
  async function ollama(root, route, body) {
    const response=await fetcher(root+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?180000:2000)});
    if(!response.ok)throw Error(`Local model request failed (HTTP ${response.status}).`);
    return response.json();
  }
  async function mountedOllama() {
    const roots=['http://127.0.0.1:11436','http://127.0.0.1:11434'];
    const result=[];
    for(const root of roots){let data;try{data=await ollama(root,'/api/ps');}catch{continue;}
      for(const row of data.models || [])if(typeof row.name==='string')result.push({key:'ollama/'+row.name,root,name:row.name});
    }
    return result;
  }
  async function mounted() {
    const result=await mountedOllama();
    const colibri=await runtime.colibriStatus(),strata=await runtime.strataStatus(),mlx=runtime.loadedMlxModel();
    if(colibri.running)result.push({key:'colibri/'+colibri.modelId});
    if(strata.running)result.push({key:'strata/'+strata.selected.id});
    if(mlx)result.push({key:'mlx/'+mlx});
    return result;
  }
  async function eject(row) {
    try{
    if(row.key.startsWith('ollama/')){
      await ollama(row.root,'/api/generate',{model:row.name,stream:false,keep_alive:0});
      if((await ollama(row.root,'/api/ps')).models?.some(model=>model.name===row.name))throw Error('The model is still loaded. Wait for its current request to finish and retry.');
      await pin(row.key,false);
    }else if(row.key.startsWith('colibri/'))await runtime.stopColibri();
    else if(row.key.startsWith('strata/'))await runtime.stopStrata();
    else if(row.key.startsWith('mlx/'))await runtime.stopMlx();
    if(!row.root&&(await mounted()).some(item=>item.key===row.key))throw Error('The previous local model is still loaded. Retry ejecting it before switching.');
    }finally{invalidate();}
  }
  const keep=(row,key)=>row.key===key&&(!row.root||row.root===endpoint(key)?.replace(/\/v1\/?$/,''));
  async function perform(action,key) {
    if(!['mount','toggle','eject'].includes(action)||typeof key!=='string'||! /^(ollama|colibri|strata|mlx)\/.{1,500}$/.test(key))throw Error('Choose an installed local model.');
    let active=await mounted();
    const selected=active.filter(item=>item.key===key);
    if(action==='eject'||action==='toggle'&&selected.length){for(const item of selected)await eject(item);if((await mounted()).some(item=>item.key===key))throw Error('The model is still loaded. Refresh and retry ejecting it.');await pin(key,false);return{loaded:false};}
    const rows=await catalog(),row=rows.find(row=>row.key===key);
    if(!row)throw Error('Choose an installed local model.');
    for(const item of active)if(!keep(item,key))await eject(item);
    // Recheck real free memory after releasing the previous model.
    const verified=(await catalog()).find(item=>item.key===key);
    if(!verified?.enabled)throw Error(verified?.description||'This model does not fit current memory.');
    const limit=context(key,verified),model=key.slice(key.indexOf('/')+1);
    try{if(key.startsWith('ollama/')){
      const root=endpoint(key)?.replace(/\/v1\/?$/,'');
      if(!['http://127.0.0.1:11436','http://127.0.0.1:11434'].includes(root))throw Error('The local model endpoint is unavailable. Refresh models and retry.');
      await ollama(root,'/api/generate',{model,stream:false,keep_alive:-1,options:{num_ctx:limit,num_batch:128}});
    }else if(key.startsWith('colibri/'))await runtime.startColibri(model,limit);
    else if(key.startsWith('strata/'))await runtime.startStrata(model,limit);
    else if(key.startsWith('mlx/'))await runtime.startMlx(model);
    }finally{invalidate();}
    active=await mounted();
    if(!active.some(item=>item.key===key))throw Error('The model did not finish loading. Refresh models and retry.');
    if(key.startsWith('ollama/'))await pin(key,true);
    return{loaded:true};
  }
  return {mounted, mountedOllama, async keepAlive(key){await ready();return pinned.has(key)?-1:undefined;}, async prepare(key){return runtime.withLocalInference(async()=>{for(const row of await mounted())if(!keep(row,key))await eject(row);});}, get busy(){return !!pending;},
    change(action,key) {
      if(pending)throw Error('A local model is already loading or ejecting. Wait for it to finish.');
      assertIdle();
      pending=runtime.withLocalInference(()=>{assertIdle();return perform(action,key);}).finally(()=>{pending=undefined;});
      return pending;
    },
  };
}
