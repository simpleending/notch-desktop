import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'release/shutdown-verification.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-shutdown-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
const checks=[];let app;
async function processes(){
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],{windowsHide:true,timeout:15000,maxBuffer:2**20});
  return JSON.parse(stdout);
}
async function logs(profile){
  const files=await fs.readdir(path.join(profile,'logs'),{recursive:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e});
  return files.filter(file=>path.basename(file)==='main.log').map(file=>path.join(profile,'logs',file));
}
async function finish(profile,stage,close,details={}){
  const child=app.process(),exit=child.exitCode===null?new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal}))):Promise.resolve({code:child.exitCode});
  const before=await processes(),owned=new Set([child.pid]);let changed=true;
  while(changed){changed=false;for(const p of before)if(owned.has(p.ParentProcessId)&&!owned.has(p.ProcessId)){owned.add(p.ProcessId);changed=true;}}
  const started=Date.now();await close();
  let timer;const result=await Promise.race([exit,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error('Startup shutdown exceeded 15 seconds')),15000)})]).finally(()=>clearTimeout(timer));
  app=null;assert.equal(result.code,0,JSON.stringify(result));
  let survivors=[];
  for(let attempt=0;attempt<4;attempt++){
    const live=await processes();survivors=live.filter(p=>owned.has(p.ProcessId)&&before.some(old=>old.ProcessId===p.ProcessId&&old.CreationDate===p.CreationDate));
    if(!survivors.length)break;await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.deepEqual(survivors,[],'An owned IDE/discovery process survived shutdown');
  const mainLogs=await logs(profile),lines=(await Promise.all(mainLogs.map(file=>fs.readFile(file,'utf8')))).flatMap(text=>text.split(/\r?\n/));
  const failures=lines.filter(line=>/\[ERROR\]|Application IPC drain is still pending|APP_PLUGIN_(?:HOST_STOPPING|ACTIVATION_STALE|GENERATION_STALE)|Host startup readiness timed out/.test(line));
  assert.deepEqual(failures,[],failures.join('\n'));
  const summaries=lines.filter(line=>line.includes('Application shutdown cleanup completed')).map(line=>JSON.parse(line.slice(line.indexOf('{'))));
  for(const summary of summaries){assert.equal(summary.completed,true);assert.equal(summary.resourceSafe,true);assert.equal(summary.stateSafe,true);assert.deepEqual(summary.failedJoinerIds,[]);}
  const database=path.join(profile,'main.sqlite');if(await fs.stat(database).catch(()=>null)){
    const db=new DatabaseSync(database,{readOnly:true});try{assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row=>row.quick_check),['ok']);}finally{db.close();}
  }
  checks.push({stage,elapsedMs:Date.now()-started,exitCode:result.code,ownedProcesses:owned.size,summaries,mainLogCount:mainLogs.length,...details});
}
async function launch(profile){await fs.mkdir(profile,{recursive:true});app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});}
async function quit(){await app.evaluate(({app})=>{setImmediate(()=>app.quit());});}
async function closeWindows(){await app.evaluate(({BrowserWindow})=>{setImmediate(()=>{for(const w of BrowserWindow.getAllWindows().reverse())if(!w.isDestroyed())w.close();});});}
try{
  for(let n=0;n<2;n++){
    const profile=path.join(root,'early-'+n);await launch(profile);await app.firstWindow();await finish(profile,'startup-quit-'+n,quit);
  }
  const dismissed=path.join(root,'dismissed-setup');await launch(dismissed);
  let overlay;const setupUntil=Date.now()+30000;while(!overlay&&Date.now()<setupUntil){overlay=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));if(!overlay)await new Promise(r=>setTimeout(r,100));}assert.ok(overlay);
  await overlay.getByRole('button',{name:'Close setup',exact:true}).waitFor();await finish(dismissed,'close-setup-button',()=>overlay.getByRole('button',{name:'Close setup',exact:true}).click());
  const returning=path.join(root,'returning');await launch(returning);
  let setup;const deadline=Date.now()+30000;while(!setup&&Date.now()<deadline){setup=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(r=>setTimeout(r,100));}assert.ok(setup);
  await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  await (await app.firstWindow()).evaluate(()=>window.notchDesktop.updateDesktopTrayPreferences({macosEnabled:false,windowsCloseBehavior:'quit'}));
  await finish(returning,'just-completed-setup',quit);
  for(const delay of [0,100,350]){
    const oldLogs=new Set(await logs(returning));await launch(returning);await app.firstWindow();
    const until=Date.now()+10000;while(!await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()))&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
    if(delay)await new Promise(r=>setTimeout(r,delay));
    await finish(returning,'returning-'+delay,closeWindows,{previousLogCount:oldLogs.size});
  }
  for(const [kind,channel,method,options] of [
    ['application','external-application:list','listExternalApplications'],
    ['plugin','app-plugin:views-list','listAppPluginViews'],
    ['model','chat-composer-model:list','listChatComposerModels',{fetchStrategy:'live',executionHostKind:'local',workspaceDirectories:[]}],
  ])for(let n=0;n<2;n++){
    await launch(returning);
    await app.evaluate((_electron,channel)=>{const discovery=globalThis.__notchDiscovery,original=discovery.read.bind(discovery);globalThis.__slowDiscovery=false;discovery.read=(name,operation)=>original(name,async()=>{const selected=name===channel;if(selected)globalThis.__slowDiscovery=true;const result=await operation();if(selected)await new Promise(resolve=>setTimeout(resolve,4000));return result;});},channel);
    const page=await app.firstWindow();await page.waitForFunction(method=>typeof window.notchDesktop?.[method]==='function',method);
    await page.evaluate(({method,options})=>{window.__discoveryRequest=window.notchDesktop[method](options).catch(error=>({error:error.message}));},{method,options});
    const until=Date.now()+10000;while(!await app.evaluate(()=>globalThis.__slowDiscovery)&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
    assert.equal(await app.evaluate(()=>globalThis.__slowDiscovery),true);
    await finish(returning,'slow-'+kind+'-discovery-'+n,quit,{delayedDiscoveryMs:4000});
  }
  await launch(returning);const page=await app.firstWindow();await page.waitForFunction(()=>typeof window.notchDesktop?.listAppPluginViews==='function');
  const views=await page.evaluate(()=>window.notchDesktop.listAppPluginViews());assert.ok(views.length>0);assert.ok(views.every(v=>v.hostState==='running'));
  await finish(returning,'plugins-ready',closeWindows,{runningViews:views.length});
  await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,checks},null,2));console.log(JSON.stringify({passed:true,root,cases:checks.length,checks:checks.map(c=>({stage:c.stage,elapsedMs:c.elapsedMs,ownedProcesses:c.ownedProcesses}))}));
}catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,root,checks,error:error.stack},null,2));throw error;}finally{
  if(app){const child=app.process();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));
    if(child.exitCode===null)await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
  }
}
