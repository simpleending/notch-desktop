import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-model-switch-')),profile=path.join(root,'profile'),workspace=path.join(root,'project');
await fs.mkdir(workspace);const receipts=Array.from({length:3},()=>`SWITCH_RECEIPT_${randomUUID().replaceAll('-','')}`);
await Promise.all(receipts.map((receipt,i)=>fs.writeFile(path.join(workspace,`receipt-${i}.txt`),receipt)));
const models=['notch-hf-abd14067e8d7:latest','notch-hf-44f890f704fc:latest'];
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_OLLAMA_CONTEXT:''};
const checks=[],errors=[];let app,page,sessionId;
async function launch(){app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});app.on('window',w=>w.on('pageerror',error=>errors.push(error.message)));page=await app.firstWindow();}
async function probe(){await app.evaluate(()=>{
  const host=globalThis.__notchHost,query=host.query.bind(host),fetcher=globalThis.fetch;
  globalThis.__switchTrace={requests:[],results:[],events:[]};
  host.query=request=>{const result=query({...request,tools:['Read']}),emit=result.emit.bind(result);globalThis.__switchQuery=result;
    result.emit=event=>{const trace=globalThis.__switchTrace;if(event.type==='result')trace.results.push({...event,model:result.model});trace.events.push(event);return emit(event)};return result;};
  globalThis.fetch=(url,options)=>{if(String(url).endsWith('/api/chat')){const body=JSON.parse(options.body);globalThis.__switchTrace.requests.push({url:String(url),model:body.model,context:body.options.num_ctx});}return fetcher(url,options);};
});}
async function restoredLabel(label){await page.waitForFunction(expected=>document.querySelector('button[aria-label="Model"]')?.innerText===expected,label,{timeout:15000});assert.equal(await page.getByRole('button',{name:'Model',exact:true}).innerText(),label);}
async function select(model){
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('searchbox',{name:'Search models'}).fill(model);
  const option=page.locator(`button[role="option"][title="ollama/${model}"]`);await option.waitFor();assert.equal(await option.count(),1);await option.click({timeout:15000});
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('combobox',{name:'Context limit'}).selectOption('8192');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Context limit"]')?.value==='8192');await page.keyboard.press('Escape');
}
async function turn(index,model,activeCheck=false){
  const before=await app.evaluate(()=>globalThis.__switchTrace.results.length);
  const composer=page.locator('[contenteditable=true][role=textbox]').first();
  await composer.fill(`Use the Read tool to read receipt-${index}.txt. Reply only with its contents. Do not guess or execute commands.`);await composer.press('Enter');
  if(activeCheck){
    const deadline=Date.now()+15000;while(!await app.evaluate(()=>!!globalThis.__switchQuery?.active)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await app.evaluate(()=>!!globalThis.__switchQuery?.active),true);
    const denied=await app.evaluate(async(_electron,other)=>{try{await globalThis.__switchQuery.setModel(`ollama/${other}`);return false}catch(error){return /Finish or interrupt/.test(error.message)}},models[1]);
    assert.equal(denied,true,'An active turn must reject model changes');
  }
  const until=Date.now()+180000;let trace;
  while(Date.now()<until){trace=await app.evaluate(()=>globalThis.__switchTrace);if(trace.results.slice(before).some(result=>result.model===`ollama/${model}`))break;await new Promise(resolve=>setTimeout(resolve,200));}
  const result=trace.results.slice(before).find(result=>result.model===`ollama/${model}`);assert.equal(result?.subtype,'success',JSON.stringify(result));sessionId=result.session_id;
  assert.equal(result.model,`ollama/${model}`);assert.ok(String(result.result).includes(receipts[index]));
  assert.ok(trace.events.some(event=>event.message?.content?.some(part=>part.type==='tool_result'&&String(part.content).includes(receipts[index]))));
  let usage;const usageUntil=Date.now()+10000;while(Date.now()<usageUntil){usage=await page.evaluate(id=>window.notchDesktop.getChatSessionContextUsage(id),sessionId);if(usage?.model===`ollama/${model}`&&usage.totalTokens>0)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(usage,'Context usage must update after the completed model turn');assert.equal(usage.model,`ollama/${model}`);assert.equal(usage.maxTokens,8192);assert.ok(usage.totalTokens>0);
  const calls=trace.requests.filter(call=>call.model===model.replace(/:latest$/,'' )||call.model===model);assert.ok(calls.length>0);assert.ok(calls.every(call=>call.context===8192));
  const origin=new URL(calls.at(-1).url).origin;
  const mounted=(await(await fetch(origin+'/api/ps')).json()).models.find(row=>row.name===model);assert.equal(mounted.context_length,8192);
  checks.push({turn:index,model,usage,activeChangeRejected:activeCheck||undefined});
  console.log(JSON.stringify({turn:index,model,passed:true}));
  await fetch(origin+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,keep_alive:0,stream:false}),signal:AbortSignal.timeout(15000)});
}
try{
  await launch();let setup;const until=Date.now()+30000;while(!setup&&Date.now()<until){setup=app.windows().find(w=>w.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(setup);
  await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();await probe();
  await select(models[0]);await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},workspace);
  await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('model switching');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Access permissions',exact:true}).click();await page.getByRole('menuitem',{name:/^Ask for approval/}).click();
  await turn(0,models[0],true);await select(models[1]);await turn(1,models[1]);
  const label=await page.getByRole('button',{name:'Model',exact:true}).innerText();await app.close();app=null;
  // Simulate retirement before the UI cache receives the completed SDK snapshot.
  const database=new DatabaseSync(path.join(profile,'main.sqlite'));try{database.prepare('DELETE FROM chat_session_context_usage WHERE session_id=?').run(sessionId);}finally{database.close();}
  await launch();await page.waitForLoadState('domcontentloaded');await probe();
  const restoredUsage=await page.evaluate(id=>window.notchDesktop.getChatSessionContextUsage(id),sessionId);
  assert.equal(restoredUsage?.model,`ollama/${models[1]}`);assert.equal(restoredUsage?.totalTokens,checks[1].usage.totalTokens);assert.equal(restoredUsage?.maxTokens,8192);
  const reopened=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);await page.getByText(reopened.summary.title,{exact:true}).first().click();
  await restoredLabel(label);
  await select(models[0]);await turn(2,models[0]);
  const finalLabel=await page.getByRole('button',{name:'Model',exact:true}).innerText();await app.close();app=null;
  for(let n=0;n<2;n++){await launch();await app.close();app=null;}
  await launch();await page.waitForLoadState('domcontentloaded');const finalSession=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);await page.getByText(finalSession.summary.title,{exact:true}).first().click();
  await restoredLabel(finalLabel);
  const saved=await fs.readFile(path.join(profile,'notch-sessions',sessionId+'.json'),'utf8');for(const receipt of receipts)assert.ok(saved.includes(receipt));
  assert.deepEqual(errors,[]);await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,sessionId,checks,historyPreserved:true,selectionSurvivedRestart:true,rapidQuitPreservedSelection:true,usageSurvivedColdRestart:true,errors},null,2));console.log(JSON.stringify({passed:true,checks,historyPreserved:true,selectionSurvivedRestart:true,rapidQuitPreservedSelection:true,usageSurvivedColdRestart:true}));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});
  const selection=page?await page.evaluate(()=>{const button=document.querySelector('button[aria-label="Model"]'),key=button&&Object.keys(button).find(key=>key.startsWith('__reactFiber'));let fiber=key&&button[key];const rows=[];for(let n=0;fiber&&n<20;n++,fiber=fiber.return){const props=fiber.memoizedProps;if(Array.isArray(props?.options))rows.push({component:fiber.type?.name,value:props.value,loading:props.loading,options:props.options.map(row=>({value:row.value,label:row.label,disabled:row.disabled}))});}return rows;}).catch(()=>null):null;
  const native=page?await page.evaluate(()=>window.notchDesktop.listChatComposerModels({fetchStrategy:'live',executionHostKind:'local',workspaceDirectories:[]})).catch(()=>null):null;
  await fs.writeFile(reportFile,JSON.stringify({passed:false,root,sessionId,checks,error:error.stack,selection,native,body:page?await page.locator('body').innerText().catch(()=>null):null},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));if(child.exitCode===null)await stopOwnedProcesses(child.pid,before);}for(const port of [11434,11436])for(const model of models)await fetch(`http://127.0.0.1:${port}/api/generate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,keep_alive:0,stream:false}),signal:AbortSignal.timeout(10000)}).catch(()=>{});}
