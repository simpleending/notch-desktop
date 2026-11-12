import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalModelLifecycle} from '../src/local-model-lifecycle.mjs';
import {runDesktopTurn,CheckpointManager} from '../vendor/notch-core/desktop-harness.js';

test('manual mounts persist across lifecycle recreation, refresh existing loads, and clear on eject',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'notch-pinned-'));const preferenceFile=path.join(dir,'mounts.json');
 let loaded=false,fail=false;const requests=[];
 const config={preferenceFile,runtime:{withLocalInference:fn=>fn(),colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>undefined},
  catalog:async()=>[{key:'ollama/fixture',enabled:true}],endpoint:()=> 'http://127.0.0.1:11436',context:()=>16384,assertIdle(){},
  fetcher:async(url,init)=>{if(url.includes(':11434'))throw Error('offline');if(init?.body){const body=JSON.parse(init.body);requests.push(body);if(fail)return{ok:false,status:500};loaded=body.keep_alive!==0;}return Response.json({models:loaded?[{name:'fixture'}]:[]});}};
 let lifecycle=createLocalModelLifecycle(config);
 assert.equal(await lifecycle.keepAlive('ollama/fixture'),undefined);
 await lifecycle.change('mount','ollama/fixture');assert.equal(requests.at(-1).keep_alive,-1);
 lifecycle=createLocalModelLifecycle(config);assert.equal(await lifecycle.keepAlive('ollama/fixture'),-1);
 await lifecycle.change('mount','ollama/fixture');assert.equal(requests.at(-1).keep_alive,-1);
 fail=true;await assert.rejects(lifecycle.change('eject','ollama/fixture'));assert.equal(await lifecycle.keepAlive('ollama/fixture'),-1);
 fail=false;await lifecycle.change('eject','ollama/fixture');assert.equal(loaded,false);assert.equal(requests.at(-1).keep_alive,0);
 assert.equal(await createLocalModelLifecycle(config).keepAlive('ollama/fixture'),undefined);assert.deepEqual(JSON.parse(await readFile(preferenceFile,'utf8')),[]);
 fail=true;await assert.rejects(lifecycle.change('mount','ollama/fixture'));assert.equal(await lifecycle.keepAlive('ollama/fixture'),undefined);
});

test('manual pin is carried through normal chat and compaction requests; automatic loads retain daemon policy',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-pin-chat-')),bodies=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{const body=JSON.parse(init.body);bodies.push(body);const frame={message:{role:'assistant',content:body.stream?'HELLO':'Summary of completed work.'},done:true,done_reason:'stop'};return body.stream?new Response(JSON.stringify(frame)+'\n'):Response.json(frame);});
 const turn={cwd,sessionId:'pin',model:'ollama/fixture',baseUrl:'http://127.0.0.1:18888',contextWindow:8192,maxOutputTokens:512,tools:[],accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),approve:async()=>false};
 await runDesktopTurn({...turn,messages:[{role:'user',content:'Hello'}]});assert.equal(bodies[0].keep_alive,undefined);bodies.length=0;
 const messages=[{role:'user',content:'Preserve this task.'}];for(let i=0;i<24;i++)messages.push({role:'user',content:'Completed work '+i},{role:'assistant',content:'Earlier context. '.repeat(180)});messages.push({role:'user',content:'Continue.'});
 assert.equal((await runDesktopTurn({...turn,ollamaKeepAlive:-1,messages})).text,'HELLO');
 assert(bodies.some(body=>!body.stream),'Compaction must use the same pin.');assert(bodies.every(body=>body.keep_alive===-1));
});
