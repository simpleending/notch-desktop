import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {processSnapshot,ownedProcessIds,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),runtime=path.resolve(process.argv[3]),reportFile=path.resolve(process.argv[4]);
const repo='unsloth/Qwen3-0.6B-GGUF',model=`hf.co/${repo}:Q4_K_M`,origin='http://127.0.0.1:11436';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-live-download-')),profile=path.join(root,'profile'),models=path.join(root,'models'),workspace=path.join(root,'project');
await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'README.md'),'Local download verification workspace.');
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),OLLAMA_HOST:origin,OLLAMA_MODELS:models,OLLAMA_VULKAN:'true',OLLAMA_NO_CLOUD:'true'};
const checks={},stages=[],errors=[];let daemon,daemonSnapshot,app,page,sessionId;
console.log(JSON.stringify({root,phase:'starting isolated live verification'}));
async function waitFor(fn,message,timeout=45000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(message);}
async function status(){return app.evaluate(async()=>globalThis.__notchHost.modelManager.status());}
async function jobAt(state,timeout=45000){return waitFor(async()=>{const {job}=await status();if(job?.message&&stages.at(-1)!==job.message){stages.push(job.message);console.log(JSON.stringify(job));}return job?.state===state?job:false;},`Download did not reach ${state}`,timeout);}
async function startDaemon(){
 await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(11436,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()));});
 daemon=spawn(runtime,['serve'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});daemon.on('error',error=>errors.push(error.message));
 daemon.stdout.on('data',chunk=>void fs.appendFile(path.join(root,'ollama.log'),chunk));daemon.stderr.on('data',chunk=>void fs.appendFile(path.join(root,'ollama.log'),chunk));
 await waitFor(()=>fetch(origin+'/api/version',{signal:AbortSignal.timeout(500)}).then(response=>response.ok).catch(()=>false),'Isolated Ollama did not start');daemonSnapshot=await processSnapshot();
}
async function stopDaemon(){if(!daemon)return;const current=await processSnapshot(),birth=daemonSnapshot.find(row=>row.ProcessId===daemon.pid);if(current.some(row=>row.ProcessId===birth?.ProcessId&&row.CreationDate===birth.CreationDate))await stopOwnedProcesses(daemon.pid,current);daemon=null;}
async function launch(){
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
}
async function chooseHub(){await page.getByRole('button',{name:'Model',exact:true}).click();const tab=page.getByRole('tab',{name:'Hugging Face',exact:true});if(await tab.getAttribute('aria-selected')!=='true')await tab.click();}
async function beginInstall(){const row=page.getByRole('option',{name:`Download ${repo}`,exact:true});await row.waitFor({timeout:60000});await row.click();await page.getByRole('button',{name:'Download model',exact:true}).click();}
async function installChildren(){return app.evaluate(()=>process._getActiveHandles().filter(handle=>handle.spawnargs?.includes('models')&&handle.spawnargs.includes('install')).map(handle=>({pid:handle.pid,args:handle.spawnargs})));}
async function closeApp(){const child=app.process(),before=await processSnapshot(),owned=ownedProcessIds(child.pid,before);await app.close();app=null;await waitFor(async()=>{const live=await processSnapshot();return !live.some(row=>owned.has(row.ProcessId)&&before.some(old=>old.ProcessId===row.ProcessId&&old.CreationDate===row.CreationDate));},'IDE or its download child survived shutdown',15000);}
try{
 await startDaemon();assert.deepEqual((await(await fetch(origin+'/api/tags')).json()).models,[]);checks.emptyIsolatedCache=true;
 await launch();let setup;await waitFor(()=>{setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));return setup;},'Setup did not open');await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();page.setDefaultTimeout(30000);await page.locator('.notch-welcome').waitFor();
 await app.evaluate(({BrowserWindow},url)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);window.unmaximize();window.setBounds({x:40,y:40,width:1000,height:700});},page.url());
 await chooseHub();const dismiss=page.getByRole('button',{name:'Not now',exact:true});if(await dismiss.count())await dismiss.click();await page.getByRole('searchbox',{name:'Search models'}).fill(repo);await beginInstall();
 await waitFor(async()=>{const {job}=await status();return job?.state==='running'&&Number.isFinite(job.percent);},'A fresh download did not expose progress',120000);
 checks.freshDownloadProgress=true;checks.downloadChildStarted=await installChildren();assert.ok(checks.downloadChildStarted.length,JSON.stringify(await status()));
 await page.keyboard.press('Escape');await chooseHub();await page.getByRole('progressbar',{name:'Model download progress'}).waitFor();checks.reopenRetainsProgress=true;
 await page.getByRole('button',{name:'Cancel download',exact:true}).click();await jobAt('cancelled');await waitFor(async()=>!(await installChildren()).length,'Cancelled CLI child survived');checks.realCancellation=true;
 const partialFiles=await fs.readdir(path.join(models,'blobs'));assert.ok(partialFiles.length>0);checks.partialCacheRetained=true;
 await stopDaemon();await beginInstall();await jobAt('failed');await page.getByRole('alert').filter({hasText:/Start Ollama|offline|connect/i}).waitFor();checks.runtimeOfflineErrorVisible=true;
 await startDaemon();await beginInstall();await jobAt('complete',300000);await page.getByRole('button',{name:'Show installed models',exact:true}).click();
 const option=page.locator(`[role=option][title="ollama/${model}"]`);await option.waitFor({timeout:45000});await option.click({timeout:45000});await page.locator('.notch-model-picker').waitFor({state:'hidden'});checks.retryCompletesAndSelects=true;
 assert.deepEqual((await(await fetch(origin+'/api/ps')).json()).models,[]);checks.installProbeUnloaded=true;assert.deepEqual(await installChildren(),[]);
 await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('combobox',{name:'Context limit'}).selectOption('8192');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},workspace);
 await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('download verification');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await app.evaluate(()=>{const host=globalThis.__notchHost,query=host.query.bind(host);globalThis.__downloadChat=[];host.query=request=>{const result=query(request),emit=result.emit.bind(result);result.emit=event=>{if(event.type==='result')globalThis.__downloadChat.push({...event,model:result.model});return emit(event);};return result;};});
 const composer=page.locator('[contenteditable=true][role=textbox]').first();await composer.fill('Reply with exactly READY.');await composer.press('Enter');
 const result=await waitFor(async()=>app.evaluate(()=>globalThis.__downloadChat.at(-1)),'First model chat did not finish',180000);assert.equal(result.subtype,'success',JSON.stringify(result));assert.equal(result.model,`ollama/${model}`);assert.match(result.result,/READY/);sessionId=result.session_id;checks.firstRealChat={model:result.model,result:result.result};
 await page.screenshot({path:reportFile.replace('.json','.png')});await closeApp();await launch();page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');const reopened=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);await page.getByText(reopened.summary.title,{exact:true}).first().click();await page.locator('[data-message-kind="assistant"]').filter({hasText:'READY'}).first().waitFor({timeout:30000});
 const saved=await fs.readFile(path.join(profile,'notch-sessions',sessionId+'.json'),'utf8');assert.ok(saved.includes('READY'));checks.chatSurvivesRestart=true;await closeApp();checks.cleanShutdown=true;
 await fetch(origin+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,keep_alive:0,stream:false}),signal:AbortSignal.timeout(15000)});assert.deepEqual((await(await fetch(origin+'/api/ps')).json()).models,[]);checks.finalModelsUnloaded=true;
 assert.deepEqual(errors,[]);await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,repo,sessionId,checks,stages,errors,method:'Isolated real Ollama and empty model cache; public HF download; real UI cancellation, stopped-runtime failure, retry, model selection and first chat; no provider inference mocks.'},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed:false,root,checks,stages,error:error.stack,errors},null,2));throw error;}
finally{
 if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));await stopOwnedProcesses(child.pid,before);}
 if(daemon)await fetch(origin+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,keep_alive:0,stream:false}),signal:AbortSignal.timeout(10000)}).catch(()=>{});await stopDaemon();
}
