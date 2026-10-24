import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {_electron} from 'electron-qa';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),directory=path.resolve(process.argv[3]||'analysis/strata-lifecycle');
const provider=process.argv[4]||'strata';assert(['strata','colibri'].includes(provider));
const title=provider==='colibri'?'Colibri':'Strata';
const root=path.join(os.homedir(),'.notch/runtimes',provider),runtime=path.join(root,provider==='colibri'?'v2.0.0':'control-0.1.47');
const python=path.join(os.homedir(),'.notch/runtimes/strata/control-0.1.47/python/python.exe');
await fs.mkdir(directory,{recursive:true});const work=await fs.mkdtemp(path.join(directory,'isolated-'));
for(const name of ['home','local','roaming','profiles','instances','components','models','temp'])await fs.mkdir(path.join(work,name));
const userProfile=path.join(os.homedir(),'AppData/Roaming/com.freesyntax.notch.desktop');
const protectedFiles=[path.join(root,'preferences.json'),path.join(root,'selected.json'),path.join(root,'state/setup.json'),path.join(root,'verified-model.json'),...['main.sqlite','main.sqlite-wal','notch-data.v1.json','notch-data.v1.ext.json','model-context.json','huggingface-browser.json','openrouter-models.json','Preferences'].map(file=>path.join(userProfile,file))];
const digest=async file=>{try{return createHash('sha256').update(await fs.readFile(file)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const before=await Promise.all(protectedFiles.map(digest));
const ready=path.join(directory,'ready'),stop=path.join(directory,'stop'),consoleFile=path.join(directory,'consoles.json');
for(const file of [ready,stop])await fs.rm(file,{force:true});
let observerFailure;
const observer=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(import.meta.dirname,'observe-consoles.ps1'),ready,consoleFile,stop],{windowsHide:true,stdio:'ignore'}),observed=new Promise(resolve=>{observer.once('exit',resolve);observer.once('error',error=>{observerFailure=error;resolve(-1);});});
async function wait(check,label,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out: '+label);}
const report={passed:false,provider,realControlRuntime:provider==='colibri'?'2.0.0':'0.1.47',realSupervisor:true,realHttpServer:true,fakeEngine:true,modelDownloads:false,benchmarks:false,checks:[],errors:[],work,softwareRendering:process.env.NOTCH_QA_SOFTWARE_RENDERING==='1'};
const record=message=>{report.checks.push(message);console.log(message);};
let app,page,controller,server,ownerPid,controllerExit,controllerConsole,controllerFailure;let stderr='';
async function closeTestApp(){
 if(!app)return;
 const target=app,child=target.process(),pid=ownerPid||child.pid,before=await processSnapshot();
 let timer;
 try{await Promise.race([target.close().catch(()=>{}),new Promise(resolve=>timer=setTimeout(resolve,10000))]);}
 finally{clearTimeout(timer);await stopOwnedProcesses(pid,before);app=null;}
}
const requests=new Map();let next=0,controllerReady=false;
function call(op,extra={}){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{requests.delete(id);reject(Error('Strata fixture command timed out: '+op));},120000);requests.set(id,{resolve,reject,timer});controller.stdin.write(JSON.stringify({id,op,...extra})+'\n');});}
try{
 await wait(async()=>{if(observerFailure)throw observerFailure;try{await fs.access(ready);return true;}catch{return false;}},'console observer',60000);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|^STRATA_|^PYTHON/i.test(key))),PYTHONPATH:[path.join(root,'python-hooks'),runtime].join(path.delimiter),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',TEMP:path.join(work,'temp'),TMP:path.join(work,'temp'),LOCALAPPDATA:path.join(work,'local'),APPDATA:path.join(work,'roaming'),STRATA_PROFILE_DIR:path.join(work,'profiles'),STRATA_RUNTIME_DIR:path.join(work,'instances'),STRATA_COMPONENTS_DIR:path.join(work,'components'),STRATA_INSTALL_DIR:path.join(work,'models'),STRATA_SETTINGS_FILE:path.join(work,'settings.json'),STRATA_API_KEY:'none',STRATA_NO_ACQUIRE:'1',COLI_SETUP_HOME:path.join(work,'colibri-state'),COLI_COLOR:'0'};
 controller=spawn(python,[path.resolve(import.meta.dirname,`../tests/fixtures/${provider}-lifecycle.py`),work],{cwd:runtime,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 controller.on('error',error=>controllerFailure=error);
 controller.stderr.on('data',data=>stderr=(stderr+data).slice(-100000));
 controllerExit=new Promise(resolve=>controller.once('exit',code=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(Error('Strata fixture exited '+code+': '+stderr));}requests.clear();resolve(code);}));
 readline.createInterface({input:controller.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{stderr+='\n'+line;return;}if(message.ready){controllerConsole=message.console;controllerReady=true;return;}const request=requests.get(message.id);if(request){clearTimeout(request.timer);requests.delete(message.id);message.error?request.reject(Error(message.error)):request.resolve(message.value);}});
 await wait(()=>{if(controllerFailure)throw controllerFailure;return controllerReady;},'real Strata fixture initialization',30000);assert.equal(controllerConsole,0);
 const token=randomUUID();server=http.createServer(async(request,response)=>{
  try{if(request.headers.authorization!==token)throw Error('Wrong fixture token');let body='';for await(const chunk of request){body+=chunk;if(body.length>8192)throw Error('Oversized fixture request');}const data=JSON.parse(body);const value=await call(data.op,data);response.setHeader('content-type','application/json');response.end(JSON.stringify({value}));}
  catch(error){response.setHeader('content-type','application/json');response.end(JSON.stringify({error:error.message}));}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const profile=path.join(work,'profile');app=await _electron.launch({executablePath:executable,args:['--user-data-dir='+profile,...(process.env.NOTCH_QA_SOFTWARE_RENDERING==='1'?['--disable-gpu','--notch-windows-startup-compatibility']:[])],timeout:60000});ownerPid=await app.evaluate(()=>process.pid);
 await app.evaluate(async({app},{origin,token,ownerPid,provider,title})=>{
  const path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));
  const {createLocalModelLifecycle}=require(path.join(app.getAppPath(),'notch/src/local-model-lifecycle.mjs'));
  const {withLocalInference}=require(path.join(app.getAppPath(),'notch/vendor/notch-core/desktop-harness.js'));
  const control=async(op,extra={})=>{const body=await(await fetch(origin,{method:'POST',headers:{authorization:token,'content-type':'application/json'},body:JSON.stringify({op,...extra})})).json();if(body.error)throw Error(body.error);return body.value;};
  const state=globalThis.__strataLifecycleQA={status:{running:false},control};
  const status=async()=>state.status=await control('status');
  const rows=()=>['alpha','beta'].map(id=>({key:provider+'/'+id,provider,displayName:title+' fixture '+id,source:'system',enabled:true,running:state.status.running&&state.status.selected.id===id,isDefault:id==='alpha',isNew:false,priceFactor:0,tags:['local'],tools:true,bytes:1024,maxInputTokens:8192,maxOutputTokens:2048,availableContextWindows:[8192],defaultContextWindow:8192,recommendedContextWindow:8192,efforts:[],defaultEffort:null,supportsDisabled:true}));
  const runtime={withLocalInference,colibriStatus:async()=>({running:false}),strataStatus:async()=>({running:false}),loadedMlxModel:()=>null,[provider+'Status']:status,['start'+title]:async id=>{state.status=await control('start',{model:id,ownerPid});},['stop'+title]:async()=>{state.status=await control('stop');}};
  const lifecycle=state.lifecycle=createLocalModelLifecycle({runtime,fetcher:async()=>{throw Error('Real Ollama endpoints are excluded from this Strata-only test');},catalog:async()=>rows(),endpoint:()=>undefined,context:()=>8192,assertIdle:()=>{}});
  const host=globalThis.__notchHost;host.listModels=async()=>{await status();return rows();};host.getCachedModels=rows;host.getDefaultModel=()=> provider+'/alpha';host.getModelDiscoveryWarning=()=>null;host.resolveModelChoice=key=>key||provider+'/alpha';host.localModelChange=(action,key)=>lifecycle.change(action,key);
 },{origin,token,ownerPid,provider,title});
 let setup;await wait(()=>{setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));return !!setup;},'onboarding');await setup.getByRole('button',{name:/^Continue/}).click({timeout:90000});const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('link',{name:'New Task Ctrl+N',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByRole('link',{name:'New Task Ctrl+N',exact:true}).click();await page.getByRole('textbox',{name:'New Task',exact:true}).waitFor();
 const dialog=page.getByRole('dialog',{name:'Choose a model',exact:true}),dots=page.locator('[data-chat-composer-model-loading]'),banner=page.locator('[data-chat-composer-status-banner]');
 const menu=async()=>{if(!await dialog.isVisible())await page.getByRole('button',{name:'Model',exact:true}).click();await dialog.waitFor();};
 const row=id=>page.locator(`[role=option][title="${provider}/${id}"]`);
 async function load(id){await menu();await row(id).click();await dots.waitFor();assert.equal(await dots.locator('span').count(),3);assert(!/unavailable/i.test(await banner.allTextContents().then(text=>text.join(' '))));await wait(async()=>!await dots.count()&&!await dialog.isVisible(),'real Strata '+id+' ready');const current=await call('status');assert(current.running&&current.selected.id===id);return current;}
 await menu();await row('alpha').click();await dots.waitFor();
 const concurrent=await app.evaluate(async(_,provider)=>{try{await globalThis.__notchHost.localModelChange('mount',provider+'/beta');return null;}catch(error){return error.message;}},provider);assert.match(concurrent,/already loading or ejecting/);await wait(async()=>!await dots.count()&&!await dialog.isVisible(),'initial real launch');assert((await call('status')).running);record('Real supervised launch and rejection of a simultaneous second mount');
 await menu();await page.getByRole('button',{name:`Eject ${title} fixture alpha`,exact:true}).click();await dots.waitFor();await wait(async()=>!await dots.count(),'real eject');assert.equal((await call('status')).running,false);assert((await call('evidence')).engines.every(engine=>!engine.alive));record('Eject clears loading and ends the real fake-engine process');
 await load('alpha');await load('beta');await load('alpha');record('Remount and both-direction switching release the preceding process before starting the next');
 if(provider==='strata'){assert((await call('stale-stop')).rejected);record('Stale instance eject is rejected without stopping the current model');}
 await call('fail',{model:'beta',enabled:true});await menu();await row('beta').click();await dots.waitFor();await page.getByRole('alert').filter({hasText:new RegExp(title+' test engine failed')}).waitFor({timeout:90000});await wait(async()=>!await dots.count(),'failed start clears dots');assert.equal((await call('status')).running,false);assert.equal(await row('beta').isDisabled(),false);
 await call('fail',{model:'beta',enabled:false});await load('beta');record('Actual failed engine startup clears loading, retains its error and supports a successful retry');
 if(provider==='colibri'){await menu();await page.getByRole('button',{name:'Eject Colibri fixture beta',exact:true}).click();await wait(async()=>!await dots.count()&&!(await call('status')).running,'final Colibri eject');}
 await app.close();app=null;await wait(async()=>{try{return !(await call('status')).running;}catch(error){if(/runtime control is unavailable/.test(error.message))return false;throw error;}},'owner exit stops real Strata server',30000);await wait(async()=>(await call('evidence')).engines.every(engine=>!engine.alive),'owner exit ends engine process',30000);record(provider==='strata'?'Closing Notch ends its owned Strata runtime and engine':'Final Colibri eject releases every engine before the isolated app closes');
 report.evidence=await call('evidence');assert(report.evidence.engines.every(engine=>engine.console===0));assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(page)report.visibleText=await page.locator('body').innerText().catch(()=>null);}
finally{
 if(controllerReady)await wait(async()=>{try{await call('stop');return true;}catch(error){if(/runtime control is unavailable/.test(error.message))return false;throw error;}},'test runtime cleanup',30000).catch(error=>{report.cleanupError=error.message;report.passed=false;process.exitCode=1;});
 if(app)await closeTestApp().catch(error=>{report.cleanupError=error.message;report.passed=false;process.exitCode=1;});
 if(server)await new Promise(resolve=>server.close(resolve));
 if(controller){controller.stdin.end();let timer;try{await Promise.race([controllerExit,new Promise(resolve=>timer=setTimeout(()=>{controller.kill();resolve();},10000))]);}finally{clearTimeout(timer);}}
 await fs.writeFile(path.join(directory,'controller.log'),stderr);await fs.writeFile(stop,'stop');const observerTimer=setTimeout(()=>observer.kill(),60000);try{await observed;}finally{clearTimeout(observerTimer);}
 const consoles=JSON.parse(await fs.readFile(consoleFile,'utf8').catch(()=>'{"VisibleConsoles":null,"Processes":[]}'));report.visibleConsoles=consoles.VisibleConsoles;report.processCount=consoles.Processes.length;if(!Array.isArray(report.visibleConsoles)||report.visibleConsoles.length){report.passed=false;process.exitCode=1;}
 try{assert.deepEqual(await Promise.all(protectedFiles.map(digest)),before);report.settingsAndChatsUnchanged=true;}catch(error){report.passed=false;report.preservationError=error.message;process.exitCode=1;}
 await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
