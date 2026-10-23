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
  runtime['start'+name]=async()=>{assert.equal(loaded.size,0,'Old engine must stop before another loads.');calls.push('load '+provider);loaded.set(provider+'/'+(provider==='mlx'?'lab/coder':'coder'),true);};
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
 return{loaded,calls,lifecycle,set busy(value){busy=value;},set failLoad(value){failLoad=value;},set failEject(value){failEject=value;}};
}
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
