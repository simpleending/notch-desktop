import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHubCatalog} from '../src/hub-catalog.mjs';
import {modelPreload,patchModelPreload} from '../src/model-ipc.mjs';
const GiB=2**30;
const device={availableMemory:14*GiB,totalMemory:24*GiB,availableVram:0,mlxSupported:false};
const directory=()=>mkdtemp(path.join(os.tmpdir(),'notch-hub-test-'));
const row=(id,extra={})=>({id,siblings:[{rfilename:'weights.Q4_K_M.gguf'}],...extra});
const inspect=async(repo,runner)=>({repo,runner,bytes:repo.endsWith('huge')?40*GiB:2*GiB,createdAt:repo.endsWith('new')?'2026-10-14':'2026-10-01',license:'apache-2.0'});
const response=(rows,link=null)=>({ok:true,json:async()=>rows,headers:{get:()=>link}});

test('remote prefix search finds more than curated models, filters incompatible weights and estimates memory',async()=>{
  let requests=0;
  const catalog=createHubCatalog(await directory(),{hardware:async()=>device,inspect,fetcher:async(address,options)=>{
    requests++;const url=new URL(address);
    assert.equal(url.searchParams.get('search'),'gemm');assert.equal(url.searchParams.get('filter'),'gguf');
    assert.equal(url.searchParams.get('sort'),'createdAt');assert.equal(url.searchParams.get('direction'),'-1');
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer hf_test');
    return response(['a','b','c','new','huge'].map(name=>row(`lab/gemma-${name}`)).concat([
      row('lab/private',{private:true}),row('lab/gated',{gated:'auto'}),row('lab/disabled',{disabled:true}),
      row('lab/audio',{pipeline_tag:'text-to-speech'}),row('lab/f16',{siblings:[{rfilename:'weights.F16.gguf'}]}),
      row('lab/projection',{siblings:[{rfilename:'mmproj.Q4_K_M.gguf'}]}),row('../escape'),
    ]));
  }});
  const [a,b]=await Promise.all([catalog.list({query:'gemm',token:'hf_test'}),catalog.list({query:'gemm',token:'hf_test'})]);
  assert.equal(requests,1);assert.deepEqual(a,b);assert.equal(a.models.length,5);assert.equal(a.models[0].repo,'lab/gemma-new');
  assert.equal(a.models.find(row=>row.repo.endsWith('huge')).fits,false);assert.equal(a.models[0].fits,true);
});

test('pages and disk cache avoid repeated fetches; refresh invalidates old cursors',async()=>{
  const root=await directory();let requests=0;
  const fetcher=async address=>{requests++;return new URL(address).searchParams.has('cursor')?response([row('lab/second')]):response([row('lab/first')],'<https://huggingface.co/api/models?cursor=next>; rel="next"');};
  const options={hardware:async()=>device,inspect,fetcher},catalog=createHubCatalog(root,options);
  assert.equal((await catalog.list({query:'gemma'})).nextPage,1);
  assert.equal((await catalog.list({query:'gemma',page:1})).models[0].repo,'lab/second');assert.equal(requests,2);
  const restored=createHubCatalog(root,options);await restored.list({query:'gemma'});assert.equal(requests,2);
  await restored.list({query:'gemma',force:true});await restored.list({query:'gemma',page:1});assert.equal(requests,4);
  assert.doesNotMatch(await readFile(path.join(root,'huggingface-browser.json'),'utf8'),/Bearer|hf_test/);
});

test('foreign pagination is rejected before a credential can leave the Hub',async()=>{
  let requests=0;
  const catalog=createHubCatalog(await directory(),{hardware:async()=>device,inspect,fetcher:async address=>{
    requests++;assert.equal(new URL(address).origin,'https://huggingface.co');
    return response([row('lab/gemma')],'<https://evil.example/api/models?cursor=x>; rel="next"');
  }});
  await assert.rejects(catalog.list({query:'gemm',token:'hf_test'}),/invalid next page/);assert.equal(requests,1);
});

test('malformed optional cache is ignored and cached search survives network failure visibly',async()=>{
  const root=await directory();
  await writeFile(path.join(root,'huggingface-browser.json'),JSON.stringify([['invalid',{at:Date.now(),repos:[],next:null}]]));
  let offline=false;const catalog=createHubCatalog(root,{hardware:async()=>device,inspect,fetcher:async()=>{
    if(offline)throw new Error('offline');return response([row('lab/gemma')]);
  }});
  await catalog.list({query:'gemm',force:true});offline=true;
  const cached=await catalog.list({query:'gemm',force:true});assert.equal(cached.models.length,1);assert.match(cached.warning,/saved.*offline/);
  await assert.rejects(catalog.list({query:'missing'}),/offline/);
});

test('invalid requests and unsupported MLX are rejected; failed verification is not an empty success',async()=>{
  const catalog=createHubCatalog(await directory(),{hardware:async()=>device,inspect:async()=>{throw new Error('unavailable');},fetcher:async()=>response([row('lab/gemma')])});
  for(const args of [{query:'x'.repeat(121)},{query:'a\n'},{page:-1},{page:101},{page:'1'},{force:1}])await assert.rejects(catalog.list(args),/search/);
  await assert.rejects(catalog.list({runner:'mlx'}),/Apple Silicon/);
  await assert.rejects(catalog.list({query:'gemm'}),/could not be verified/);
  await assert.rejects(catalog.selected('../escape','ollama'),/repository/);
});

test('MLX search uses safetensors and selection rechecks current hardware beyond curated models',async()=>{
  let memory=14*GiB;
  const catalog=createHubCatalog(await directory(),{hardware:async()=>({...device,mlxSupported:true,appleSilicon:true,availableMemory:memory}),inspect,fetcher:async address=>{
    assert.equal(new URL(address).searchParams.get('filter'),'mlx');
    return response([row('lab/gemma',{siblings:[{rfilename:'model.safetensors'}]}),row('lab/gguf')]);
  }});
  const models=await catalog.list({query:'gemma'});assert.equal(models.runner,'mlx');assert.equal(models.models.length,1);
  assert.equal((await catalog.selected('lab/gemma','mlx')).fits,true);
  memory=2*GiB;assert.equal((await catalog.selected('lab/gemma','mlx')).fits,false);
});

test('preload migration is idempotent and forwards the remote search and page through IPC',async()=>{
  const current=patchModelPreload('');assert.equal(patchModelPreload(current),current);
  const old=current.replace("hub:(runner,options)=>ipcRenderer.invoke('notch-models:hub',runner,options)","hub:runner=>ipcRenderer.invoke('notch-models:hub',runner)");
  assert.equal(patchModelPreload(old),current);assert.throws(()=>patchModelPreload('/* notch model settings bridge */'),/expected version/);
  assert.equal(patchModelPreload(current.replace("\n  cloud:force=>ipcRenderer.invoke('notch-models:cloud',force),",'')),current);
  let bridge,request;
  vm.runInNewContext(current,{window:{location:{protocol:'notch-app:',search:''}},URLSearchParams,require:()=>({
    contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}},ipcRenderer:{invoke:(...args)=>{request=args;}},
  })});
  bridge.hub('ollama',{query:'gemm',page:1});assert.deepEqual(request,['notch-models:hub','ollama',{query:'gemm',page:1}]);
  bridge.cloud(true);assert.deepEqual(request,['notch-models:cloud',true]);
});

test('default Hub browsing includes chat conversions instead of restricting names to coding families',async()=>{
  const catalog=createHubCatalog(await directory(),{hardware:async()=>device,inspect,fetcher:async address=>{
    const url=new URL(address);assert.equal(url.searchParams.get('search'),'');assert.equal(url.searchParams.get('filter'),'gguf');
    return response([row('lab/gemma-chat'),row('lab/deepseek-code')]);
  }});
  assert.equal((await catalog.list()).models.length,2);
});
