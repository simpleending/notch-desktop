import { _electron } from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { processSnapshot, stopOwnedProcesses,closeQaApp } from './process-tree.mjs';
import { cloudModelRows } from '../src/model-policy.mjs';
import {verifyAutomationControls} from './automation-controls-qa.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'release/automations-verification.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-automations-')),profile=path.join(root,'profile'),cwd=path.join(root,'project');
await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,'automation.txt'),'original');
const row=cloudModelRows([{id:'fixture/automation',name:'Automation verification',context_length:8192,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}],true)[0];row.isDefault=true;
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_AUTO_DREAM:'0',NOTCH_AUTO_UPDATE:'0'};
let app,page;const checks=[],errors=[];
const until=async(check,label)=>{for(let i=0;i<600;i++){if(await check())return;await delay(50);}throw Error('Timed out: '+label);};
async function launch(){
  app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
  await app.evaluate((_electron,{row,root})=>{
    process.env.HOME=root;process.env.USERPROFILE=root;
    const host=globalThis.__notchHost;
    host.listModels=async()=>[row];host.getCachedModels=()=>[row];host.getDefaultModel=()=>row.key;host.resolveModelChoice=()=>row.key;
    host.modelManager.key=async()=>'fixture-only';
    const original=globalThis.fetch,trace=globalThis.__automationQa={calls:[],release:null,notices:[]};host.automations.setNotifier(notice=>trace.notices.push(notice));
    globalThis.fetch=async(url,options)=>{
      if(!String(url).endsWith('/chat/completions'))return original(url,options);
      const body=JSON.parse(options.body),index=body.messages.findLastIndex(x=>x.role==='user'),raw=body.messages[index]?.content;
      const prompt=typeof raw==='string'?raw:JSON.stringify(raw),label=prompt.match(/NOTCH_AUTOMATION_QA:[A-Z_]+/)?.[0];
      if(!label)throw Error('Unexpected automation model prompt');
      trace.calls.push(label);
      if(label.endsWith(':HOLD'))await new Promise((resolve,reject)=>{trace.release=resolve;options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
      if(label.endsWith(':FAIL'))return new Response(JSON.stringify({error:{message:'Fixture rejected request',type:'invalid_request_error'}}),{status:400,headers:{'Content-Type':'application/json'}});
      const results=body.messages.slice(index+1).filter(x=>x.role==='tool');
      let delta={content:'Automation completed '+label},finish='stop';
      if(label.endsWith(':WRITE')&&results.length<2){
        const name=results.length?'write':'read',args=results.length?{path:'automation.txt',content:'automation saved'}:{path:'automation.txt'};
        delta={tool_calls:[{index:0,id:name+'-automation',type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';
      }
      const frame=(delta,finish_reason=null)=>({id:'fixture',choices:[{index:0,delta,finish_reason}]});
      return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({},finish))}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    };
  },{row,root});
  await until(()=>app.windows().some(p=>p.url().startsWith('notch-app:')),'app window');
  const setup=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));
  if(setup){await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;}
  await until(()=>app.windows().some(p=>p.url().startsWith('notch-app:')&&!new URL(p.url()).searchParams.has('surface')),'primary window');
  page=app.windows().find(p=>p.url().startsWith('notch-app:')&&!new URL(p.url()).searchParams.has('surface'));
  await page.waitForFunction(()=>!!window.notchDesktop?.createAutomationTask);
}
const call=(method,arg)=>page.evaluate(({method,arg})=>method==='runAutomationTaskNow'?window.notchDesktop[method](arg.taskId,arg.trigger):window.notchDesktop[method](arg),{method,arg});
const create=(label,patch={})=>call('createAutomationTask',{
  name:'Verification '+label,agentId:'agent:default',model:row.key,
  trigger:{kind:'schedule',schedule:{kind:'every',everyMs:3600000}},executionScope:{kind:'directory',cwd},
  instruction:{text:'NOTCH_AUTOMATION_QA:'+label,attachments:[],selectedSkillNames:[],selectedPluginIds:[],selectedConnectorIds:[],selectedAgentNames:[]},
  executionPolicy:{permissionMode:'bypassPermissions'},outputMode:'independent',...patch,
});
const runs=async taskId=>(await call('listAutomationTaskRuns',{taskId,limit:50})).runs;
async function completed(taskId,count=1,status='succeeded'){
  let rows;await until(async()=>{rows=await runs(taskId);return rows.filter(r=>r.status===status).length>=count;},`${taskId}: ${count} ${status}`);return rows;
}
try{
  await launch();assert.equal((await call('getAutomationTaskCapabilities')).enabled,true);
  const recurring=await create('RECURRING',{trigger:{kind:'schedule',schedule:{kind:'every',everyMs:60000}}});
  await assert.rejects(create('INVALID',{trigger:{kind:'schedule',schedule:{kind:'every',everyMs:1}}}));
  await assert.rejects(create('INVALID',{trigger:{kind:'schedule',schedule:{kind:'cron',expression:'bad cron',timeZone:'Bad/Zone'}}}));
  checks.push('invalid schedules rejected');
  const task=await create('WRITE');await call('runAutomationTaskNow',{taskId:task.id});
  const first=(await completed(task.id))[0];assert.equal(await fs.readFile(path.join(cwd,'automation.txt'),'utf8'),'automation saved');
  assert.ok(first.executionSessionId);assert.match(first.resultSummary,/Automation completed/);
  checks.push('manual automation uses the real harness and writes the selected project');
  const merged=await create('MERGED',{outputMode:'merged'});
  await call('runAutomationTaskNow',{taskId:merged.id});await completed(merged.id);
  await call('runAutomationTaskNow',{taskId:merged.id});const mergedRuns=await completed(merged.id,2);
  assert.equal(mergedRuns[0].executionSessionId,mergedRuns[1].executionSessionId);checks.push('merged runs reuse their saved chat');
  const hold=await create('HOLD');await call('runAutomationTaskNow',{taskId:hold.id});
  await until(()=>app.evaluate(()=>!!globalThis.__automationQa.release),'held automation');
  const queued=await create('QUEUED');await call('runAutomationTaskNow',{taskId:queued.id});
  await until(()=>app.evaluate(()=>globalThis.__notchHost.getQueueStatus().some(row=>row.message.includes('another task'))),'automation waits for shared folder');
  assert.equal(await app.evaluate(()=>globalThis.__automationQa.calls.some(value=>value.endsWith(':QUEUED'))),false);
  await call('stopAutomationTask',queued.id);await completed(queued.id,1,'canceled');checks.push('another automation waits for the shared project and can be canceled before inference');
  await call('runAutomationTaskNow',{taskId:hold.id});await call('runAutomationTaskNow',{taskId:hold.id});
  const waiting=await runs(hold.id);assert.equal(waiting.filter(r=>r.status==='running').length,1);assert.ok(waiting.filter(r=>r.status==='pending').length<=1);
  await call('stopAutomationTask',hold.id);await completed(hold.id,1,'canceled');
  // The pending follow-up is also stopped, so no test job is left active.
  await until(async()=>!(await runs(hold.id)).some(r=>r.status==='pending'),'follow-up claimed');
  if((await runs(hold.id)).some(r=>r.status==='running')){await call('stopAutomationTask',hold.id);await completed(hold.id,2,'canceled');}
  checks.push('overlapping runs coalesce and cancellation stops active runs');
  const failed=await create('FAIL');
  for(let i=1;i<=3;i++){await call('runAutomationTaskNow',{taskId:failed.id});await completed(failed.id,i,'failed');}
  assert.equal((await call('getAutomationTask',failed.id)).pauseReason,'failureCircuit');checks.push('repeated provider failures are recorded and pause the automation');
  const scheduled=await create('SCHEDULED',{trigger:{kind:'schedule',schedule:{kind:'at',at:new Date(Date.now()+2000).toISOString()}}});
  const scheduledRun=(await completed(scheduled.id))[0];assert.equal(scheduledRun.trigger,'scheduled');checks.push('one-time schedule executes through the timer');
  const paused=await create('PAUSED',{trigger:{kind:'schedule',schedule:{kind:'at',at:new Date(Date.now()+2000).toISOString()}}});
  await page.evaluate(id=>window.notchDesktop.setAutomationTaskEnabled(id,false),paused.id);await delay(2500);assert.equal((await runs(paused.id)).length,0);checks.push('disabled schedules do not run');
  const cron=await create('CRON',{trigger:{kind:'schedule',schedule:{kind:'cron',expression:'0 9 * * *',timeZone:'America/Toronto'}}});assert.ok(cron.nextRunAt>Date.now());
  assert.equal(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Toronto',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(cron.nextRunAt),'09:00');
  const updated=await call('updateAutomationTask',{id:cron.id,expectedRevision:cron.revision,name:'Saved cron verification'});
  await assert.rejects(call('updateAutomationTask',{id:cron.id,expectedRevision:cron.revision,name:'Stale edit'}));assert.equal(updated.name,'Saved cron verification');checks.push('timezone cron and stale-update protection');
  await call('setAutomationTaskPreventSleep',true);assert.equal((await call('getAutomationTaskSettings')).preventSleep,true);
  let repeated;for(let i=0;i<1500;i++){repeated=await runs(recurring.id);if(repeated.some(run=>run.status==='succeeded'))break;await delay(50);}
  assert.ok(repeated.some(run=>run.status==='succeeded'));assert.ok((await call('getAutomationTask',recurring.id)).nextRunAt>Date.now());
  await page.evaluate(id=>window.notchDesktop.setAutomationTaskEnabled(id,false),recurring.id);checks.push('recurring timer runs and advances its next execution');
  await verifyAutomationControls({app,page,call,create,completed,runs,until,checks,cwd,row});
  await app.close();app=null;await launch();
  assert.equal((await call('getAutomationTask',cron.id)).name,'Saved cron verification');assert.equal((await call('getAutomationTaskSettings')).preventSleep,true);
  assert.equal((await completed(task.id))[0].executionSessionId,first.executionSessionId);assert.equal((await call('getAutomationTask',paused.id)).enabled,false);
  checks.push('definitions, run history, pause state and sleep setting survive restart');
  const interrupted=await create('HOLD');await call('runAutomationTaskNow',{taskId:interrupted.id});
  await until(()=>app.evaluate(()=>!!globalThis.__automationQa.release),'automation before forced exit');
  const ownedPid=app.process().pid;
  await stopOwnedProcesses(ownedPid,await processSnapshot());app=null;
  await launch();await completed(interrupted.id,1,'interrupted');
  assert.equal(await fs.readFile(path.join(cwd,'automation.txt'),'utf8'),'automation saved');
  assert.equal((await completed(task.id))[0].executionSessionId,first.executionSessionId);checks.push('forced exit recovers the interrupted run and preserves earlier chats and files');
  const saved=await app.evaluate(async({},{id,cwd})=>globalThis.__notchHost.loadSession(id,cwd),{id:first.executionSessionId,cwd});assert.ok(saved.messages.length>=4);
  await call('deleteAutomationTask',cron.id);assert.equal(await call('getAutomationTask',cron.id),null);checks.push('deletion removes the automation');
  await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,root,errors}));
}catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,root,checks,errors,error:error.stack},null,2));throw error;}
finally{if(app){const owned=app,snapshot=await processSnapshot().catch(()=>null);const timer=setTimeout(()=>{if(snapshot)void stopOwnedProcesses(owned.process().pid,snapshot).catch(()=>{if(owned.process().exitCode===null)owned.process().kill();});else if(owned.process().exitCode===null)owned.process().kill();},15000);try{await closeQaApp(owned);}finally{clearTimeout(timer);}}}
