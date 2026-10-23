import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-download-ui-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
const checks=[],errors=[];let app,page;
try{
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
 app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
 await app.evaluate(()=>{
  const manager=globalThis.__notchHost.modelManager,original=manager.status.bind(manager);globalThis.__downloadCalls=0;globalThis.__downloadJob=null;
  manager.status=async()=>({...await original(),job:globalThis.__downloadJob});
  manager.hubCatalog=async(_runner,{query='' }={})=>({runner:'ollama',query,models:[{repo:'lab/small-model',bytes:2**29,required:2*2**30,fits:true,license:'apache-2.0'},{repo:'lab/large-model',bytes:100*2**30,required:125*2**30,fits:false}],nextPage:null});
  manager.startInstall=async repo=>{globalThis.__downloadCalls++;globalThis.__downloadJob={repo,state:'running',message:'40% - downloading weights',percent:40};return manager.status();};
  manager.cancelInstall=async()=>{globalThis.__downloadJob={...globalThis.__downloadJob,state:'cancelled',message:'Download cancelled; cached files are retained.'};return manager.status();};
 });
 let setup;const until=Date.now()+30000;while(!setup&&Date.now()<until){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 for(const [width,height,dark]of [[1000,700,true],[900,600,false]]){
  await app.evaluate(({BrowserWindow},{url,width,height})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);window.unmaximize();window.setBounds({x:40,y:40,width,height});},{url:page.url(),width,height});
  const theme=page.getByRole('switch',{name:'Dark appearance'});if((await theme.getAttribute('aria-checked')==='true')!==dark)await theme.click();
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();await page.getByRole('tab',{name:'Hugging Face',exact:true}).click();
  const dismiss=page.getByRole('button',{name:'Not now',exact:true});if(await dismiss.count())await dismiss.click();
  const small=page.getByRole('option',{name:'Download lab/small-model',exact:true});await small.waitFor();
  const arrow=await small.locator('svg').evaluate(svg=>{const a=svg.getBoundingClientRect(),b=svg.parentElement.getBoundingClientRect();return {gap:b.right-a.right,width:a.width};});assert.ok(arrow.gap>=12&&arrow.gap<=18);assert.equal(arrow.width,18);
  const calls=await app.evaluate(()=>globalThis.__downloadCalls);await small.click();const confirm=page.getByRole('group',{name:'Confirm model download'});await confirm.waitFor();
  assert.equal(await app.evaluate(()=>globalThis.__downloadCalls),calls);assert.equal(await page.locator('.notch-model-list').isVisible(),false);
  const bounds=await confirm.evaluate(node=>{const rect=node.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,height:innerHeight};});assert.ok(bounds.top>=56&&bounds.bottom<=bounds.height,JSON.stringify(bounds));
  await page.getByRole('button',{name:'Back to models',exact:true}).click();await page.getByRole('option',{name:'Download lab/large-model',exact:true}).click();
  await confirm.getByText(/exceeds available memory/).waitFor();assert.equal(await page.getByRole('button',{name:'Download model',exact:true}).isDisabled(),true);assert.equal(await app.evaluate(()=>globalThis.__downloadCalls),calls);
  await page.getByRole('button',{name:'Back to models',exact:true}).click();await small.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Download model',exact:true}).click();
  await page.getByRole('progressbar',{name:'Model download progress'}).waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('value'),'40');assert.equal(await app.evaluate(()=>globalThis.__downloadCalls),calls+1);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();await page.getByRole('tab',{name:'Hugging Face',exact:true}).click();await page.getByRole('progressbar',{name:'Model download progress'}).waitFor();
  await page.getByRole('button',{name:'Cancel download',exact:true}).click();await page.getByRole('status').filter({hasText:'Download cancelled'}).waitFor();
  await small.click();await page.getByRole('button',{name:'Download model',exact:true}).click();
  await app.evaluate(()=>{globalThis.__downloadJob={...globalThis.__downloadJob,state:'failed',message:'Model validation failed; downloaded files retained.'};});
  await page.getByRole('alert').filter({hasText:'Model validation failed'}).waitFor();
  await small.click();await page.getByRole('button',{name:'Download model',exact:true}).click();
  await app.evaluate(()=>{globalThis.__downloadJob={...globalThis.__downloadJob,state:'complete',message:'Ready. Open Installed to select this model.'};});
  await page.getByRole('button',{name:'Show installed models',exact:true}).waitFor();
  await page.locator('.notch-model-picker').evaluate(picker=>{picker.scrollTop=picker.scrollHeight;});
  const tabs=await page.locator('.notch-model-tabs').evaluate(node=>{const rect=node.getBoundingClientRect(),picker=node.closest('.notch-model-picker').getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,pickerTop:picker.top};});assert.ok(tabs.top>=tabs.pickerTop&&tabs.bottom>tabs.top);
  await page.screenshot({path:reportFile.replace('.json',dark?'-dark.png':'-light.png')});
  await page.getByRole('button',{name:'Show installed models',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Installed');
  await page.keyboard.press('Escape');await app.evaluate(()=>{globalThis.__downloadJob=null;});checks.push({width,height,theme:dark?'dark':'light',visibleConfirmation:true,downloadArrow:true,explicitConfirmation:true,keyboard:true,memoryWarning:true,progress:true,reopen:true,cancel:true,failure:true,retry:true,showInstalled:true});
 }
 assert.deepEqual(errors,[]);await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,profile,checks,errors,method:'Real packaged renderer and model IPC; deterministic download fixtures, no inference.'},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed:false,checks,error:error.stack,errors},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));if(child.exitCode===null)await stopOwnedProcesses(child.pid,before);}}
