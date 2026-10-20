import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHost} from '../src/notch-host.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-ide-reliability-')),cwd=path.join(directory,'project');await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd,'verify-check.mjs'),"import{existsSync,readFileSync,writeFileSync}from'node:fs';const n=existsSync('attempts.txt')?Number(readFileSync('attempts.txt','utf8')):0;writeFileSync('attempts.txt',String(n+1));if(!existsSync('pass.flag')){console.error('CHECK_FAILED');process.exit(1)}console.log('CHECK_PASSED');");
  let steps,round;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');const body=JSON.parse(init.body),step=steps[Math.min(round++,steps.length-1)];
    const delta=typeof step==='string'?{content:step}:{tool_calls:step.map((call,index)=>({index,id:`call-${round}-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))};
    const frame=(delta,reason=null)=>({id:'fixture',model:body.model,choices:[{index:0,delta,finish_reason:reason}]});
    return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({},typeof step==='string'?'stop':'tool_calls'))}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  });
  async function host(){
    const host=createHost(directory,{hardware:async()=>({totalMemory:16*2**30,availableMemory:8*2**30}),fetcher:async()=>Response.json({models:[]})});
    host.modelManager={status:async()=>({openrouter:true}),key:async()=> 'fixture-only',fallbacks:()=>[],mlxModels:async()=>[],getWorkspaceMode:async()=> 'shared',
      context:(_model,_choices,fallback)=>fallback,cloudCatalog:async()=>[{key:'openrouter/lab/coder',enabled:true,defaultContextWindow:32768,maxInputTokens:32768,maxOutputTokens:4000,availableContextWindows:[32768]}]};
    await host.listModels(true);return host;
  }
  async function run(sequence,sessionId='reliability'){
    steps=sequence;round=0;const current=await host(),events=[];
    for await(const event of current.query({cwd,sessionId,model:'openrouter/lab/coder',prompt:'Perform the work and verify it.',permissionMode:'bypassPermissions',tools:['Bash','Read','Write'],maxTurns:8}))events.push(event);
    return {events,result:events.at(-1)};
  }
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {cwd,run};
}
const check={name:'shell',args:{command:'node verify-check.mjs'}};
test('native IDE failures survive host restart, suppress false success, and clear only after an actual passing rerun',async t=>{
  const {cwd,run}=await fixture(t);
  for(const sequence of [[[check],'ALL_TESTS_PASSED_UNTRUTH'],['ALL_TESTS_PASSED_UNTRUTH']]){
    const {events,result}=await run(sequence);assert.equal(result.subtype,'error_during_execution');assert.equal(result.is_error,true);
    assert.match(result.result,/Checks have not passed/);assert.doesNotMatch(JSON.stringify(events),/ALL_TESTS_PASSED_UNTRUTH/);
  }
  const recovered=await run([[{name:'read',args:{path:'pass.flag'}},{name:'write',args:{path:'pass.flag',content:'fixed'}},check],'Verified successfully.']);
  assert.equal(recovered.result.subtype,'success');assert.equal(await fs.readFile(path.join(cwd,'attempts.txt'),'utf8'),'2');
});
test('native IDE duplicate calls are skipped and unchanged failed retries stop after two executions',async t=>{
  const {cwd,run}=await fixture(t),{result}=await run([[check,check],[check],[check]]);
  assert.equal(result.is_error,true);assert.match(result.result,/Stopped retrying/);assert.equal(await fs.readFile(path.join(cwd,'attempts.txt'),'utf8'),'2');
});
