import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {automationPolicy,automationReplay,automationResourceError,automationNoChange} from './automation-policy.mjs';

function abortError(message,code='canceled'){return Object.assign(Error(message),{name:code==='canceled'?'AbortError':'Error',code});}
async function interruptible(promise,signal){
  signal.throwIfAborted();let abort;
  try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener('abort',abort);}
}
const localized=value=>({'en-US':value,'zh-CN':value});
const starterPresets=[
  ['project-health','Project health','Review the project for new build errors, test failures and obvious regressions. Report actionable changes with file references. Do not modify files. If nothing changed since the preceding run, begin the reply with [NO_CHANGE].'],
  ['test-summary','Test summary','Run the project\'s documented test command, summarize failures and identify their likely causes. Do not change source files or install dependencies. If results are unchanged since the preceding run, begin the reply with [NO_CHANGE].'],
  ['working-tree','Working tree summary','Inspect git status and the current diff. Summarize changed files and unfinished work. Do not commit, push or modify files. If nothing changed since the preceding run, begin the reply with [NO_CHANGE].'],
].map(([id,name,prompt])=>({id:'local-'+id,name:localized(name),description:localized(prompt),instruction:localized(prompt),schedule:{kind:'cron',expression:'0 9 * * *',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},location:'local',productMode:'coding'}));

export function createAutomations(directory,{host,notify=()=>{},now=Date.now,pause=(ms,signal)=>sleep(ms,undefined,{signal}),resourceDelay=10000}={}){
  const file=path.join(directory,'automation-options.json'),entries=new Map;
  let service,healthMessage=null,closed=false,saved={version:1,presets:[],notices:{}},writes=Promise.resolve();
  const ready=fs.readFile(file,'utf8').then(text=>{const data=JSON.parse(text);if(!data||data.version!==1||!Array.isArray(data.presets)||data.presets.length>100)throw Error('Automation preferences could not be read.');saved=data;saved.notices??={};}).catch(error=>{if(error.code!=='ENOENT')throw error;});
  // Every mutation commits before the next one reads the new state.
  async function persist(change){const job=writes.catch(()=>{}).then(async()=>{await ready;const next=change(structuredClone(saved)),temporary=file+'.'+randomUUID()+'.tmp';await fs.mkdir(directory,{recursive:true});try{await fs.writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx',flush:true});await fs.rename(temporary,file);saved=next;}finally{await fs.unlink(temporary).catch(()=>{});}return next;});writes=job;return job;}
  const controller={
    setNotifier(value){if(typeof value!=='function')throw Error('Choose a notification handler.');notify=value;},
    policy:automationPolicy,replay:automationReplay,
    attach(value){service=value;},
    health(error){healthMessage=error?'Scheduling could not access storage. Retrying automatically.':null;},
    recover(value,reason){try{value.replayOfflineSchedules(reason);healthMessage=null;}catch(error){value.logger.error('Automation recovery will retry',{error});controller.health(error);}},
    status(){return{schedulerError:healthMessage,active:[...entries.values()].filter(entry=>!entry.ended).map(entry=>({taskId:entry.task.id,runId:entry.run.id,sessionId:entry.run.executionSessionId,name:entry.task.name,message:entry.message,startedAt:entry.startedAt,tokens:entry.tokens,maxTokens:entry.policy.maxTokens,maxRuntimeMs:entry.policy.maxRuntimeMs}))};},
    queryOptions(id){const entry=entries.get(id);if(!entry)return null;entry.signal.throwIfAborted();return{
      signal:entry.signal,
      maxTokens:entry.policy.maxTokens,
      failure:error=>{entry.failure=error;},
      queue:message=>{entry.message=message||'Running';},
      usage:usage=>{const tokens=usage.inputTokens+usage.outputTokens;if(Number.isSafeInteger(tokens)&&tokens>=0){entry.tokens+=tokens;if(entry.policy.maxTokens&&entry.tokens>=entry.policy.maxTokens)entry.abort.abort(abortError('The automation reached its token limit.','token-limit'));}},
    };},
    async cancel(run){const entry=entries.get(run.executionSessionId);if(entry?.run.id===run.id){entry.message='Stopping…';entry.abort.abort(abortError('Automation stopped.'));}await service?.chatSessionService.interrupt(run.executionSessionId);},
    shutdown(){closed=true;for(const entry of entries.values())entry.abort.abort(abortError('Notch is closing.'));},
    async execute(executor,claim,adapters){
      const task=claim.taskSnapshot,policy=automationPolicy(task.executionPolicy),abort=new AbortController,signal=abort.signal;
      if(closed||executor.options.isCancellationRequested(claim.run.id))abort.abort(abortError('Automation stopped.'));
      const entry={task,run:claim.run,policy,abort,signal,message:'Preparing model…',tokens:0,startedAt:now()};entries.set(claim.run.executionSessionId,entry);
      const timer=policy.maxRuntimeMs?setTimeout(()=>abort.abort(abortError('The automation reached its time limit.','timeout')),policy.maxRuntimeMs):null;timer?.unref?.();
      const watch=executor.watchSessionCompletion(claim.run.executionSessionId,claim.run.id),power=executor.options.powerService.acquirePreventSleep();
      let status='succeeded',error=null,missingCapability=false;
      try{
        signal.throwIfAborted();
        const deadline=now()+Math.min(policy.maxRuntimeMs||300000,300000);
        for(;;){
          try{await controller.preflight(task,entry);break;}catch(failure){
            if(!policy.retryResources||!automationResourceError(failure)||now()>=deadline){if(automationResourceError(failure))failure.code='resource-unavailable';throw failure;}
            entry.message=/memory|ram/i.test(failure.message)?'Waiting for available memory…':'Waiting for the local model…';await pause(resourceDelay,signal);
          }
        }
        const request=await executor.sendRequest(claim);signal.throwIfAborted();
        entry.message='Starting task…';await executor.options.chatSessionService.send(request);
        signal.throwIfAborted();entry.message=entry.message==='Starting task…'?'Running':entry.message;
        const terminal=await interruptible(watch.promise,signal);
        if(executor.options.isCancellationRequested(claim.run.id))status='canceled';else if(terminal.status==='failed'){status='failed';error=adapters.error(entry.failure?{type:automationResourceError(entry.failure)?'resource-unavailable':entry.failure.code==='token-limit'?'token-limit':'execution-error',message:entry.failure.message}:{type:'session-failed'});}else if(terminal.status==='interrupted')status='interrupted';
      }catch(failure){
        const reason=signal.aborted?signal.reason:failure,canceled=executor.options.isCancellationRequested(claim.run.id)||reason?.code==='canceled'||reason?.name==='AbortError';
        status=canceled?'canceled':'failed';missingCapability=adapters.isCapability(reason);
        if(!canceled)error=adapters.error(missingCapability?{type:'capability-unavailable',capabilityKind:reason.capabilityKind,names:[...reason.names]}:{type:['timeout','token-limit','resource-unavailable'].includes(reason?.code)?reason.code:'execution-error',message:String(reason?.message??reason)});
        if(signal.aborted)await executor.options.chatSessionService.interrupt(claim.run.executionSessionId).catch(failure=>executor.options.logger.error('Automation stop could not settle',{error:failure}));
      }finally{clearTimeout(timer);watch.dispose();power.dispose();entry.ended=true;}
      let artifacts={summary:null,assistantMessageId:null,fileChanges:[]};
      try{artifacts=await executor.collectArtifacts(claim.run.executionSessionId,claim.run.id);}catch(failure){executor.options.logger.error('Automation artifacts could not be read',{error:failure});}
      const absent=missingCapability&&!await executor.executionSessionExists(claim.run.executionSessionId),finishedAt=now();
      if(entries.get(claim.run.executionSessionId)===entry)entries.delete(claim.run.executionSessionId);
      return{...adapters.finish(executor.options.store.getRun(claim.run.id)??claim.run,status,finishedAt,error),...absent?{executionSessionId:null}:{},resultSnapshot:{summary:artifacts.summary,assistantMessageId:artifacts.assistantMessageId,capturedAt:finishedAt},resultSummary:artifacts.summary,fileChanges:artifacts.fileChanges};
    },
    async preflight(task,entry){
      if(!host?.listModels)return;
      entry.signal.throwIfAborted();const rows=await host.listModels(true);entry.signal.throwIfAborted();
      const key=task.model||host.getDefaultModel(),row=rows.find(row=>row.key===key);
      if(!row||!row.enabled){const reason=row?.reason||row?.disabledReason||`The selected ${key?.split('/')[0]||'local'} model is unavailable. Refresh models or choose another model.`;throw Error(reason);}
      if(!key.startsWith('openrouter/')&&host.localModelBusy?.())throw Error('Wait for the local model to finish loading or ejecting.');
    },
    async completed(claim,run){
      try{
        const policy=automationPolicy(claim.taskSnapshot.executionPolicy);if(policy.notifications==='off'||run.status==='canceled'||run.status==='missed')return;
        const success=run.status==='succeeded',summary=run.resultSummary||'',fingerprint=createHash('sha256').update(JSON.stringify(success?{summary:summary.trim(),files:run.fileChanges}:{status:run.status,error:run.error})).digest('hex');
        await ready;const preceding=saved.notices[run.taskId],changed=preceding?.success!==fingerprint,show=success?(policy.notifications==='all'||policy.notifications==='changes'&&changed&&!automationNoChange(summary)):(policy.notifications!=='off'&&preceding?.error!==fingerprint);
        await persist(data=>{data.notices[run.taskId]={...data.notices[run.taskId],[success?'success':'error']:fingerprint};return data;});
        if(show)notify({title:claim.taskSnapshot.name,body:success?(summary.replace(/^\s*\[NO_CHANGE\]\s*/,'').slice(0,300)||'Automation finished.'):'Automation needs attention. Open its run history for details.',sessionId:run.executionSessionId});
      }catch(error){service?.logger.error('Automation notification preferences could not be saved',{error});}
    },
    async catalog(){await ready;const templates=[...starterPresets,...saved.presets].map(row=>row.notch&&row.schedule.kind==='at'&&Date.parse(row.schedule.at)<=now()?{...row,schedule:{kind:'at',at:new Date(now()+60000).toISOString()}}:row);return{version:1,modes:{coding:templates,general:templates}};},
    async savePreset(taskId){if(!service)throw Error('Automations are still starting.');const task=service.get(taskId);if(!task)throw Error('Choose an existing automation.');const template={id:'saved-'+randomUUID(),name:localized(task.name),description:localized('Saved local automation preset'),instruction:localized(task.instruction.text),schedule:structuredClone(task.trigger.schedule),location:'local',productMode:task.productMode||'coding',outputMode:task.outputMode,notch:{agentId:task.agentId,model:task.model,executionPolicy:automationPolicy(task.executionPolicy),instruction:structuredClone(task.instruction),executionScope:structuredClone(task.executionScope)}};await persist(data=>{if(data.presets.length>=100)throw Error('Keep up to 100 local presets. Remove an unused preset first.');data.presets.push(template);return data;});return template;},
    async deletePreset(id){if(typeof id!=='string'||!id.startsWith('saved-'))throw Error('Choose a saved local preset.');await persist(data=>{data.presets=data.presets.filter(row=>row.id!==id);return data;});},
    preview(schedule){if(!service)throw Error('Automations are still starting.');if(!schedule||typeof schedule!=='object'||JSON.stringify(schedule).length>4096)throw Error('Choose a valid schedule.');const trigger={kind:'schedule',schedule};service.triggerRegistry.validate(trigger,now());const runs=[];let at=service.triggerRegistry.nextRunAt(trigger,now());for(let i=0;i<3&&at!==null;i++){runs.push(at);at=service.triggerRegistry.followingRunAt(trigger,at,at);}return{runs,timeZone:schedule.kind==='cron'?schedule.timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};},
    async command(action,value){if(action==='status')return controller.status();if(action==='catalog')return controller.catalog();if(action==='savePreset')return controller.savePreset(value);if(action==='deletePreset')return controller.deletePreset(value);if(action==='preview')return controller.preview(value);throw Error('Choose a supported automation action.');},
  };
  // A damaged preferences file remains in place and its error is shown when used.
  void ready.catch(error=>{healthMessage=error.message;});
  return controller;
}
