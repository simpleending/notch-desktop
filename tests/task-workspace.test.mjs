import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHost } from '../src/notch-host.mjs';
const exec = promisify(execFile);
const until = async check => { for (let i=0;i<1000;i++) { if (check()) return; await new Promise(resolve=>setTimeout(resolve,10)); } throw new Error('Workspace test timed out'); };

test('parallel desktop cloud tasks isolate shell files, deliver native changes, preserve conflicts and support Undo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-desktop-worktrees-')), cwd = path.join(root,'project');
  await fs.mkdir(cwd); await fs.writeFile(path.join(cwd,'shared.txt'),'original');
  await fs.writeFile(path.join(cwd,'worker.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('shared.txt',process.argv[2]);writeFileSync(process.argv[2]+'.txt','new');");
  await exec('git',['init'],{cwd,windowsHide:true});
  await exec('git',['add','.'],{cwd,windowsHide:true});
  await exec('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','Initial'],{cwd,windowsHide:true});
  const previousFetch = globalThis.fetch, previousHome=process.env.HOME, previousProfile=process.env.USERPROFILE;
  process.env.HOME=root; process.env.USERPROFILE=root;
  const gates = new Map(), entered = [], hookEvents = [], paths = new Map(); let active=0,peak=0;
  const cloud='openrouter/fixture/chat';
  const host=createHost(path.join(root,'profile'));
  host.listModels=async()=>[{key:cloud,enabled:true}]; host.resolveModelChoice=()=>cloud;
  host.modelManager={cloudCatalog:async()=>[{key:cloud,enabled:true,maxInputTokens:16384,maxOutputTokens:2048,defaultContextWindow:16384}],key:async()=>'fixture-only',context:()=>16384,requestedContext:()=>undefined};
  const sourceEvents = (event) => async input => { hookEvents.push({event,input}); if (event==='pre') assert.equal(await fs.readFile(path.join(cwd,'shared.txt'),'utf8'),'original'); };
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    const body=JSON.parse(init.body), label=body.messages.find(row=>row.role==='user').content;
    const results=body.messages.filter(row=>row.role==='tool');
    assert.ok(!body.tools.some(row=>row.function.name.startsWith('mcp__')));
    let delta,finish;
    if(!results.length){
      active++; peak=Math.max(peak,active); entered.push(label);
      await new Promise(resolve=>gates.set('start-'+label,resolve)); active--;
      delta={tool_calls:[{index:0,id:'shell-'+label,type:'function',function:{name:'shell',arguments:JSON.stringify({command:'node worker.mjs '+label})}}]};finish='tool_calls';
    }else{
      assert.match(results.at(-1).content,/no output/);
      await new Promise(resolve=>gates.set('finish-'+label,resolve));
      delta={content:'Finished '+label};finish='stop';
    }
    const frame=(value,reason=null)=>({id:'fixture',choices:[{index:0,delta:value,finish_reason:reason}]});
    return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({},finish))}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const tasks=[];
  const start=label=>{
    const query=host.query({cwd,sessionId:'workspace-'+label,prompt:label,model:cloud,permissionMode:'full-access',tools:['Bash'],
      hooks:{PreToolUse:[{hooks:[sourceEvents('pre')]}],PostToolUse:[{hooks:[sourceEvents('post')]}]}});
    const events=[]; const done=(async()=>{for await(const event of query)events.push(event);return events;})();
    const task={query,events,done};tasks.push(task);return task;
  };
  // Capture the actual core's task paths through its journal, without changing its execution.
  const journal=host.journal; host.journal=async(id,event)=>{if(event.isolatedWorkspace&&event.cwd)paths.set(id,event.cwd);return journal(id,event);};
  try {
    const a=start('A'),b=start('B');await until(()=>entered.length===2);assert.equal(peak,2);
    gates.get('start-A')();gates.get('start-B')();await until(()=>gates.has('finish-A')&&gates.has('finish-B'));
    assert.equal(await fs.readFile(path.join(cwd,'shared.txt'),'utf8'),'original');
    assert.notEqual(paths.get('workspace-A'),paths.get('workspace-B'));
    assert.equal(await fs.readFile(path.join(paths.get('workspace-A'),'shared.txt'),'utf8'),'A');
    assert.equal(await fs.readFile(path.join(paths.get('workspace-B'),'shared.txt'),'utf8'),'B');
    gates.get('finish-A')();await a.done;assert.equal(a.events.at(-1).is_error,false,a.events.at(-1).errors?.join('\n'));
    gates.get('finish-B')();await b.done;assert.equal(b.events.at(-1).is_error,false,b.events.at(-1).errors?.join('\n'));
    assert.match(b.events.at(-1).result,/saved separately/);
    assert.equal(await fs.readFile(path.join(cwd,'shared.txt'),'utf8'),'A');
    await assert.rejects(fs.access(path.join(cwd,'B.txt')));
    assert.ok(hookEvents.length>=4);assert.ok(hookEvents.every(row=>path.isAbsolute(row.input.tool_input.file_path)&&row.input.tool_input.file_path.startsWith(cwd)));
    const stored=await host.loadSession('workspace-B',cwd);assert.ok(stored.messages.some(row=>String(row.content).includes('Task delivery status')));
    const manager=await host.openCheckpoints('workspace-A',cwd);await manager.undo();
    assert.equal(await fs.readFile(path.join(cwd,'shared.txt'),'utf8'),'original');await assert.rejects(fs.access(path.join(cwd,'A.txt')));
    assert.equal(await fs.readFile(path.join(paths.get('workspace-B'),'shared.txt'),'utf8'),'B');
  } finally {
    for(const release of gates.values())release();await Promise.all(tasks.map(async task=>{await task.query.close();await task.done;}));
    globalThis.fetch=previousFetch;
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previousProfile;
    await host.workspaceSearch.shutdown();
  }
});
