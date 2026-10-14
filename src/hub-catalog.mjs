import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {detectLocalHardware, inspectHubModel, modelFit, LOCAL_MODEL_CATALOG} from '../vendor/notch-core/desktop-harness.js';

const endpoint='https://huggingface.co/api/models', ttl=6*3600000;
const validRepo=repo=>typeof repo==='string' && /^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo);
function nextUrl(link) {
  const address=link?.match(/<([^>]+)>;\s*rel="?next"?/)?.[1];
  if(!address)return null;
  const url=new URL(address);
  if(address.length>4096 || url.origin!=='https://huggingface.co' || url.pathname!=='/api/models' || url.username || url.password)throw new Error('Hugging Face returned an invalid next page.');
  return url.href;
}
export function createHubCatalog(directory,{fetcher=fetch,inspect=inspectHubModel,hardware=detectLocalHardware}={}) {
  const file=path.join(directory,'huggingface-browser.json'),cache=new Map(),pending=new Map();
  let saving=Promise.resolve();
  const ready=fs.readFile(file,'utf8').then(text=>{
    const rows=JSON.parse(text);if(!Array.isArray(rows))return;
    for(const item of rows.slice(-32)) {
      try {
        const [key,row]=item,[runner,query,page]=JSON.parse(key);
        if(['ollama','mlx'].includes(runner) && typeof query==='string' && query.length<=120 && Number.isSafeInteger(page) && page>=0 && page<=100 && key===JSON.stringify([runner,query,page]) && Number.isFinite(row?.at) && row.at<=Date.now() && Array.isArray(row.repos) && row.repos.length<=40 && row.repos.every(validRepo) && (!row.next || nextUrl(`<${row.next}>; rel="next"`)))cache.set(key,row);
      }catch{/* Ignore malformed optional cache entries. */}
    }
  }).catch(()=>{});
  function save() {
    saving=saving.catch(()=>{}).then(async()=>{
      const temporary=`${file}.${randomUUID()}.tmp`;
      try{await fs.mkdir(directory,{recursive:true});await fs.writeFile(temporary,JSON.stringify([...cache]),{mode:0o600});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(()=>{});}
    });return saving.catch(()=>{});
  }
  async function inspectRows(repos,runner,token,signal) {
    const rows=[];
    for(let index=0;index<repos.length;index+=8) {
      const batch=await Promise.allSettled(repos.slice(index,index+8).map(repo=>inspect(repo,runner,signal,token)));
      for(const result of batch)if(result.status==='fulfilled' && validRepo(result.value?.repo) && result.value.runner===runner && Number.isSafeInteger(result.value.bytes) && result.value.bytes>0)rows.push(result.value);
    }
    return rows;
  }
  return {
    async list({runner,token,query='',page=0,force=false}={}) {
      if(typeof query!=='string' || query.length>120 || /[\x00-\x1f\x7f]/.test(query) || !Number.isSafeInteger(page) || page<0 || page>100 || typeof force!=='boolean')throw new Error('Enter a model search of up to 120 characters.');
      query=query.trim();const device=await hardware();runner ||= device.mlxSupported?'mlx':'ollama';
      if(!['ollama','mlx'].includes(runner) || (runner==='mlx'&&!device.mlxSupported))throw new Error('MLX requires an Apple Silicon Mac running macOS 14 or newer.');
      await ready;const key=JSON.stringify([runner,query.toLowerCase(),page]);let entry=cache.get(key),warning;
      if(force&&!page)for(const cachedKey of cache.keys()){const [r,q,p]=JSON.parse(cachedKey);if(r===runner&&q===query.toLowerCase()&&p>0)cache.delete(cachedKey);}
      if(force || !entry || Date.now()-entry.at>ttl) {
        if(!pending.has(key))pending.set(key,(async()=>{
          let address;
          if(page){const previous=cache.get(JSON.stringify([runner,query.toLowerCase(),page-1]));if(!previous?.next)throw new Error('Refresh the model search before loading more.');address=nextUrl(`<${previous.next}>; rel="next"`);}
          else {const url=new URL(endpoint);for(const [name,value]of Object.entries({search:query || 'coder',filter:runner==='mlx'?'mlx':'gguf',sort:'createdAt',direction:'-1',limit:'40',full:'true'}))url.searchParams.set(name,value);address=url.href;}
          const response=await fetcher(address,{headers:token?{Authorization:`Bearer ${token}`}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
          if(!response.ok)throw new Error(`Hugging Face search failed (HTTP ${response.status}). Retry shortly.`);
          const body=await response.json();if(!Array.isArray(body)||body.length>40)throw new Error('Hugging Face returned an invalid model list.');
          const repos=[...new Set(body.filter(row=>validRepo(row?.id)&&!row.private&&!row.disabled&&!row.gated && (!row.pipeline_tag || ['text-generation','image-text-to-text'].includes(row.pipeline_tag)) && row.siblings?.some(weight=>runner==='mlx'?/\.safetensors$/i.test(weight.rfilename):/Q4_K_M(?:-\d+-of-\d+)?\.gguf$/i.test(weight.rfilename)&&!/mmproj/i.test(weight.rfilename))).map(row=>row.id))];
          const value={at:Date.now(),repos,next:nextUrl(response.headers.get('link'))};cache.set(key,value);
          while(cache.size>32)cache.delete(cache.keys().next().value);await save();return value;
        })().finally(()=>pending.delete(key)));
        try{entry=await pending.get(key);}catch(error){if(!entry){if(query||page)throw error;entry={repos:LOCAL_MODEL_CATALOG.map(row=>runner==='mlx'?row.mlx:row.gguf),next:null};}warning=`Showing saved recommendations. ${error.message}`;}
      }
      const models=(await inspectRows(entry.repos,runner,token,AbortSignal.timeout(20000))).map(row=>({...row,...modelFit(row,device)})).sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)||a.repo.localeCompare(b.repo));
      if(entry.repos.length && !models.length)throw new Error('Model weights could not be verified. Retry the search shortly.');
      return {hardware:device,runner,query,page,models,nextPage:entry.next?page+1:null,warning};
    },
    async selected(repo,runner,token) {
      if(!validRepo(repo)||!['ollama','mlx'].includes(runner))throw new Error('Choose a compatible Hugging Face repository.');
      const device=await hardware();if(runner==='mlx'&&!device.mlxSupported)throw new Error('MLX requires Apple Silicon.');
      const row=await inspect(repo,runner,AbortSignal.timeout(15000),token);
      if(row.repo!==repo || row.runner!==runner || !Number.isSafeInteger(row.bytes) || row.bytes<=0)throw new Error('Model weights could not be verified.');
      return {...row,...modelFit(row,device)};
    },
  };
}
