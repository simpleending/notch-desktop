import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHost} from '../src/notch-host.mjs';
const roots=['http://127.0.0.1:11436','http://127.0.0.1:11434'],GiB=2**30;
const metadata={capabilities:['tools'],model_info:{'general.architecture':'test','test.context_length':131072}};
const row=name=>({name,size:GiB,digest:name});
async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-discovery-')),states=new Map([[roots[0],[row('alpha')]],[roots[1],[]]]),runs=[];let show=metadata,tags=0;
  const host=createHost(directory,{hardware:async()=>({totalMemory:32*GiB,availableMemory:24*GiB,totalVram:16*GiB,availableVram:16*GiB}),fetcher:async url=>{
    let value;if(url.endsWith('/api/tags')){tags++;value=states.get(new URL(url).origin);value=typeof value==='function'?await value():value;if(value instanceof Error)throw value;value={models:value};}
    else value=url.endsWith('/api/ps')?{models:[]}:typeof show==='function'?await show():show;
    return {ok:true,json:async()=>value};
  },runTurn:async turn=>{runs.push({model:turn.model,baseUrl:turn.baseUrl,context:turn.contextWindow});return {messages:turn.messages,text:'OK',status:'completed'};}});
  return {host,states,runs,directory,setShow:value=>{show=value;},tags:()=>tags};
}
async function turn(f,model){let result;for await(const event of f.host.query({cwd:f.directory,prompt:'Hello',model}))if(event.type==='result')result=event;return result;}

test('failed discovery preserves selection, blocks unverified local turns and retries without caching an outage',async()=>{
  const f=await fixture();try{
    await f.host.listModels(true);const chosen=f.host.getDefaultModel();
    for(const root of roots)f.states.set(root,Error('connection timed out'));
    const cached=await f.host.listModels(true);assert.ok(cached.some(row=>row.key===chosen&&row.enabled));assert.equal(f.host.getDefaultModel(),chosen);assert.match(f.host.getModelDiscoveryWarning(),/cached/);
    f.states.set(roots[0],{malformed:true});assert.ok((await f.host.listModels(true)).some(row=>row.key===chosen));
    const failed=await turn(f,chosen);assert.equal(failed.is_error,true);assert.match(failed.errors.join('\n'),/verify the local model/);assert.deepEqual(f.runs,[]);
    const before=f.tags();f.states.set(roots[0],[row('alpha')]);f.states.set(roots[1],[]);await f.host.listModels();assert.ok(f.tags()>before);assert.equal(f.host.getModelDiscoveryWarning(),undefined);
    assert.equal((await turn(f,chosen)).is_error,false);assert.equal(f.runs[0].baseUrl,roots[0]+'/v1');
  }finally{await f.host.workspaceSearch.shutdown();}
});

test('a successfully verified empty inventory removes old models',async()=>{
  const f=await fixture();try{await f.host.listModels(true);f.states.set(roots[0],[]);assert.deepEqual(await f.host.listModels(true),[]);assert.equal(f.host.getDefaultModel(),undefined);assert.equal(f.host.getModelDiscoveryWarning(),undefined);assert.throws(()=>f.host.resolveModelChoice('ollama/alpha'),/unavailable/);}
  finally{await f.host.workspaceSearch.shutdown();}
});

test('a healthy endpoint overrides a cached duplicate while failed-endpoint models remain visibly cached',async()=>{
  const f=await fixture();try{
    f.states.set(roots[0],[row('shared'),row('only-first')]);f.states.set(roots[1],[row('shared')]);await f.host.listModels(true);
    f.states.set(roots[0],Error('offline'));const rows=await f.host.listModels(true);assert.equal(rows.filter(row=>row.key==='ollama/shared').length,1);assert.ok(rows.some(row=>row.key==='ollama/only-first'));
    assert.equal((await turn(f,'ollama/shared')).is_error,false);assert.equal(f.runs[0].baseUrl,roots[1]+'/v1');assert.equal((await turn(f,'ollama/only-first')).is_error,true);assert.equal(f.runs.length,1);
    f.states.set(roots[0],[]);assert.ok(!(await f.host.listModels(true)).some(row=>row.key==='ollama/only-first'));
  }finally{await f.host.workspaceSearch.shutdown();}
});

test('refresh commits maps atomically and an Ollama outage does not block cloud models',async()=>{
  const f=await fixture(),cloud={key:'openrouter/fixture',provider:'openrouter',enabled:true,defaultContextWindow:32768,maxInputTokens:131072,maxOutputTokens:4096,availableContextWindows:[32768]};
  f.host.modelManager={status:async()=>({}),context:(_key,_choices,fallback)=>fallback,requestedContext:()=>undefined,mlxModels:async()=>[],cloudCatalog:async()=>[cloud],key:async()=> 'fixture-key'};
  try{
    await f.host.listModels(true);const snapshot=f.host.getCachedModels();let release,mark;const started=new Promise(resolve=>{mark=resolve;});f.setShow(()=>{mark();return new Promise(resolve=>{release=resolve;});});
    const refreshing=f.host.listModels(true);await started;assert.equal(f.host.getCachedModels(),snapshot);
    assert.equal((await turn(f,cloud.key)).is_error,false);assert.equal(f.runs[0].context,32768);release(metadata);await refreshing;f.setShow(metadata);
    for(const root of roots)f.states.set(root,Error('offline'));await f.host.listModels(true);assert.match(f.host.getModelDiscoveryWarning(),/cached/);
    assert.equal((await turn(f,cloud.key)).is_error,false);assert.equal(f.runs[1].context,32768);
  }finally{await f.host.workspaceSearch.shutdown();}
});
