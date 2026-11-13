import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalModelLifecycle} from '../src/local-model-lifecycle.mjs';
import {createHost} from '../src/notch-host.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
function fixture(){
 const models=new Map([['a','http://127.0.0.1:11436'],['b','http://127.0.0.1:11436'],['c','http://127.0.0.1:11434']]),calls=[];
 let fail=false;
 const engines=new Set(['colibri','strata','mlx']);
 const runtime={withLocalInference:fn=>fn(),colibriStatus:async()=>({running:engines.has('colibri')}),strataStatus:async()=>({running:engines.has('strata')}),loadedMlxModel:()=>engines.has('mlx')?'fixture':undefined,stopColibri:async()=>{calls.push('colibri');engines.delete('colibri');},stopStrata:async()=>{calls.push('strata');engines.delete('strata');},stopMlx:async()=>{calls.push('mlx');engines.delete('mlx');}};
 const fetcher=async(url,init)=>{const root=new URL(url).origin;if(init?.body){const body=JSON.parse(init.body);assert.equal(body.keep_alive,0);calls.push(body.model);if(fail&&body.model==='a')return{ok:false,status:500};models.delete(body.model);}return Response.json({models:[...models].filter(([,origin])=>origin===root).map(([name])=>({name}))});};
 return{models,calls,runtime,fetcher,set fail(value){fail=value;}};
}
test('shutdown unloads every local engine, clears manual pins, and rejects new mounts',async()=>{
 const f=fixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-model-stop-')),preferenceFile=path.join(directory,'pins.json');await fs.writeFile(preferenceFile,JSON.stringify(['ollama/a','ollama/b']));
 const lifecycle=createLocalModelLifecycle({...f,preferenceFile});await lifecycle.releaseAll();assert.equal(f.models.size,0);assert.deepEqual(new Set(f.calls),new Set(['a','b','c','mlx','colibri','strata']));assert.deepEqual(JSON.parse(await fs.readFile(preferenceFile)),[]);assert.throws(()=>lifecycle.change('mount','ollama/a'),/shutting down/);
});
test('one unload failure does not skip other models and is reported',async()=>{
 const f=fixture();f.fail=true;const lifecycle=createLocalModelLifecycle(f);await assert.rejects(lifecycle.releaseAll(),/could not be unloaded/);assert.deepEqual([...f.models.keys()],['a']);assert(f.calls.includes('strata')&&f.calls.includes('mlx')&&f.calls.includes('colibri'));
});
test('tray cleanup is reusable and concurrent shutdown calls share the operation',async()=>{
 const f=fixture(),lifecycle=createLocalModelLifecycle(f);const first=lifecycle.releaseAll(false),second=lifecycle.releaseAll(false);assert.equal(first,second);await first;assert.equal(lifecycle.busy,false);await lifecycle.prepare('ollama/a');
});
test('host shutdown joins model and voice cleanup once',async()=>{
 const f=fixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-host-stop-'));let voiceStopped=0;
 const host=createHost(directory,{runtime:f.runtime,fetcher:f.fetcher});host.voice={shutdown:async()=>{voiceStopped++;}};
 await host.shutdownLocalModels();assert.equal(f.models.size,0);assert.equal(voiceStopped,1);await host.shutdownLocalModels();assert.equal(voiceStopped,1);await host.workspaceSearch.shutdown();
});

test('shutdown aborts an in-progress manual mount before final unloading',async()=>{
 const f=fixture();f.models.clear();await f.runtime.stopColibri();await f.runtime.stopStrata();await f.runtime.stopMlx();let began;const started=new Promise(resolve=>began=resolve);
 const fetcher=async(url,init)=>{if(init?.body&&JSON.parse(init.body).keep_alive===-1){began();return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});}return f.fetcher(url,init);};
 const lifecycle=createLocalModelLifecycle({...f,fetcher,catalog:async()=>[{key:'ollama/a',enabled:true}],endpoint:()=> 'http://127.0.0.1:11436',context:()=>8192,assertIdle(){}});
 const pending=lifecycle.change('mount','ollama/a'),rejected=assert.rejects(pending,/closing/);await started;await lifecycle.releaseAll();await rejected;assert.equal(f.models.size,0);
});

test('absent engines do not launch their missing stop utilities',async()=>{
 const f=fixture();f.models.clear();const runtime={...f.runtime,colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>undefined,stopColibri:async()=>{throw Error('Missing runtime');},stopStrata:async()=>{throw Error('Missing runtime');},stopMlx:async()=>{throw Error('Missing runtime');}};
 await createLocalModelLifecycle({...f,runtime}).releaseAll();
});

test('a lost unload acknowledgement succeeds only when the daemon confirms the model is gone',async()=>{
 const f=fixture();const fetcher=async(url,init)=>{if(init?.body){const name=JSON.parse(init.body).model;f.models.delete(name);throw new DOMException('Late acknowledgement','TimeoutError');}return f.fetcher(url,init);};
 await createLocalModelLifecycle({...f,fetcher}).releaseAll();assert.equal(f.models.size,0);
});
