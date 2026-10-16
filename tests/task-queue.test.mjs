import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHost} from '../src/notch-host.mjs';
import {patchModelPreload,modelPreload} from '../src/model-ipc.mjs';
const until=async check=>{for(let i=0;i<500;i++){if(check())return;await delay(10);}throw new Error('Task queue timed out');};

test('real desktop provider queue isolates chats, cancels a waiter and leaves OpenRouter parallel',async()=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'notch-desktop-queue-')),previous=globalThis.fetch;
  const cloudKey='openrouter/openai/gpt-4.1',localKey='ollama/queue-fixture';
  let releaseLocal,releaseCloud;const localGate=new Promise(resolve=>{releaseLocal=resolve;}),cloudGate=new Promise(resolve=>{releaseCloud=resolve;});
  const calls=[];let cloudActive=0,cloudPeak=0;
  globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(init.body),prompt=body.messages.filter(row=>row.role==='user').at(-1).content;calls.push({url:String(url),prompt});
    if(String(url).endsWith('/api/chat')){
      if(prompt==='first-local')await localGate;
      return new Response(JSON.stringify({message:{role:'assistant',content:'reply:'+prompt},done:true,prompt_eval_count:100,eval_count:5})+'\n');
    }
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    cloudActive++;cloudPeak=Math.max(cloudPeak,cloudActive);await cloudGate;cloudActive--;
    const frame=(delta,finish_reason=null)=>({id:'fixture',choices:[{index:0,delta,finish_reason}]});
    return new Response(`data: ${JSON.stringify(frame({content:'reply:'+prompt}))}\n\ndata: ${JSON.stringify(frame({},'stop'))}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  const host=createHost(cwd,{hardware:async()=>({totalMemory:32*2**30,availableMemory:24*2**30,totalVram:24*2**30,availableVram:20*2**30}),fetcher:async url=>{
    if(url.startsWith('http://127.0.0.1:11436'))throw new Error('No managed daemon');
    return {ok:true,json:async()=>url.endsWith('/api/tags')?{models:[{name:'queue-fixture',size:2**30}]}:url.endsWith('/api/ps')?{models:[]}:{capabilities:['tools'],model_info:{'general.architecture':'fixture','fixture.context_length':8192,'fixture.block_count':16,'fixture.attention.head_count_kv':4,'fixture.attention.key_length':128,'fixture.attention.value_length':128}}};
  }});
  host.modelManager={status:async()=>({}),mlxModels:async()=>[],cloudCatalog:async()=>[{key:cloudKey,provider:'openrouter',enabled:true,defaultContextWindow:8192,maxInputTokens:8192,maxOutputTokens:1024}],key:async()=>'fixture-only',context:()=>8192,requestedContext:()=>undefined};
  const tasks=[];
  const start=(sessionId,prompt,model=localKey)=>{const query=host.query({cwd,sessionId,prompt,model,permissionMode:'read-only',tools:['Read']}),events=[];const done=(async()=>{for await(const event of query)events.push(event);return events;})();tasks.push({query,done});return {query,done,events};};
  try{
    await host.listModels(true);
    const first=start('local-first','first-local');await until(()=>calls.length===1);
    const cancelled=start('local-cancelled','cancelled-local');await until(()=>host.getQueueStatus().some(row=>row.sessionId==='local-cancelled'));
    assert.equal(calls.length,1);await cancelled.query.interrupt();await cancelled.done;
    assert.equal(cancelled.events.at(-1).terminal_reason,'user_interrupted');assert.equal(host.getQueueStatus().length,0);
    const second=start('local-second','second-local');await until(()=>host.getQueueStatus().length===1);
    const cloudA=start('cloud-a','cloud-a',cloudKey),cloudB=start('cloud-b','cloud-b',cloudKey);
    await until(()=>cloudPeak===2);assert.equal(calls.filter(row=>row.url.endsWith('/api/chat')).length,1);
    releaseCloud();await Promise.all([cloudA.done,cloudB.done]);releaseLocal();await Promise.all([first.done,second.done]);
    for(const [task,prompt] of [[first,'first-local'],[second,'second-local'],[cloudA,'cloud-a'],[cloudB,'cloud-b']]){
      const result=task.events.at(-1);assert.equal(result.is_error,false,result.errors?.join('\n'));assert.equal(result.result,'reply:'+prompt);
      const stored=await host.loadSession(task.query.id,cwd);assert.deepEqual(stored.messages.filter(row=>row.role==='user').map(row=>row.content),[prompt]);
    }
    assert.equal(calls.some(row=>row.prompt==='cancelled-local'),false);assert.deepEqual(host.getQueueStatus(),[]);assert.equal(cloudPeak,2);
  }finally{releaseLocal();releaseCloud();await Promise.all(tasks.map(async task=>{await task.query.close();await task.done;}));globalThis.fetch=previous;await host.workspaceSearch.shutdown();}
});

test('the queue status bridge is added to existing preload bundles exactly once',()=>{
  const previous=modelPreload.replace(",\n  queue:()=>ipcRenderer.invoke('notch-models:queue')",'');
  const patched=patchModelPreload(previous);assert.match(patched,/notch-models:queue/);assert.equal(patchModelPreload(patched),patched);
});

