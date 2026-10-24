import assert from 'node:assert/strict';

// Uses only the isolated profile owned by verify-automations.mjs.
export async function verifyAutomationControls({app,page,call,create,completed,until,checks,cwd,row}){
  const preview=await page.evaluate(()=>window.notchModels.automations('preview',{kind:'cron',expression:'0 9 * * *',timeZone:'America/Toronto'}));
  assert.equal(preview.runs.length,3);assert(preview.runs.every((time,index)=>time>Date.now()&&(!index||time>preview.runs[index-1])));
  const task=await create('PRESET',{executionPolicy:{permissionMode:'bypassPermissions',maxRuntimeMs:420000,maxTokens:12000,notifications:'off',missedRuns:'skip',retryResources:true},outputMode:'independent'});
  const preset=await page.evaluate(id=>window.notchModels.automations('savePreset',id),task.id);
  const saved=(await call('getAutomationTaskTemplates',true)).modes.coding.find(item=>item.id===preset.id);
  assert.equal(saved.notch.model,row.key);assert.equal(saved.notch.executionScope.cwd,cwd);assert.equal(saved.notch.executionPolicy.maxRuntimeMs,420000);assert.equal(saved.outputMode,'independent');
  checks.push('schedule preview and full local preset survive the native IPC catalog');
  await page.evaluate(()=>{location.hash='#/automation';});
  await page.getByRole('button',{name:'Presets',exact:true}).click();
  await page.getByRole('heading',{name:'Verification PRESET',exact:true}).waitFor();
  const card=page.locator('article').filter({has:page.getByRole('heading',{name:'Verification PRESET',exact:true})});await card.getByRole('button').last().click();
  const options=page.getByRole('region',{name:'Automation run options'});await options.waitFor();
  assert.equal(await options.getByLabel('Time limit (minutes)',{exact:true}).inputValue(),'7');assert.equal(await options.getByLabel('Token budget',{exact:true}).inputValue(),'12000');assert.equal(await options.getByLabel('Notifications',{exact:true}).inputValue(),'off');assert.equal(await options.getByLabel(/^After notch was closed$/i).inputValue(),'skip');
  await page.locator('[role="dialog"] [role="textbox"]').filter({hasText:'NOTCH_AUTOMATION_QA:PRESET'}).waitFor();await options.getByText('Next scheduled runs',{exact:true}).waitFor();
  await page.keyboard.press('Escape');checks.push('preset editor restores its model, project, prompt and run options');
  const timed=await create('HOLD',{executionPolicy:{permissionMode:'bypassPermissions',maxRuntimeMs:2000,maxTokens:0,notifications:'off'}});
  await call('runAutomationTaskNow',{taskId:timed.id});assert.equal(JSON.parse((await completed(timed.id,1,'failed'))[0].error).type,'timeout');
  await until(async()=>!(await page.evaluate(()=>window.notchModels.automations('status'))).active.some(run=>run.taskId===timed.id),'timeout clears active progress');checks.push('time limit ends the native run and clears its loading status');
  await app.evaluate(()=>{
    const automation=globalThis.__notchHost.automations,original=automation.execute.bind(automation),trace=globalThis.__automationQa;
    automation.execute=async(executor,claim,adapters)=>{
      if(!claim.taskSnapshot.instruction.text.endsWith(':EARLY_STOP'))return original(executor,claim,adapters);
      const request=executor.sendRequest;executor.sendRequest=async function(...args){trace.earlyStop={waiting:true};await new Promise(resolve=>trace.earlyStop.release=resolve);return request.apply(this,args);};
      try{return await original(executor,claim,adapters);}finally{executor.sendRequest=request;}
    };
  });
  const early=await create('EARLY_STOP');await call('runAutomationTaskNow',{taskId:early.id});await until(()=>app.evaluate(()=>!!globalThis.__automationQa.earlyStop?.waiting),'delayed session setup');await call('stopAutomationTask',early.id);await app.evaluate(()=>globalThis.__automationQa.earlyStop.release());await completed(early.id,1,'canceled');assert.equal(await app.evaluate(()=>globalThis.__automationQa.calls.some(value=>value.endsWith(':EARLY_STOP'))),false);checks.push('Stop during setup dispatches no delayed inference');
  const limited=await create('TOKEN_LIMIT',{executionPolicy:{permissionMode:'bypassPermissions',maxRuntimeMs:30000,maxTokens:1,notifications:'off'}});await call('runAutomationTaskNow',{taskId:limited.id});assert.equal(JSON.parse((await completed(limited.id,1,'failed'))[0].error).type,'token-limit');assert.equal(await app.evaluate(()=>globalThis.__automationQa.calls.some(value=>value.endsWith(':TOKEN_LIMIT'))),false);checks.push('token limit fails clearly before inference and clears progress');
  await page.evaluate(id=>window.notchModels.automations('deletePreset',id),preset.id);
}
