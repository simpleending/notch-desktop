import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalModelLifecycle} from '../src/local-model-lifecycle.mjs';
import {registerModelIpc,patchModelPreload,modelPreload} from '../src/model-ipc.mjs';
import {createHost} from '../src/notch-host.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fixture(){
 const loaded=new Map([['ollama/old','http://127.0.0.1:11436']]),calls=[];
 let busy=false,failLoad=false,failEject=false;
 const keys=['ollama/old','ollama/next','colibri/coder','strata/coder','mlx/lab/coder'];
 const runtime={withLocalInference:async fn=>{calls.push('lease');return fn();},loadedMlxModel:()=>loaded.has('mlx/lab/coder')?'lab/coder':undefined,
  colibriStatus:async()=>({running:loaded.has('colibri/coder'),modelId:'coder'}),strataStatus:async()=>({running:loaded.has('strata/coder'),selected:{id:'coder'}})};
 for(const [provider,name] of [['colibri','Colibri'],['strata','Strata'],['mlx','Mlx']]){
  runtime['stop'+name]=async()=>{calls.push('eject '+provider);for(const key of loaded.keys())if(key.startsWith(provider+'/'))loaded.delete(key);};
  runtime['start'+name]=async(id,context)=>{assert.equal(loaded.size,0,'Old engine must stop before another loads.');if(provider!=='mlx'){assert.equal(id,'coder');assert.equal(context,8192);}calls.push('load '+provider);loaded.set(provider+'/'+(provider==='mlx'?'lab/coder':'coder'),true);};
 }
 const fetcher=async(url,init)=>{
  const root=new URL(url).origin;
  if(root.endsWith('11434'))throw Error('Not running');
  if(url.endsWith('/api/ps'))return{ok:true,json:async()=>({models:[...loaded].filter(([key,host])=>key.startsWith('ollama/')&&host===root).map(([key])=>({name:key.slice(7)}))})};
  assert(url.endsWith('/api/generate'));const body=JSON.parse(init.body);assert.equal(body.prompt,undefined,'Mount requests must not run a benchmark or generate content.');
  if(body.keep_alive===0){calls.push('eject '+body.model);if(failEject)return{ok:false,status:503};loaded.delete('ollama/'+body.model);}
  else{assert.equal(loaded.size,0);assert.equal(body.options.num_ctx,8192);calls.push('load '+body.model);if(failLoad)return{ok:false,status:500};loaded.set('ollama/'+body.model,root);}
  return{ok:true,json:async()=>({done:true})};
 };
 const lifecycle=createLocalModelLifecycle({runtime,fetcher,catalog:async()=>keys.map(key=>({key,enabled:true,defaultContextWindow:8192})),endpoint:()=> 'http://127.0.0.1:11436/v1',context:()=>8192,assertIdle:()=>{if(busy)throw Error('Active response');}});
 return{loaded,calls,lifecycle,runtime,set busy(value){busy=value;},set failLoad(value){failLoad=value;},set failEject(value){failEject=value;}};
}

test('an integrated GPU resident does not hide a model that fits after releasing its shared RAM',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-uma-switch-')),GiB=2**30;
 const host=createHost(directory,{hardware:async()=>({totalMemory:32*GiB,availableMemory:4*GiB,totalVram:GiB/2,availableVram:0}),
  runtime:{withLocalInference:fn=>fn(),colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>undefined},
  fetcher:async url=>{
   if(url.includes(':11434'))throw Error('No secondary daemon');
   if(url.endsWith('/api/tags'))return Response.json({models:[{name:'resident',size:3*GiB,digest:'resident'},{name:'next',size:3*GiB,digest:'next'}]});
   if(url.endsWith('/api/ps'))return Response.json({models:[{name:'resident',digest:'resident',size:4*GiB,size_vram:4*GiB,context_length:8192}]});
   return Response.json({capabilities:['tools'],model_info:{'general.architecture':'test','test.context_length':8192}});
  }});
 try{assert.equal((await host.listModels(true)).find(row=>row.key==='ollama/next').enabled,true);}
 finally{await host.workspaceSearch.shutdown();await fs.rm(directory,{recursive:true,force:true});}
});
test('switching releases the old Ollama model before mounting the next; toggle and eject keep installed inventory',async()=>{
 const f=fixture();assert.deepEqual(await f.lifecycle.change('mount','ollama/next'),{loaded:true});
 assert.deepEqual([...f.loaded.keys()],['ollama/next']);assert(f.calls.indexOf('eject old')<f.calls.indexOf('load next'));
 assert.deepEqual(await f.lifecycle.change('toggle','ollama/next'),{loaded:false});assert.equal(f.loaded.size,0);
 await f.lifecycle.change('eject','ollama/next');await f.lifecycle.change('mount','ollama/old');assert(f.loaded.has('ollama/old'));
});
test('switching across all local providers releases each preceding engine',async()=>{
 const f=fixture();for(const key of ['colibri/coder','strata/coder','mlx/lab/coder','ollama/next']){
  assert.deepEqual(await f.lifecycle.change('mount',key),{loaded:true});assert.deepEqual([...f.loaded.keys()],[key]);
 }
});

for(const provider of ['colibri','strata']){
 test(`${provider} failed startup clears busy state and allows remount`,async()=>{
  const f=fixture(),key=provider+'/coder',method=provider==='colibri'?'startColibri':'startStrata';
  const start=f.runtime[method];f.runtime[method]=async()=>{throw Error('Engine exited during loading');};
  await assert.rejects(f.lifecycle.change('mount',key),/Engine exited/);
  assert.equal(f.lifecycle.busy,false);assert.equal(f.loaded.size,0);
  f.runtime[method]=start;
  assert.deepEqual(await f.lifecycle.change('mount',key),{loaded:true});
  assert.deepEqual([...f.loaded.keys()],[key]);
  await f.lifecycle.change('eject',key);assert.equal(f.lifecycle.busy,false);assert.equal(f.loaded.size,0);
 });
 test(`${provider} supports toggle, explicit eject, and switching in both directions without losing inventory`,async()=>{
  const f=fixture(),key=provider+'/coder';
  for(const action of ['toggle','eject']){
   await f.lifecycle.change('mount',key);assert.deepEqual([...f.loaded.keys()],[key]);
   assert.deepEqual(await f.lifecycle.change(action,key),{loaded:false});assert.equal(f.loaded.size,0);
  }
  await f.lifecycle.change('mount',key);await f.lifecycle.change('mount','ollama/next');
  assert.deepEqual([...f.loaded.keys()],['ollama/next']);
  await f.lifecycle.change('mount',key);assert.deepEqual([...f.loaded.keys()],[key]);
  await f.lifecycle.prepare('ollama/next');assert.equal(f.loaded.size,0);
  assert.equal(f.lifecycle.busy,false);
 });
 test(`${provider} stop verification prevents another engine from loading if memory was not released`,async()=>{
  const f=fixture(),key=provider+'/coder';
  await f.lifecycle.change('mount',key);
  // Exercise the real status recheck, even when the control command claims success.
  const original=f.loaded.delete.bind(f.loaded);f.loaded.delete=()=>false;
  await assert.rejects(f.lifecycle.change('mount','ollama/next'),/still loaded/);
  assert.deepEqual([...f.loaded.keys()],[key]);assert.equal(f.lifecycle.busy,false);
  f.loaded.delete=original;
  await f.lifecycle.change('eject',key);assert.equal(f.loaded.size,0);
 });
}
test('active responses and overlapping actions cannot be interrupted; errors never claim a model loaded',async()=>{
 const f=fixture();f.busy=true;assert.throws(()=>f.lifecycle.change('eject','ollama/old'),/Active/);assert(f.loaded.has('ollama/old'));f.busy=false;
 const pending=f.lifecycle.change('mount','ollama/next');assert.throws(()=>f.lifecycle.change('mount','ollama/old'),/already loading/);await pending;
 f.failEject=true;await assert.rejects(f.lifecycle.change('mount','colibri/coder'),/503/);assert(f.loaded.has('ollama/next'));assert(!f.loaded.has('colibri/coder'));
 f.failEject=false;f.failLoad=true;await assert.rejects(f.lifecycle.change('mount','ollama/old'),/500/);assert.equal(f.loaded.size,0);assert.equal(f.lifecycle.busy,false);
 await assert.rejects(f.lifecycle.change('mount','openrouter/cloud'),/local model/);
});
test('preparing a resumed local turn releases a different resident without warming or generating',async()=>{
 const f=fixture();await f.lifecycle.prepare('ollama/next');assert.equal(f.loaded.size,0);assert(!f.calls.some(call=>call.startsWith('load ')));
});

test('a queued eject rechecks active responses after taking the inference lease',async()=>{
 const f=fixture();let release;const gate=new Promise(resolve=>release=resolve);
 f.runtime.withLocalInference=async fn=>{await gate;return fn();};
 const eject=f.lifecycle.change('eject','ollama/old');f.busy=true;release();
 await assert.rejects(eject,/Active response/);assert(f.loaded.has('ollama/old'));assert.equal(f.lifecycle.busy,false);
});

test('repeated mount/eject/remount and rejected double-clicks leave exactly the intended resident',async()=>{
 const f=fixture();
 for(let i=0;i<12;i++)for(const key of ['colibri/coder','strata/coder','ollama/next']){
  const mount=f.lifecycle.change('mount',key);
  assert.throws(()=>f.lifecycle.change('toggle',key),/already loading/);await mount;
  assert.deepEqual([...f.loaded.keys()],[key]);
  await f.lifecycle.change('eject',key);assert.equal(f.loaded.size,0);
  await f.lifecycle.change('mount',key);assert.deepEqual([...f.loaded.keys()],[key]);
 }
});

test('an overlapping catalog refresh cannot put a stale Loaded label back after eject',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-catalog-eject-'));
 let loaded=true,pause=false,release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 const runtime={withLocalInference:fn=>fn(),colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>undefined};
 const host=createHost(directory,{runtime,hardware:async()=>({totalMemory:32*2**30,availableMemory:24*2**30,totalVram:0,availableVram:0}),fetcher:async(url,init)=>{
  if(url.includes(':11434'))throw Error('No secondary daemon');
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'old',size:2**30}]});
  if(url.endsWith('/api/ps'))return Response.json({models:loaded?[{name:'old',size:2**30}]:[]});
  if(url.endsWith('/api/generate')){assert.equal(JSON.parse(init.body).keep_alive,0);loaded=false;return Response.json({done:true});}
  if(pause){pause=false;started();await gate;}
  return Response.json({capabilities:['tools'],model_info:{'general.architecture':'fixture','fixture.context_length':8192}});
 }});
 try{
  await host.listModels(true);pause=true;const refresh=host.listModels(true);await ready;
  await host.localModelChange('eject','ollama/old');release();
  assert.equal((await refresh).find(row=>row.key==='ollama/old').running,false);
  assert.equal((await host.listModels()).find(row=>row.key==='ollama/old').running,false);
 }finally{release();await host.workspaceSearch.shutdown();await fs.rm(directory,{recursive:true,force:true});}
});
test('the same model on a second Ollama daemon is released so only one copy remains resident',async()=>{
 const primary='http://127.0.0.1:11436',secondary='http://127.0.0.1:11434',active=new Set([primary,secondary]),ejected=[];
 const runtime={withLocalInference:fn=>fn(),colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>undefined};
 const lifecycle=createLocalModelLifecycle({runtime,fetcher:async(url,init)=>{const root=new URL(url).origin;if(init?.body){assert.equal(JSON.parse(init.body).keep_alive,0);active.delete(root);ejected.push(root);}return{ok:true,json:async()=>({models:active.has(root)?[{name:'same'}]:[]})};},
  catalog:async()=>[{key:'ollama/same',enabled:true,defaultContextWindow:8192}],endpoint:()=>primary+'/v1',context:()=>8192,assertIdle(){}});
 await lifecycle.change('mount','ollama/same');assert.deepEqual([...active],[primary]);assert.deepEqual(ejected,[secondary]);
});
test('local runtime IPC stays in the primary window and the preload patch upgrades existing builds',async()=>{
 const handlers=new Map(),calls=[];
 registerModelIpc({handle:(key,fn)=>handlers.set(key,fn)},{modelManager:{status:async()=>({}),allFallbacks:()=>({})},listModels:async()=>[],getDefaultModel:()=>null,getModelDiscoveryWarning:()=>null,localModelChange:async(action,key)=>{calls.push([action,key]);return{loaded:false};}});
 const sender={};sender.mainFrame={url:'notch-app://renderer/index.html?workbenchScope=primary'};
 const event={sender,senderFrame:sender.mainFrame};
 await assert.rejects(async()=>handlers.get('notch-models:runtime')(event,'delete','ollama/old'),/supported/);
 assert.throws(()=>handlers.get('notch-models:runtime')({sender,senderFrame:{url:sender.mainFrame.url}},'eject','ollama/old'),/primary/);
 assert.equal(patchModelPreload(modelPreload),modelPreload);
 const previous=modelPreload.replace("\n  runtime:(action,key)=>ipcRenderer.invoke('notch-models:runtime',action,key),",'');assert.equal(patchModelPreload(previous),modelPreload);
 assert.deepEqual(calls,[]);
});

test('a delayed mount reply cannot select a model that a later action already ejected',async()=>{
 const handlers=new Map();
 registerModelIpc({handle:(key,fn)=>handlers.set(key,fn)},{modelManager:{status:async()=>({}),allFallbacks:()=>({})},listModels:async()=>[{key:'colibri/coder',running:false}],getDefaultModel:()=>null,getModelDiscoveryWarning:()=>null,localModelChange:async()=>({loaded:true})});
 const sender={};sender.mainFrame={url:'notch-app://renderer/index.html'};
 const state=await handlers.get('notch-models:runtime')({sender,senderFrame:sender.mainFrame},'mount','colibri/coder');
 assert.equal(state.loaded,false);
});
test('the real desktop host rejects ejecting during a local response without losing its saved conversation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-active-eject-'));
 let release,started;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
 const host=createHost(directory,{hardware:async()=>({totalMemory:32*2**30,availableMemory:24*2**30,totalVram:0,availableVram:0}),
  fetcher:async url=>({ok:true,json:async()=>url.endsWith('/api/tags')?{models:[{name:'active',size:2**30}]}:url.endsWith('/api/ps')?{models:[]}:{capabilities:['tools'],model_info:{'general.architecture':'fixture','fixture.context_length':8192}}}),
  runTurn:async turn=>{started();await gate;return{messages:[...turn.messages,{role:'assistant',content:'Preserved reply'}],text:'Preserved reply',status:'completed'};}});
 try{
  await host.listModels(true);const query=host.query({cwd:directory,sessionId:'active-eject',model:'ollama/active',prompt:'Preserve this task'});
  const done=(async()=>{for await(const event of query)if(event.type==='result')assert(!event.is_error);})();await ready;
  await assert.rejects(host.localModelChange('eject','ollama/active'),/Finish or interrupt/);release();await done;
  const session=await host.loadSession('active-eject',directory);assert(session.messages.some(row=>row.role==='assistant'&&row.content==='Preserved reply'));
 }finally{release();await host.workspaceSearch.shutdown();await fs.rm(directory,{recursive:true,force:true});}
});
test('the Colibri and Strata management unload buttons use the same guarded eject path',async()=>{
 const handlers=new Map(),calls=[];
 const manager=Object.fromEntries(['colibri','strata'].map(provider=>[provider,async action=>{calls.push([provider,action]);return{running:false};}]));
 registerModelIpc({handle:(key,fn)=>handlers.set(key,fn)},{modelManager:manager,listModels:async()=>['colibri','strata'].map(provider=>({key:provider+'/coder',provider,running:true})),localModelChange:async(action,key)=>calls.push([action,key])});
 const sender={};sender.mainFrame={url:'notch-app://renderer/index.html'};const event={sender,senderFrame:sender.mainFrame};
 await handlers.get('notch-models:colibri')(event,'unload');await handlers.get('notch-models:strata')(event,'unload');
 assert.deepEqual(calls,[['eject','colibri/coder'],['colibri','catalog'],['eject','strata/coder'],['strata','catalog']]);
});
