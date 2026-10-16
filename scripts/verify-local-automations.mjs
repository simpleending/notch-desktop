import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { processSnapshot, stopOwnedProcesses } from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'release/real-local-automations.json');
const modelName=process.argv[4]||'notch-hf-abd14067e8d7:latest',model='ollama/'+modelName,base='http://127.0.0.1:11436';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-real-automations-')),profile=path.join(root,'profile'),cwd=path.join(root,'project');
await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,'queue.txt'),'start\n');
await fs.writeFile(path.join(cwd,'task-a.mjs'),"import fs from'node:fs';import assert from'node:assert/strict';assert.equal(fs.readFileSync('queue.txt','utf8'),'start\\n');fs.writeFileSync('a-started.json',JSON.stringify({at:Date.now()}));await new Promise(r=>setTimeout(r,10000));fs.appendFileSync('queue.txt','A\\n');fs.writeFileSync('a-finished.json',JSON.stringify({at:Date.now()}));console.log('QUEUE_A_OK');\n");
await fs.writeFile(path.join(cwd,'task-b.mjs'),"import fs from'node:fs';import assert from'node:assert/strict';assert.equal(fs.readFileSync('queue.txt','utf8'),'start\\nA\\n');fs.appendFileSync('queue.txt','B\\n');fs.writeFileSync('b-finished.json',JSON.stringify({at:Date.now()}));console.log('QUEUE_B_OK');\n");
await fs.writeFile(path.join(cwd,'recurring.mjs'),"import fs from'node:fs';fs.appendFileSync('ticks.txt','tick\\n');console.log('RECURRING_TICK_OK');\n");
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_OLLAMA_CONTEXT:'8192',NOTCH_OLLAMA_THINK:'0',NOTCH_AUTO_DREAM:'0',NOTCH_AUTO_UPDATE:'0'};
const checks=[],errors=[],traces=[];let app,page,passed=false,failure,modelLoaded,unloaded=false;const tasks=[];
const until=async(check,label,timeout=240000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Timed out: '+label);};
async function launch(){
  app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
  await app.evaluate((_electron,{root,modelName})=>{
    process.env.HOME=root;process.env.USERPROFILE=root;
    const trace=globalThis.__realAutomationQa={requests:[],results:[],active:0,peak:0},host=globalThis.__notchHost,query=host.query.bind(host),actualFetch=globalThis.fetch;
    host.query=request=>{const result=query(request),emit=result.emit.bind(result);result.emit=event=>{if(event.type==='result')trace.results.push({at:Date.now(),sessionId:result.id,...event});return emit(event);};return result;};
    // Observe the real HTTP stream. Model requests, replies and tools are never replaced.
    globalThis.fetch=async(url,options)=>{
      if(!String(url).endsWith('/api/chat'))return actualFetch(url,options);
      const body=JSON.parse(options.body);if(body.model!==modelName)throw Error('Unexpected model in local automation QA');
      const prompt=body.messages.findLast(row=>row.role==='user')?.content||'';
      const row={start:Date.now(),label:prompt.match(/REAL_AUTOMATION_[A-Z]+/)?.[0],model:body.model,context:body.options?.num_ctx,tools:body.tools?.length||0};trace.requests.push(row);trace.peak=Math.max(trace.peak,++trace.active);
      try{const response=await actualFetch(url,options);row.status=response.status;
        void response.clone().text().then(text=>{const frames=text.trim().split('\n').map(line=>JSON.parse(line)),last=frames.at(-1);row.end=Date.now();row.promptTokens=last.prompt_eval_count;row.outputTokens=last.eval_count;row.durationNs=last.total_duration;row.toolCalls=frames.flatMap(frame=>frame.message?.tool_calls||[]);}).catch(error=>{row.error=error.message;}).finally(()=>{trace.active--;});
        return response;
      }catch(error){row.error=error.message;trace.active--;throw error;}
    };
  },{root,modelName});
  await until(()=>app.windows().some(p=>p.url().startsWith('notch-app:')),'app window',45000);
  const setup=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));
  if(setup){await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;}
  await until(()=>app.windows().some(p=>p.url().startsWith('notch-app:')&&!new URL(p.url()).searchParams.has('surface')),'primary window',30000);
  page=app.windows().find(p=>p.url().startsWith('notch-app:')&&!new URL(p.url()).searchParams.has('surface'));
  await page.waitForFunction(()=>!!window.notchDesktop?.createAutomationTask);
  const models=await app.evaluate(()=>globalThis.__notchHost.listModels(true));assert.ok(models.some(row=>row.key===model&&row.enabled),'Existing local model is enabled by real discovery');
  assert.equal(await page.evaluate(()=>window.notchModels.workspace()),'shared');
  await page.evaluate(model=>window.notchModels.context(model,8192),model);
}
const call=(method,arg)=>page.evaluate(({method,arg})=>method==='runAutomationTaskNow'?window.notchDesktop[method](arg.taskId,arg.trigger):window.notchDesktop[method](arg),{method,arg});
const runs=async taskId=>(await call('listAutomationTaskRuns',{taskId,limit:50})).runs;
async function create(label,script,schedule){
  const task=await call('createAutomationTask',{name:'Local verification '+label,agentId:'agent:default',model,
    trigger:{kind:'schedule',schedule:schedule||{kind:'every',everyMs:3600000}},executionScope:{kind:'directory',cwd},
    instruction:{text:`REAL_AUTOMATION_${label}. Execute the shell command node ${script} exactly once in the current project. It is a prepared test script. Do not edit any files or scripts. Do not delegate or ask questions. Report the exact command output and stop.`,attachments:[],selectedSkillNames:[],selectedPluginIds:[],selectedConnectorIds:[],selectedAgentNames:[]},executionPolicy:{permissionMode:'bypassPermissions'},outputMode:'independent'});
  tasks.push(task.id);return task;
}
async function completed(id,count=1,status='succeeded'){
  let rows;await until(async()=>{rows=await runs(id);const failed=rows.find(row=>['failed','interrupted'].includes(row.status));if(failed&&status==='succeeded')throw Error('Real automation failed: '+JSON.stringify(failed));return rows.filter(row=>row.status===status).length>=count;},`${id}: ${count} ${status}`);return rows;
}
const capture=async()=>{if(app)traces.push(await app.evaluate(()=>globalThis.__realAutomationQa));};
async function close(){if(!app)return;const owned=app,snapshot=await processSnapshot();app=null;const timer=setTimeout(()=>{void stopOwnedProcesses(owned.process().pid,snapshot);},15000);try{await owned.close();}finally{clearTimeout(timer);}}
try{
  const tags=await(await fetch(base+'/api/tags')).json(),selected=tags.models.find(row=>row.name===modelName);assert.ok(selected,'The test model is already installed');
  modelLoaded={name:selected.name,digest:selected.digest,bytes:selected.size};
  await launch();checks.push('real model discovery and 8K context with shared-folder default');
  const a=await create('A','task-a.mjs',{kind:'at',at:new Date(Date.now()+2000).toISOString()});
  await until(()=>app.evaluate(()=>globalThis.__realAutomationQa.requests.some(row=>row.label==='REAL_AUTOMATION_A')),'first scheduled inference');
  const b=await create('B','task-b.mjs',{kind:'at',at:new Date(Date.now()+1000).toISOString()});
  await until(()=>app.evaluate(()=>globalThis.__notchHost.getQueueStatus().some(row=>row.message.includes('another task'))),'second scheduled task queues');
  const cancelled=await create('CANCELLED','task-b.mjs');await call('runAutomationTaskNow',{taskId:cancelled.id});
  await until(()=>app.evaluate(()=>globalThis.__notchHost.getQueueStatus().length>=2),'cancelable automation queues');
  await call('stopAutomationTask',cancelled.id);await completed(cancelled.id,1,'canceled');
  assert.equal(await app.evaluate(()=>globalThis.__realAutomationQa.requests.some(row=>row.label==='REAL_AUTOMATION_CANCELLED')),false);checks.push('queued cancellation sends no inference');
  await until(async()=>{try{await fs.access(path.join(cwd,'a-started.json'));return true;}catch{return false;}},'real model starts first shell command');
  assert.ok((await app.evaluate(()=>globalThis.__notchHost.getQueueStatus())).some(row=>row.message.includes('another task')),'Second task stays queued during the first shell command');
  const aRuns=await completed(a.id),bRuns=await completed(b.id);
  assert.equal(aRuns[0].trigger,'scheduled');assert.equal(bRuns[0].trigger,'scheduled');
  assert.equal(await fs.readFile(path.join(cwd,'queue.txt'),'utf8'),'start\nA\nB\n');
  assert.match(aRuns[0].resultSummary,/QUEUE_A_OK/);assert.match(bRuns[0].resultSummary,/QUEUE_B_OK/);
  const trace=await app.evaluate(()=>globalThis.__realAutomationQa),aEnd=trace.results.find(row=>row.sessionId===aRuns[0].executionSessionId)?.at,bStart=trace.requests.find(row=>row.label==='REAL_AUTOMATION_B')?.start;
  assert.ok(aEnd&&bStart&&bStart>=aEnd,'Second inference starts after the first complete turn');checks.push('two real scheduled tasks execute in order without overlapping writes or inference');
  const recurring=await create('RECURRING','recurring.mjs',{kind:'every',everyMs:60000});
  const repeated=await completed(recurring.id,2);assert.ok(repeated.every(run=>run.trigger==='scheduled'));
  await page.evaluate(id=>window.notchDesktop.setAutomationTaskEnabled(id,false),recurring.id);
  assert.equal(await fs.readFile(path.join(cwd,'ticks.txt'),'utf8'),'tick\ntick\n');checks.push('two real one-minute recurring runs execute and persist outputs');
  const ps=await(await fetch(base+'/api/ps')).json();assert.ok(ps.models.some(row=>row.name===modelName));modelLoaded={...modelLoaded,running:ps.models.find(row=>row.name===modelName)};
  assert.equal(trace.peak,1);await capture();await close();await launch();
  assert.equal((await runs(a.id))[0].status,'succeeded');assert.equal((await runs(b.id))[0].status,'succeeded');assert.equal((await runs(cancelled.id))[0].status,'canceled');
  assert.equal((await call('getAutomationTask',recurring.id)).enabled,false);assert.equal((await runs(recurring.id)).length,2);
  const saved=await app.evaluate(async(_electron,{id,cwd})=>globalThis.__notchHost.loadSession(id,cwd),{id:aRuns[0].executionSessionId,cwd});assert.ok(saved.messages.some(row=>row.role==='tool'));
  assert.equal(await fs.readFile(path.join(cwd,'queue.txt'),'utf8'),'start\nA\nB\n');checks.push('real run histories, tool transcripts and disabled schedule survive restart');
  assert.deepEqual(errors,[]);passed=true;
}catch(error){failure=error.stack;console.error(error.stack);}
finally{
  if(app){for(const id of tasks){await page.evaluate(id=>window.notchDesktop.setAutomationTaskEnabled(id,false),id).catch(()=>{});await call('stopAutomationTask',id).catch(()=>{});}await capture().catch(()=>{});await close();}
  try{const response=await fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:modelName,keep_alive:0,stream:false}),signal:AbortSignal.timeout(120000)});assert.ok(response.ok);await response.json();await until(async()=>{const ps=await(await fetch(base+'/api/ps')).json();return !ps.models.some(row=>row.name===modelName);},'model unload',30000);unloaded=true;checks.push('test model explicitly unloaded and absence verified with /api/ps');}catch(error){passed=false;failure=(failure||'')+'\nUnload: '+error.stack;}
  const requests=traces.flatMap(trace=>trace.requests);
  if(passed)try{assert.ok(requests.length>=8);assert.ok(requests.every(row=>row.status===200&&row.promptTokens>0&&row.outputTokens>0&&row.context===8192));assert.ok(traces.every(trace=>trace.peak<=1));}
  catch(error){passed=false;failure=error.stack;}
  const report={passed,executable,root,model:modelLoaded,checks,errors,unloaded,traces,...failure?{error:failure}:{},method:'Packaged Windows IDE, real installed Ollama model, native automation scheduler and shell tools; fetch only observed, never mocked.'};
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({passed,reportFile,root,checks,unloaded,model:modelName,requests:requests.length}));
}
if(!passed)process.exitCode=1;
