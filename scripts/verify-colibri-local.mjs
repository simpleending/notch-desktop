import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {colibriStatus,stopColibri} from '../vendor/notch-core/desktop-harness.js';
import {closeQaApp} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'notch-colibri-real-workspace-'));
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-colibri-real-profile-'));
const receipt='COLIBRI_IDE_'+randomUUID().replaceAll('-','')+'_café_λ_東京';
const report={passed:false,executable,workspace,profile,receipt,method:'Real packaged IDE renderer/model picker and native query harness; real local Colibri inference, no model responses mocked.'};
let app,page;
try {
  const engine=await colibriStatus();assert(engine.verified&&engine.running,'Preload the verified Colibri test model before starting the GUI to avoid double-counting its RAM.');
  report.engine=engine;const model='colibri/'+engine.modelId;
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
  let setup;const until=Date.now()+30000;
  while(!setup&&Date.now()<until){setup=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(r=>setTimeout(r,100));}
  assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  const option=page.getByRole('option').filter({hasText:engine.model.name});await option.waitFor();assert(await option.isEnabled());await option.click();
  await page.getByRole('button',{name:'Model',exact:true}).filter({hasText:engine.model.name}).waitFor();
  await app.evaluate(()=>{
    const actual=globalThis.fetch;globalThis.__colibriQa={requests:[],active:0,maxActive:0};
    globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/api/chat'))throw new Error('Unexpected Ollama inference in a Colibri test.');
      if(!String(url).endsWith('/v1/chat/completions'))return actual(url,init);
      if(!String(url).startsWith('http://127.0.0.1:11437/'))throw new Error('Unexpected inference endpoint in the local test.');
      const body=JSON.parse(init.body),row={model:body.model,tools:body.tools?.length,stream:body.stream};globalThis.__colibriQa.requests.push(row);globalThis.__colibriQa.active++;globalThis.__colibriQa.maxActive=Math.max(globalThis.__colibriQa.maxActive,globalThis.__colibriQa.active);
      const response=await actual(url,init);row.status=response.status;
      void response.clone().text().finally(()=>{row.ended=true;globalThis.__colibriQa.active--;});
      return response;
    };
  });
  report.events=await app.evaluate(async(_electron,{model,workspace,receipt})=>{
    const host=globalThis.__notchHost,query=host.query({cwd:workspace,model,permissionMode:'bypassPermissions',maxTurns:6,
      prompt:`Use write to create colibri-ide-check.txt containing exactly ${receipt}. Then read that file. Do not use commands. Report the receipt you read.`});
    const events=[];for await(const event of query)events.push(event);await query.task;return events;
  },{model,workspace,receipt});
  assert.equal(report.events.find(event=>event.subtype==='init')?.model,model);
  assert.equal(path.resolve(report.events.find(event=>event.subtype==='init')?.cwd),path.resolve(workspace));
  const result=report.events.findLast(event=>event.type==='result');assert.equal(result?.subtype,'success',JSON.stringify(result));
  assert.equal((await fs.readFile(path.join(workspace,'colibri-ide-check.txt'),'utf8')).trim(),receipt);
  assert(result.usage.input_tokens>0&&result.usage.output_tokens>0);
  report.trace=await app.evaluate(()=>globalThis.__colibriQa);assert(report.trace.requests.length>0);assert(report.trace.requests.every(row=>row.model===engine.modelId&&row.status===200));
  const state=JSON.parse(await fs.readFile(path.join(profile,'notch-sessions',result.session_id+'.json'),'utf8'));assert(state.messages.some(m=>m.role==='tool'));
  report.persistedSession=result.session_id;report.savedToolResults=true;
  report.parallelReads=await app.evaluate(async(_electron,{model,workspace})=>{
    const host=globalThis.__notchHost,run=async()=>{const q=host.query({cwd:workspace,model,permissionMode:'read-only',tools:['Read'],maxTurns:4,prompt:'Use Read to read colibri-ide-check.txt. Reply with the complete file contents verbatim, including every character. Do not summarize or modify files.'});const events=[];for await(const event of q)events.push(event);await q.task;return {result:events.findLast(event=>event.type==='result'),events};};
    return Promise.all([run(),run()]);
  },{model,workspace});
  for(const row of report.parallelReads){
    assert.equal(row.result?.subtype,'success');
    assert(row.events.some(event=>event.message?.content?.some(block=>block.type==='tool_result'&&!block.is_error&&typeof block.content==='string'&&block.content.includes(receipt))),'The actual read result must preserve every Unicode character.');
    assert(row.result.result.includes(receipt),'The model must return the full receipt when asked verbatim.');
  }
  for(let i=0;i<50;i++){if(await app.evaluate(()=>globalThis.__colibriQa.active===0))break;await new Promise(r=>setTimeout(r,100));}
  report.trace=await app.evaluate(()=>globalThis.__colibriQa);assert.equal(report.trace.maxActive,1,'Local generations must take turns.');assert.equal(report.trace.active,0);
  report.memory=JSON.parse((await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@{availableKiB=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory;engines=@(Get-Process qwen36 | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64)} | ConvertTo-Json -Compress"],{windowsHide:true,timeout:15000})).stdout);
  assert(report.memory.availableKiB>512*1024,'Keep at least 512 MiB available during the real test.');
  await page.screenshot({path:reportFile.replace('.json','.png')});report.passed=true;
} catch(error) {report.error=error.stack;if(app)report.trace=await app.evaluate(()=>globalThis.__colibriQa).catch(()=>report.trace);if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});}
finally {
  if(app)await closeQaApp(app);
  await stopColibri();report.unloaded=!(await colibriStatus()).running;assert(report.unloaded);
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({passed:report.passed,unloaded:report.unloaded,requests:report.trace?.requests?.length,error:report.error}));
process.exit(report.passed?0:1);
