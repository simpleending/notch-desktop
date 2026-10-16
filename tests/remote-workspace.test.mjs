import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteWorkspace } from '../src/remote-workspace.mjs';
import { CheckpointManager, runDesktopTurn } from '../vendor/notch-core/desktop-harness.js';

function fixture() {
  const files = new Map([['sample.txt', 'original\n']]), target = { host: { kind: 'ssh', id: 'test-host' }, mode: 'ssh-local-agent', workspace: { id: 'workspace', path: '/remote/project' } };
  const provider = {
    async stat() { return { isSymbolicLink: false }; },
    async readFile({path}) { if (!files.has(path)) throw Object.assign(new Error('missing'), {code:'workspace_provider_not_found'}); return {data:Buffer.from(files.get(path)).toString('base64')}; },
    async writeFile({path,data,precondition}) { assert.equal(precondition.kind,files.has(path)?'match':'absent'); if(files.has(path))assert.equal(Buffer.from(precondition.data,'base64').toString(),files.get(path));files.set(path,Buffer.from(data,'base64').toString()); },
    async execute({command}) { assert.match(command,/^stat/);return {exitCode:0,stdout:'1:99\n',stderr:''}; },
  };
  return {files,target,service:{async connectLocalAgent(){},getWorkspaceProvider(){return provider;}}};
}

test('SSH writes require a fresh read; persisted undo checks remote contents and survives restart',async t=>{
  const {files,target,service}=fixture(),remote=await createRemoteWorkspace(service,target);
  assert.equal((await remote.execute('write',{path:'sample.txt',content:'unsafe'})).isError,true);
  assert.match((await remote.execute('read',{path:'sample.txt'})).content,/original/);
  files.set('sample.txt','external edit');
  assert.equal((await remote.execute('edit',{path:'sample.txt',old_string:'original',new_string:'unsafe'})).isError,true);
  files.set('sample.txt','original\n');await remote.execute('read',{path:'sample.txt'});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-ssh-undo-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const history=path.join(directory,'undo.json');let undo=await CheckpointManager.open(target.workspace.path,history,remote.checkpointFiles);
  await undo.beginTurn('remote-turn');await undo.recordBefore('/remote/project/sample.txt');
  assert.equal((await remote.execute('edit',{path:'sample.txt',old_string:'original',new_string:'updated'})).isError,undefined);
  await undo.recordAfter();await undo.commit('SSH edit');
  undo=await CheckpointManager.open(target.workspace.path,history,remote.checkpointFiles);
  files.set('sample.txt','user changed this');await assert.rejects(undo.preview('remote-turn'),/changed since/);assert.equal(files.get('sample.txt'),'user changed this');
  files.set('sample.txt','updated\n');assert.equal((await undo.preview('remote-turn')).canRewind,true);await undo.undo('remote-turn');assert.equal(files.get('sample.txt'),'original\n');
  assert.equal((await remote.execute('read',{path:'../../outside'})).isError,true);
});

test('the real model tool loop validates remote calls and enforces read-only permissions before SSH execution',async t=>{
  const calls=[];let request=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body), first=request++===0;
    assert.deepEqual(body.tools.map(tool=>tool.function.name).filter(name=>name!=='notch_tool_error').sort(),['read','shell','write']);
    if(!first){assert.equal(calls.length,0);assert.match(body.messages.find(message=>message.role==='tool').content,/Permission denied/);}
    const delta=first?{tool_calls:[{index:0,id:'remote-write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'sample.txt',content:'bad'})}}]}:{content:'READ_ONLY_PRESERVED'};
    const chunk={id:'ssh-qa',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  });
  const result=await runDesktopTurn({cwd:'/remote/does-not-exist-locally',sessionId:'ssh-readonly',messages:[{role:'user',content:'Write sample.txt'}],model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',contextWindow:8192,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read','Write','Bash'],approve:async()=>false,remoteWorkspace:{leaseKey:'ssh-test:readonly',instructions:'Remote POSIX test workspace.',async execute(...args){calls.push(args);return {content:'unexpected'};}}});
  assert.equal(result.text,'READ_ONLY_PRESERVED');assert.equal(calls.length,0);
});

test('writable SSH turns use the remote lane and persisted Undo even with isolated cloud-workspace preferences',async t=>{
  const {files,target,service}=fixture(),remote=await createRemoteWorkspace(service,target);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-ssh-turn-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const checkpoints=await CheckpointManager.open(target.workspace.path,path.join(directory,'undo.json'),remote.checkpointFiles);await checkpoints.beginTurn('write-turn');
  let calls=0,approvals=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body),index=calls++;
    const call=index===0?{name:'read',arguments:{path:'sample.txt'}}:{name:'write',arguments:{path:'sample.txt',content:'remote turn updated\n'}};
    const delta=index<2?{tool_calls:[{index:0,id:'ssh-'+index,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{content:'REMOTE_TURN_DONE'};
    const chunk={id:'remote-write',model:body.model,choices:[{index:0,delta,finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:index<2?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  });
  const result=await runDesktopTurn({cwd:target.workspace.path,sessionId:'ssh-writable',messages:[{role:'user',content:'Read and update sample.txt'}],model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',contextWindow:8192,accessMode:'approve',workspaceMode:'isolated',signal:AbortSignal.timeout(15000),checkpoints,tools:['Read','Write'],approve:async()=>{approvals++;return true},remoteWorkspace:remote});
  assert.equal(result.text,'REMOTE_TURN_DONE');assert.equal(files.get('sample.txt'),'remote turn updated\n');assert.ok(approvals>0);
  await checkpoints.undo('write-turn');assert.equal(files.get('sample.txt'),'original\n');
});
