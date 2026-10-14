import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/notch-host.mjs';
import { createModelManager } from '../src/model-manager.mjs';
const GiB=2**30;
const metadata={capabilities:['tools'],model_info:{'general.architecture':'test','test.block_count':32,'test.attention.head_count_kv':4,'test.attention.key_length':128,'test.attention.value_length':128,'test.context_length':262144}};

test('local turns refresh memory before loading, retain manual preferences and report the actual context',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-context-host-'));
  let memory={totalMemory:24*GiB,availableMemory:14*GiB,totalVram:24*GiB,availableVram:24*GiB};
  const refreshes=[],contexts=[];
  const host=createHost(directory,{hardware:async fresh=>{refreshes.push(fresh);return memory;},
    fetcher:async url=>({ok:true,json:async()=>url.endsWith('/api/tags')?{models:[{name:'fixture',size:3*GiB,digest:'fixture'}]}:url.endsWith('/api/ps')?{models:[]}:metadata}),
    runTurn:async turn=>{assert.equal(turn.nativeContextWindow,262144);contexts.push(turn.contextWindow);turn.onUsage({inputTokens:100,outputTokens:10,contextWindow:turn.contextWindow});return {messages:turn.messages,text:'OK',status:'completed'};}});
  host.modelManager=createModelManager(directory);
  const key='ollama/fixture';
  try {
    assert.equal((await host.listModels(true)).find(row=>row.key===key).defaultContextWindow,131072);
    memory={...memory,availableMemory:2*GiB,availableVram:8*GiB};
    const automatic=host.query({cwd:directory,prompt:'Hello',model:key});
    let result;for await(const event of automatic)if(event.type==='result')result=event;
    assert.equal(result.is_error,false,result.errors?.join('\n'));
    assert.deepEqual(contexts,[16384]);assert.equal((await automatic.getContextUsage()).maxTokens,16384);
    memory={...memory,availableMemory:14*GiB,availableVram:24*GiB};
    await host.modelManager.setContext(key,262144,await host.listModels(true));
    memory={...memory,availableMemory:2*GiB,availableVram:8*GiB};
    const manual=host.query({cwd:directory,prompt:'Hello again',model:key});
    for await(const event of manual)if(event.type==='result')result=event;
    assert.equal(result.is_error,false,result.errors?.join('\n'));
    assert.deepEqual(contexts,[16384,32768]);assert.equal((await manual.getContextUsage()).maxTokens,32768);
    assert.equal(host.modelManager.requestedContext(key),262144);
    memory={...memory,availableMemory:14*GiB,availableVram:24*GiB};
    assert.equal((await host.listModels(true)).find(row=>row.key===key).defaultContextWindow,262144);
    memory={...memory,availableMemory:2*GiB,availableVram:0};
    const blocked=host.query({cwd:directory,prompt:'Hello once more',model:key});
    for await(const event of blocked)if(event.type==='result')result=event;
    assert.equal(result.is_error,true);assert.match(result.errors.join('\n'),/memory/);
    assert.deepEqual(contexts,[16384,32768]);assert.ok(refreshes.every(fresh=>fresh===true));
  } finally { await host.workspaceSearch.shutdown(); }
});
