import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createQuietOllama} from '../src/quiet-ollama.mjs';

async function fixture(t,rows,models=[]) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-quiet-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'bundled.exe');await fs.writeFile(source,'trusted helper');
  const calls=[],requests=[];let held=false;
  const quiet=await createQuietOllama({root,source,run:async(_exe,args,options)=>{
    assert.equal(options.windowsHide,true);const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
    calls.push(script.includes('Stop-Process')?'stop':'owner');
    if(script.includes('Stop-Process')){assert(held,'Migration must own the inference lease');assert.equal(options.env.NOTCH_QUIET_PID,'2147483646');return{stdout:''};}
    return{stdout:JSON.stringify(rows.shift()??null)};
  },fetcher:async(url,options)=>{requests.push({url,options});return Response.json(url.endsWith('/ps')?{models}:{done:true});}});
  const migrate=(start=async()=>calls.push('start'),signal)=>quiet.migrate({start,signal,withManagedOllamaStart:fn=>fn(),withLocalInference:async fn=>{calls.push('lease');held=true;try{return await fn();}finally{held=false;calls.push('release');}}});
  const legacy={pid:2147483646,executable:path.join(root,'v0.40.3/ollama.exe'),command:'"ollama.exe" serve',created:'identity',parent:'old.exe'};
  return{root,source,quiet,calls,requests,migrate,legacy,rows};
}

test('hidden host is cached by verified content outside installed program files',async t=>{
  const f=await fixture(t,[]),digest=createHash('sha256').update('trusted helper').digest('hex');
  assert.equal(path.basename(f.quiet.helper),`notch-console-${digest}.exe`);
  assert.deepEqual(await fs.readFile(f.quiet.helper),await fs.readFile(f.source));
  await fs.writeFile(f.quiet.helper,'corrupted');
  const repaired=await createQuietOllama({root:f.root,source:f.source});
  assert.deepEqual(await fs.readFile(repaired.helper),await fs.readFile(f.source));
  await f.migrate();assert.deepEqual(f.calls,['owner']);
});

test('migration leaves external runtimes, non-server processes and existing hidden hosts alone',async t=>{
  for(const change of [{executable:'C:/other/ollama.exe'},{command:'ollama.exe run model'},{parent:'quiet'}]){
    const f=await fixture(t,[]);let row={...f.legacy,...change};
    if(change.parent==='quiet')row.parent=f.quiet.helper;
    f.rows.push(row);await f.migrate();assert.deepEqual(f.calls,['owner']);assert.deepEqual(f.requests,[]);
  }
});

test('legacy migration waits for inference, rechecks ownership and restores loaded context without prompts',async t=>{
  const f=await fixture(t,[],[{name:'already-downloaded',context_length:8192}]);
  f.rows.push(f.legacy,f.legacy);await f.migrate();
  assert.deepEqual(f.calls,['owner','lease','owner','stop','start','release']);
  const body=JSON.parse(f.requests[1].options.body);
  assert.deepEqual(body,{model:'already-downloaded',stream:false,keep_alive:'5m',options:{num_ctx:8192,num_batch:128}});
  assert.equal(f.requests[1].url,'http://127.0.0.1:11436/api/generate');
});

test('another process completing migration while queued is reused without a second restart',async t=>{
  const f=await fixture(t,[]);f.rows.push(f.legacy,{...f.legacy,parent:f.quiet.helper});await f.migrate();
  assert.deepEqual(f.calls,['owner','lease','owner','release']);assert.deepEqual(f.requests,[]);
});

test('cancelled migration never terminates the old daemon; failed starts release the lease and can retry',async t=>{
  const f=await fixture(t,[]);const controller=new AbortController();controller.abort();f.rows.push(f.legacy);
  await assert.rejects(f.migrate(undefined,controller.signal),{name:'AbortError'});assert(!f.calls.includes('stop'));
  f.rows.push(f.legacy,f.legacy);await assert.rejects(f.migrate(async()=>{throw Error('Startup failed');}),/Startup failed/);
  assert.equal(f.calls.at(-1),'release');
  f.rows.push(f.legacy,f.legacy);await f.migrate();assert.equal(f.calls.at(-2),'start');
});
