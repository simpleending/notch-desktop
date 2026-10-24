import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {patchAutomationsMain,patchAutomationsRenderer} from '../src/automation-patch.mjs';
import {createAutomationViews} from '../src/automation-view.mjs';
import {createAutomations} from '../src/automations.mjs';
import {automationPolicy,automationReplay,newAutomationPolicy} from '../src/automation-policy.mjs';
const fixture=await fs.readFile(new URL('./fixtures/automation-main.js',import.meta.url),'utf8');
const finish=(run,status,finishedAt,error)=>({...run,status,finishedAt,error});
function native(automations,extra={}){
  let id=0;const context={Ut:class{},globalThis:{__notchHost:{automations}},De:()=>String(++id),RIr:1000,PIr:60000,get:value=>value?JSON.parse(value):null,Vfe:finish,dT:JSON.stringify,h9t:class{},...extra};
  return vm.runInNewContext(patchAutomationsMain(fixture)+';({Scheduler:ule,Store:pue,Executor:QIr,parsePolicy:g$e});',context);
}
async function controller(t,options={}){const folder=await fs.mkdtemp(path.join(os.tmpdir(),'notch-automations-unit-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));return createAutomations(folder,options);}
function claim(policy={}){return{run:{id:'run',taskId:'task',status:'running',executionSessionId:'session',startedAt:0},taskSnapshot:{id:'task',name:'Task',executionPolicy:policy}};}
function executorFixture(runtime,extra={}){
  const state={sends:0,interrupts:0,disposed:0},run=claim();
  const options={isCancellationRequested:()=>false,store:{getRun:()=>run.run},logger:{error(){}},powerService:{acquirePreventSleep:()=>({dispose(){state.disposed++;}})},chatSessionService:{async send(){state.sends++;},async interrupt(){state.interrupts++;return{status:'idle'};}}};
  const {Executor}=native(runtime),executor=new Executor(options);
  Object.assign(executor,{watchSessionCompletion:()=>({promise:Promise.resolve({status:'completed'}),dispose(){state.disposed++;}}),sendRequest:async()=>({}),collectArtifacts:async()=>({summary:'Done',assistantMessageId:null,fileChanges:[]}),...extra});
  return{executor,options,state,run};
}

test('native automation controls patch the shipped renderer and survive repeated packaging',async()=>{
  const source=await fs.readFile(new URL('./fixtures/automation-renderer.js',import.meta.url),'utf8'),patched=patchAutomationsRenderer(source);
  assert.equal(patchAutomationsRenderer(patched),patched);new vm.Script(patched.replace(/^import[^\n]*\n/gm,''));
  const reason=vm.runInNewContext(patched.replace(/^import[^\n]*\n/gm,'')+';formatAutomationRunReason({error:JSON.stringify({type:"missed",resolution:"skipped-by-policy"})},()=>"fallback","en-US")');assert.match(reason,/skipped.*recovery/);
  assert.throws(()=>patchAutomationsRenderer(source.replace('executionPolicy:{permissionMode:R1','executionPolicy:{permissionMode:changed')),/anchor changed/);
});

test('run-option inputs preserve the rest of a saved policy',()=>{
  let changed;const state=[],React={createElement:(type,props,...children)=>({type,props,children}),useState:value=>[value,()=>{}]};
  const component=createAutomationViews(React).Options,value={...newAutomationPolicy,permissionMode:'read-only'};
  const tree=component({value,onChange:next=>{changed=next;},schedule:{kind:'every',everyMs:60000}});
  const nodes=[];function visit(node){if(!node||typeof node!=='object')return;nodes.push(node);for(const child of node.children||[])if(Array.isArray(child))child.forEach(visit);else visit(child);}visit(tree);
  nodes.find(node=>node.type==='input'&&node.props.max===1440).props.onChange({target:{value:'7'}});assert.deepEqual(changed,{...value,maxRuntimeMs:420000});
  nodes.find(node=>node.type==='select'&&node.props.value==='changes').props.onChange({target:{value:'off'}});assert.deepEqual(changed,{...value,notifications:'off'});
});

test('automation options preserve legacy behavior and reject invalid limits',()=>{
  assert.equal(automationPolicy({}).maxRuntimeMs,0);assert.equal(automationPolicy({}).notifications,'errors');assert.equal(automationPolicy(newAutomationPolicy).maxRuntimeMs,1200000);
  for(const input of [{maxRuntimeMs:-1},{maxTokens:1.5},{maxTokens:Infinity},{notifications:'unknown'},{missedRuns:'all'},{retryResources:'yes'}])assert.throws(()=>automationPolicy(input));
});

test('native create and update IPC preserve run options before normalizing the task',()=>{
  const {parsePolicy}=native({policy:automationPolicy},{cv:value=>value&&typeof value==='object'&&!Array.isArray(value),BZr:value=>{if(!['auto','bypassPermissions'].includes(value))throw Error('Invalid permission mode');return value;}});
  const input={...newAutomationPolicy,permissionMode:'bypassPermissions'};assert.deepEqual(parsePolicy(input),input);assert.throws(()=>parsePolicy({...input,maxTokens:-1}),/token/);assert.throws(()=>parsePolicy({...input,permissionMode:'unknown'}),/permission/);
});

test('a stopped automation cannot dispatch after asynchronous setup finishes',async t=>{
  const runtime=await controller(t),{executor,state,options,run}=executorFixture(runtime);let release;const gate=new Promise(resolve=>release=resolve);
  executor.sendRequest=()=>gate;runtime.attach({chatSessionService:options.chatSessionService});
  const execution=executor.execute(run);await delay(0);await runtime.cancel(run.run);release({});const result=await execution;
  assert.equal(state.sends,0);assert.equal(result.status,'canceled');assert.equal(state.disposed,2);assert.equal(runtime.status().active.length,0);
});

test('cancellation remains bound to the query during session dispatch',async t=>{
  const runtime=await controller(t),{executor,state,options,run}=executorFixture(runtime);let release,signal;
  options.chatSessionService.send=async()=>{signal=runtime.queryOptions('session').signal;await new Promise(resolve=>release=resolve);signal.throwIfAborted();state.sends++;};
  runtime.attach({chatSessionService:options.chatSessionService});const execution=executor.execute(run);for(let i=0;i<500&&!release;i++)await delay(2);assert(release,'The session dispatch starts');await runtime.cancel(run.run);assert(signal.aborted);assert.throws(()=>runtime.queryOptions('session'),/stopped/);release();
  assert.equal((await execution).status,'canceled');assert.equal(state.sends,0);
});

test('schedule and pending run roll back together when the run write fails',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE definitions(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE scheduled_task_run_logs(run_log_id TEXT,task_id TEXT,status TEXT);');
  const task={id:'task',enabled:true,pauseReason:null,nextRunAt:1000,executionPolicy:{},trigger:{kind:'schedule'}};
  db.prepare('INSERT INTO definitions VALUES (?,?)').run(task.id,JSON.stringify(task));let fail=true;
  const runtime={policy:automationPolicy},api=native(runtime,{
    oN:(connection,id)=>JSON.parse(connection.prepare('SELECT json FROM definitions WHERE id=?').get(id).json),
    qj:(connection,value)=>connection.prepare('UPDATE definitions SET json=? WHERE id=?').run(JSON.stringify(value),value.id),
    hOe:(value,request,missed)=>({...request,status:missed?'missed':'pending'}),
    Yre:(connection,run)=>{connection.prepare('INSERT INTO scheduled_task_run_logs VALUES (?,?,?)').run(run.id,run.taskId,run.status);if(fail)throw Error('injected disk write failure');},
  });
  const store=new api.Store({transaction(callback){db.exec('BEGIN IMMEDIATE');try{const result=callback(db);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}});
  const request={id:'run',taskId:'task',requestedAt:1000};
  assert.throws(()=>store.enqueueScheduled(task,null,request),/disk write/);assert.equal(db.prepare('SELECT count(*) AS n FROM scheduled_task_run_logs').get().n,0);assert.deepEqual(JSON.parse(db.prepare('SELECT json FROM definitions').get().json),task);
  fail=false;store.enqueueScheduled(task,null,request);assert.equal(db.prepare('SELECT count(*) AS n FROM scheduled_task_run_logs').get().n,1);assert.equal(JSON.parse(db.prepare('SELECT json FROM definitions').get().json).enabled,false);
  assert.equal(store.enqueueScheduled(task,null,{...request,id:'duplicate'}),null);
  db.prepare('UPDATE definitions SET json=?').run(JSON.stringify(task));const skipped=store.enqueueScheduled(task,null,{...request,id:'skipped',notchSkip:true,notchSkipReason:'startup'});assert.equal(skipped.run.status,'missed');assert.equal(JSON.parse(skipped.run.error).resolution,'skipped-by-policy');db.close();
});

test('one failed timer callback reports the fault and arms a retry',()=>{
  const callbacks=[],errors=[],runtime={health:error=>errors.push(error)},api=native(runtime,{setTimeout:(callback,ms)=>{callbacks.push({callback,ms});return callbacks.length;},clearTimeout(){}});
  let calls=0;const service=Object.assign(Object.create(api.Scheduler.prototype),{initialized:true,shuttingDown:false,store:{earliestWakeAt:()=>Date.now()},logger:{error(){}},processDueSchedules(){if(calls++===0)throw Error('storage unavailable');}});
  service.armTimer();callbacks[0].callback();assert(errors[0]);assert.equal(callbacks.length,2);callbacks[1].callback();callbacks[2].callback();assert.equal(calls,2);assert.equal(errors.at(-1),null);assert(callbacks.length>=4);
});

test('30 days of missed minute runs retain the latest slot and exact count',()=>{
  const first=Date.UTC(2026,9,1),now=first+30*86400000,result=automationReplay({kind:'every',everyMs:60000},first,now);
  assert.equal(result.missedCount,43200);assert.equal(result.replayScheduledFor,now);assert.equal(result.nextRunAt,now+60000);
});

test('bounded cron catch-up retains the newest slot and labels its count as a lower bound',()=>{
  const first=0,now=30*86400000,result=automationReplay({kind:'cron'},first,now,value=>(Math.floor(value/60000)+1)*60000);
  assert.equal(result.replayScheduledFor,now);assert.equal(result.countAtLeast,true);assert.equal(result.missedCount,10000);assert.equal(result.nextRunAt,now+60000);
});

test('time and token limits stop the run and dispose listeners',async t=>{
  for(const policy of [{maxRuntimeMs:20},{maxTokens:50}]){
    const runtime=await controller(t),{executor,run,state}=executorFixture(runtime);run.taskSnapshot.executionPolicy=policy;
    executor.watchSessionCompletion=()=>({promise:new Promise(()=>{}),dispose(){state.disposed++;}});
    executor.options.chatSessionService.send=async()=>{if(policy.maxTokens)runtime.queryOptions('session').usage({inputTokens:45,outputTokens:5});};
    const keepAlive=setTimeout(()=>{},1000),result=await executor.execute(run);clearTimeout(keepAlive);
    assert.equal(result.status,'failed');assert.match(result.error,policy.maxTokens?/token-limit/:/timeout/);assert.equal(runtime.status().active.length,0);assert.equal(state.disposed,2);
  }
});

test('temporary local memory pressure waits and remains cancellable before dispatch',async t=>{
  let attempts=0;const runtime=await controller(t,{host:{listModels:async()=>{if(attempts++===0)throw Error('Not enough available memory');return[{key:'ollama/tiny',enabled:true}];}},resourceDelay:1});
  const {executor,run,state}=executorFixture(runtime);run.taskSnapshot.model='ollama/tiny';const result=await executor.execute(run);assert.equal(result.status,'succeeded');assert.equal(attempts,2);assert.equal(state.sends,1);
});

test('notifications report changed results and deduplicate unchanged and repeated errors',async t=>{
  const notices=[],runtime=await controller(t,{notify:value=>notices.push(value)}),data=claim({notifications:'changes'});runtime.attach({logger:{error(){}}});
  const run={...data.run,status:'succeeded',resultSummary:'First result',fileChanges:[]};await runtime.completed(data,run);await runtime.completed(data,run);await runtime.completed(data,{...run,resultSummary:'[NO_CHANGE] Same checks'});await runtime.completed(data,{...run,status:'failed',error:'error'});await runtime.completed(data,{...run,status:'failed',error:'error'});assert.equal(notices.length,2);
});

test('local presets persist prompt, project, model and policy without cloud access',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'notch-preset-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const task={...claim(newAutomationPolicy).taskSnapshot,model:'strata/tiny',productMode:'coding',instruction:{text:'Check this project',attachments:[],selectedSkillNames:[],selectedPluginIds:[],selectedConnectorIds:[],selectedAgentNames:[]},executionScope:{kind:'directory',cwd:folder},trigger:{schedule:{kind:'every',everyMs:60000}}};
  const runtime=createAutomations(folder);runtime.attach({get:()=>task});const preset=await runtime.savePreset(task.id),restarted=createAutomations(folder),catalog=await restarted.catalog();
  const saved=catalog.modes.coding.find(row=>row.id===preset.id);assert.equal(saved.notch.model,task.model);assert.deepEqual(saved.notch.executionScope,task.executionScope);assert.deepEqual(saved.notch.executionPolicy,automationPolicy(newAutomationPolicy));assert.equal(saved.instruction['en-US'],task.instruction.text);
  await restarted.deletePreset(saved.id);assert.equal((await restarted.catalog()).modes.coding.some(row=>row.id===saved.id),false);
});
