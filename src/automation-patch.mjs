import {patchClassMethod,patchFunction} from './bundle-patch.mjs';

function once(source,before,after){if(source.includes(after))return source;if(source.split(before).length!==2)throw Error('Automation integration anchor changed: '+before.slice(0,90));return source.replace(before,after);}

export function patchAutomationsMain(source){
  if(!source.includes('class QIr'))return source;
  source=patchFunction(source,'g$e',`function g$e(t){if(!cv(t))throw new Error("Automation execution strategy is invalid.");return globalThis.__notchHost.automations.policy({...t,permissionMode:BZr(t.permissionMode)});}`);
  if(source.includes('/* notch automation reliability */')){
    source=patchClassMethod(source,'pue','listSessionRuns',body=>body.replace(' LIMIT 1000`','`'));
    return patchClassMethod(source,'hue','getCatalog',`return globalThis.__notchHost.automations.catalog();`);
  }
  source=patchClassMethod(source,'pue','enqueueRun',body=>body+`}
    enqueueScheduled(t,next,request,missed){return this.databaseService.transaction(db=>{
      const task=oN(db,t.id);if(!task||!task.enabled||task.pauseReason||task.nextRunAt!==t.nextRunAt)return null;
      let missedId=null;if(missed){const row={...hOe(task,missed.request,true),error:missed.error};Yre(db,row,task);missedId=row.id;}
      const pending=!!db.prepare("SELECT run_log_id FROM scheduled_task_run_logs WHERE task_id = ? AND status = 'pending' LIMIT 1").get(task.id);
      const run=hOe(task,request,pending);Yre(db,run,task);qj(db,{...task,enabled:next!==null,nextRunAt:next,updatedAt:request.requestedAt});return{kind:pending?'overflow':'enqueued',run,missedId};
    });`);
  source=patchClassMethod(source,'ule','processDueSchedules',`this.expireTasks(t);for(const task of this.store.listDue(t)){
    const due=task.nextRunAt??t,next=this.triggerRegistry.followingRunAt(task.trigger,due,t),result=this.store.enqueueScheduled(task,next,{id:De(),taskId:task.id,trigger:'scheduled',scheduledFor:due,requestedAt:t});
    if(result){this.fire([task.id],[result.run.id]);if(result.kind==='enqueued')this.drainTask(task.id);}
  }`);
  source=patchClassMethod(source,'ule','replayOfflineSchedules',`const now=Date.now();this.expireTasks(now);for(const task of this.store.listDue(now)){
    if(task.trigger.kind!=='schedule')continue;const due=task.nextRunAt??now,replay=_fr(task.trigger.schedule,due,now),skip=task.executionPolicy?.missedRuns==='skip';
    const request={id:De(),taskId:task.id,trigger:'missed-recovery',scheduledFor:replay.replayScheduledFor,requestedAt:now};
    const missed=replay.missedCount>0?{request:{...request,id:De(),trigger:'scheduled',scheduledFor:due},error:dT({type:'missed',reason:t,count:replay.missedCount,atLeast:!!replay.countAtLeast,scheduledFor:due,detectedAt:now})}:null;
    const result=this.store.enqueueScheduled(task,replay.nextRunAt,skip?{...request,notchSkip:true,notchSkipReason:t}:request,missed);
    if(result){this.fire([task.id],[result.run.id,...result.missedId?[result.missedId]:[]]);if(result.kind==='enqueued'&&!skip)this.drainTask(task.id);}
  }`);
  // Skipping missed runs still records the recovery decision in the same transaction.
  source=once(source,"const run=hOe(task,request,pending);Yre(db,run,task);","const run=hOe(task,request,pending||!!request.notchSkip);if(request.notchSkip)run.error=dT({type:'missed',reason:request.notchSkipReason||'startup',count:1,resolution:'skipped-by-policy',scheduledFor:request.scheduledFor,detectedAt:request.requestedAt});Yre(db,run,task);");
  source=patchClassMethod(source,'ule','armTimer',`if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(!this.initialized||this.shuttingDown)return;
    const host=globalThis.__notchHost?.automations;let wait;try{const next=this.store.earliestWakeAt();if(next===null)return;wait=Math.min(Math.max(next-Date.now(),RIr),PIr);}catch(error){this.logger.error('Automation timer could not read storage',{error});host?.health(error);wait=5000;}
    this.timer=setTimeout(()=>{try{this.processDueSchedules(Date.now());host?.health(null);this.notchTimerFailures=0;}catch(error){this.notchTimerFailures=Math.min((this.notchTimerFailures||0)+1,6);this.logger.error('Automation scheduling will retry',{error});host?.health(error);}finally{if(this.notchTimerFailures&&!this.shuttingDown)this.timer=setTimeout(()=>this.armTimer(),Math.min(60000,1000*2**this.notchTimerFailures));else this.armTimer();}},wait);`);
  source=patchFunction(source,'_fr',`function _fr(t,e,r){return globalThis.__notchHost.automations.replay(t,e,r,at=>N4e(t,at));}`);
  source=patchFunction(source,'T4e',body=>once(body,'executionPolicy:{...t.executionPolicy}','executionPolicy:globalThis.__notchHost.automations.policy(t.executionPolicy)'));
  source=patchClassMethod(source,'ule','initialize',body=>`globalThis.__notchHost.automations.attach(this);`+body.replace('this.replayOfflineSchedules("startup")','globalThis.__notchHost.automations.recover(this,"startup")'));
  source=patchClassMethod(source,'ule','handleResume',body=>body.replace('this.replayOfflineSchedules("resume")','globalThis.__notchHost.automations.recover(this,"resume")'));
  source=patchClassMethod(source,'ule','stop',`const run=this.store.findRunningRun(t);if(!run?.executionSessionId)throw Error('This task has no active run.');this.cancellationRequests.add(run.id);await globalThis.__notchHost.automations.cancel(run);`);
  source=patchClassMethod(source,'ule','shutdown',body=>`globalThis.__notchHost.automations.shutdown();`+body);
  source=patchClassMethod(source,'QIr','execute',`return globalThis.__notchHost.automations.execute(this,e,{finish:Vfe,error:dT,isCapability:error=>error instanceof h9t});`);
  source=patchClassMethod(source,'hue','getCatalog',`return globalThis.__notchHost.automations.catalog();`);
  source=patchClassMethod(source,'ule','executeClaimed',body=>once(body,'this.fire([e.taskId],[e.id])','this.fire([e.taskId],[e.id]);await globalThis.__notchHost.automations.completed(t,e)'));
  source=patchFunction(source,'yTe',body=>once(body,'get(e.error)?.type==="capability-unavailable"','["capability-unavailable","resource-unavailable"].includes(get(e.error)?.type)'));
  return '/* notch automation reliability */\n'+source;
}

export function patchAutomationsRenderer(source){
  if(!source.includes('function LocalAutomationTaskDialog('))return source;
  if(source.includes('/* notch automation controls */'))return patchFunction(source,'ModelsSettings',body=>body.includes('NotchAutomationStorage')?body:once(body,'side:"bottom"})]','side:"bottom"}),reactExports.createElement(NotchAutomationStorage,{})]'));
  source=patchFunction(source,'LocalAutomationTaskDialog',body=>{
    body=once(body,'reactExports.useState(r1?.model??"")','reactExports.useState(r1?.model??i1?.notch?.model??"")');
    body=once(body,'x1=r1?.agentId??BUILTIN_DEFAULT_AGENT_ID','x1=r1?.agentId??i1?.notch?.agentId??BUILTIN_DEFAULT_AGENT_ID');
    body=once(body,'r1?r1.executionPolicy.permissionMode==="bypassPermissions":!0','r1||i1?.notch?(r1?.executionPolicy??i1.notch.executionPolicy).permissionMode==="bypassPermissions":!0');
    body=once(body,'const[F1,B1]=reactExports.useState(null)','const[notchPolicy,setNotchPolicy]=reactExports.useState(()=>NotchAutomationPolicy(r1?.executionPolicy??i1?.notch?.executionPolicy??NotchAutomationDefaults)),[F1,B1]=reactExports.useState(null)');
    body=once(body,'executionPolicy:{permissionMode:R1?"bypassPermissions":"auto"}','executionPolicy:{...notchPolicy,permissionMode:R1?"bypassPermissions":"auto"}');
    body=once(body,'afterOutput:jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment,{children:[','afterOutput:jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment,{children:[reactExports.createElement(NotchAutomationOptions,{value:notchPolicy,onChange:setNotchPolicy,taskId:r1?.id,schedule:(()=>{try{return scheduleFromForm(m1);}catch(error){return {error:error.message};}})()}),');
    return body;
  });
  source=patchFunction(source,'templateScope','function templateScope(e1){return e1?.notch?.executionScope??(e1?{kind:"chatOnly"}:null);}');
  source=patchFunction(source,'AutomationTaskDialog',body=>{
    const start=body.indexOf('reactExports.useEffect(()=>{'),end=body.indexOf('},[o1,a1,v1,r1,i1,s1,l1]);',start);
    if(start<0||end<0)throw Error('Automation preset draft anchor changed.');
    const effect=body.slice(start,end).replace(/\br1\b/g,'notchDraft');
    return body.slice(0,start)+effect.replace('let S1=!1;','const notchDraft=r1??(s1?.notch?{...s1.notch,agentId:s1.notch.agentId??BUILTIN_DEFAULT_AGENT_ID}:null);let S1=!1;')+body.slice(end);
  });
  source=patchFunction(source,'AutomationTasksView',body=>{
    body=body.replace('["tasks","logs"].map','["tasks","templates","logs"].map');
    body=once(body,'j1!=="templates"||o2.current||(o2.current=!0,o1.loadTemplates().catch(()=>{}))','j1==="templates"&&o1.loadTemplates(true).catch(()=>{})');
    body=once(body,'jsxRuntimeExports.jsx(ProductPageHeader,{title:r1("automationTasks.title"),description:r1("automationTasks.description")}),','jsxRuntimeExports.jsx(ProductPageHeader,{title:r1("automationTasks.title"),description:r1("automationTasks.description")}),reactExports.createElement(NotchAutomationStatus,{}),j1==="templates"?reactExports.createElement(NotchAutomationPresets,{onChanged:()=>o1.loadTemplates(true)}):null,');
    return body.replace('templates:r1("automationTasks.templatesTab")','templates:"Presets"');
  });
  source=patchFunction(source,'AutomationRunLogs',body=>body.replace('function AutomationRunLogs(','function NotchNativeAutomationRunLogs(')+'\nfunction AutomationRunLogs(props){return reactExports.createElement(NotchAutomationHistory,{...props,component:NotchNativeAutomationRunLogs});}');
  source=patchFunction(source,'formatAutomationRunReason',body=>body.replace('{const r1=',`{try{const detail=JSON.parse(e1.error);if(['timeout','token-limit','resource-unavailable','execution-error'].includes(detail?.type)&&detail.message)return detail.message;if(detail?.resolution==='skipped-by-policy')return 'Missed occurrence skipped according to this task’s recovery setting.';if(detail?.type==='missed'&&detail.atLeast)return 'At least '+detail.count.toLocaleString()+' older occurrences were missed.';}catch{}const r1=`));
  source=patchFunction(source,'ModelsSettings',body=>once(body,'side:"bottom"})]','side:"bottom"}),reactExports.createElement(NotchAutomationStorage,{})]'));
  return `/* notch automation controls */\nimport {createAutomationViews} from './automation-view.mjs';\nimport {automationPolicy as NotchAutomationPolicy,newAutomationPolicy as NotchAutomationDefaults} from './automation-policy.mjs';\nvar notchAutomationViews;\n`+['Options','Status','Presets','History','Storage'].map(name=>`function NotchAutomation${name}(props){return reactExports.createElement((notchAutomationViews??=createAutomationViews(reactExports)).${name},props);}`).join('\n')+'\n'+source;
}
