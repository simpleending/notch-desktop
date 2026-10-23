import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),repo=process.argv[4];
assert.match(repo,/^[\w.-]+\/[\w.-]+$/);
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-hf-install-ui-')),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
let app,page;const stages=[];
try{
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
 let setup;const until=Date.now()+30000;while(!setup&&Date.now()<until){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();await page.getByRole('tab',{name:'Hugging Face',exact:true}).click();
 const dismiss=page.getByRole('button',{name:'Not now',exact:true});if(await dismiss.count())await dismiss.click();
 await page.getByRole('searchbox',{name:'Search models'}).fill(repo);
 const row=page.getByRole('option',{name:`Download ${repo}`,exact:true});await row.waitFor({timeout:60000});await row.click();
 await page.getByRole('group',{name:'Confirm model download'}).waitFor();await page.getByRole('button',{name:'Download model',exact:true}).click();
 const deadline=Date.now()+360000;let job;
 while(Date.now()<deadline){
  job=await app.evaluate(async()=>(await globalThis.__notchHost.modelManager.status()).job);
  if(job?.message&&stages.at(-1)!==job.message){stages.push(job.message);console.log(JSON.stringify(job));}
  if(job&&job.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,500));
 }
 assert.equal(job?.state,'complete',JSON.stringify(job));await page.getByRole('button',{name:'Show installed models',exact:true}).click();
 const key=`ollama/hf.co/${repo}:Q4_K_M`;
 const installed=page.locator(`[role=option][title="${key}"]`);await installed.waitFor({timeout:45000});await installed.click({timeout:45000});
 await page.locator('.notch-model-picker').waitFor({state:'hidden'});const selected=await page.getByRole('button',{name:'Model',exact:true}).innerText();
 const models=await app.evaluate(()=>globalThis.__notchHost.listModels());const model=models.find(row=>row.key===key);assert.equal(model?.enabled,true);assert.ok(selected.includes(model.displayName));
 const response=await fetch('http://127.0.0.1:11434/api/ps');assert.equal(response.ok,true);const running=await response.json();assert.ok(!running.models.some(model=>model.name.toLowerCase()===key.slice(7).toLowerCase()),'Install-only validation must release model memory.');
 await page.screenshot({path:reportFile.replace('.json','.png')});await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,profile,repo,stages,model:key,selected,unloaded:true,method:'Real Hugging Face search, UI confirmation, packaged CLI installation with load/tool checks, then composer selection; existing cached weights may be reused.'},null,2));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed:false,repo,stages,error:error.stack},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));if(child.exitCode===null)await stopOwnedProcesses(child.pid,before);}}
