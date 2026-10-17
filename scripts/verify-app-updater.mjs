import {_electron} from 'electron-qa';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {closeQaApp} from './process-tree.mjs';
const [executableArg,reportArg,installerArg,mode]=process.argv.slice(2),executable=path.resolve(executableArg),reportFile=path.resolve(reportArg);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-updater-qa-')),profile=path.join(root,'profile');
const report={passed:false,executable,root,checks:[],requests:[]};let app,page,server,corrupt=true;
async function waitPhase(phase){let state;const deadline=Date.now()+90000;while(Date.now()<deadline){state=await page.evaluate(()=>window.notchModels.updates());if(state.phase===phase)return state;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Expected updater ${phase}: ${JSON.stringify(state)}`);}
try{
 let fixture;
 if(mode!=='--public'){
  const installer=path.resolve(installerArg),name=path.basename(installer),version=/^notch-(\d+\.\d+\.\d+)-setup-x64\.exe$/.exec(name)?.[1];assert(version);
  const hash=createHash('sha512');for await(const bytes of createReadStream(installer))hash.update(bytes);
  const sha512=hash.digest('base64'),size=(await fs.stat(installer)).size;
  server=createServer((request,response)=>{
   const url=new URL(request.url,'http://127.0.0.1');report.requests.push(url.pathname);
   if(url.pathname==='/latest.yml'){response.setHeader('Content-Type','application/yaml');response.end(JSON.stringify({version,files:[{url:name,sha512:corrupt?Buffer.alloc(64,7).toString('base64'):sha512,size}],path:name,sha512,releaseDate:new Date().toISOString()}));}
   else if(url.pathname==='/'+name){response.setHeader('Content-Length',size);const stream=createReadStream(installer);stream.pipe(response);response.on('close',()=>stream.destroy());}
   else{response.statusCode=404;response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fixture={url:`http://127.0.0.1:${server.address().port}/`,root,version,sha512};
 }
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),timeout:45000});
 let setup;for(let i=0;i<200;i++){setup=app.windows().find(p=>p.url().includes('first-launch-onboarding-overlay'));if(setup)break;await new Promise(r=>setTimeout(r,100));}assert(setup);
 await setup.getByRole('button',{name:/^Continue/}).click();const setupClosed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await setupClosed;
 page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 report.installedVersion=await app.evaluate(({app})=>app.getVersion());
 if(fixture){
  await app.evaluate(async({app},fixture)=>{
   const {createRequire}=process.getBuiltinModule('module'),path=process.getBuiltinModule('path'),fs=process.getBuiltinModule('fs/promises');
   const require=createRequire(path.join(app.getAppPath(),'notch/src/app-bootstrap.mjs'));
   const {autoUpdater,NsisUpdater}=require('../vendor/notch-updater/index.cjs');
   const {createAppUpdater}=require('./app-updater.mjs');
   const config=path.join(fixture.root,'app-update.yml');await fs.writeFile(config,'updaterCacheDirName: notch-update-qa\n');
   const fakeApp={version:'0.0.1',name:'notch-update-qa',isPackaged:true,userDataPath:fixture.root,baseCachePath:path.join(fixture.root,'cache'),appUpdateConfigPath:config,whenReady:async()=>{},onQuit(){globalThis.__updateQuitHooks=(globalThis.__updateQuitHooks||0)+1;},quit(){globalThis.__updateQuitRequests=(globalThis.__updateQuitRequests||0)+1;}};
   const sdk=new NsisUpdater(null,fakeApp);sdk.httpExecutor=autoUpdater.httpExecutor;sdk.setFeedURL({provider:'generic',url:fixture.url});
   globalThis.__updateQaEvents=[];for(const name of ['checking-for-update','update-available','update-not-available','error','update-downloaded'])sdk.on(name,info=>globalThis.__updateQaEvents.push({name,detail:info instanceof Error?info.stack:info}));
   globalThis.__updateQaSdk=sdk;globalThis.__notchHost.updates.close();
   globalThis.__notchHost.updates=createAppUpdater({app:{...fakeApp,getVersion:()=>fakeApp.version},updater:sdk,directory:fixture.root,startupDelay:25});
  },fixture);
  await waitPhase('error');
  report.rejected=await app.evaluate(async()=>({status:await globalThis.__notchHost.updates.status(),events:globalThis.__updateQaEvents}));
  assert(report.rejected.events.some(e=>e.name==='error'&&/sha512|checksum/i.test(e.detail)),JSON.stringify(report.rejected));assert(report.requests.length>0);
  assert.equal(await app.evaluate(()=>globalThis.__updateQuitRequests||0),0);
  assert.equal(await app.evaluate(()=>!!globalThis.__updateQaSdk.installerPath),false);
  report.checks.push('Actual NSIS updater rejects an installer whose SHA-512 disagrees with the manifest; no install or quit.');
  corrupt=false;await page.evaluate(()=>window.notchModels.updates('check'));
  await waitPhase('ready');
  report.accepted=await app.evaluate(async()=>({status:await globalThis.__notchHost.updates.status(),events:globalThis.__updateQaEvents}));
  report.download=await app.evaluate(async()=>{const fs=process.getBuiltinModule('fs'),{createHash}=process.getBuiltinModule('crypto');const file=globalThis.__updateQaSdk.installerPath,hash=createHash('sha512');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return{file,sha512:hash.digest('base64'),quitHooks:globalThis.__updateQuitHooks,quitRequests:globalThis.__updateQuitRequests||0};});
  assert.equal(report.download.sha512,fixture.sha512);assert.equal(report.download.quitRequests,0);assert.equal(report.download.quitHooks,1);
  report.checks.push('Startup check and background download use the real updater, real local HTTP and exact installer bytes; checksum verified.');
 }else{
  report.status=await page.evaluate(()=>window.notchModels.updates('check'));assert.equal(report.status.phase,'current',JSON.stringify(report.status));
  report.checks.push('Packaged GitHub provider reads the public latest stable manifest and reports no newer update.');
 }
 await page.getByRole('button',{name:'Open user menu',exact:true}).first().click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
 const settings=page.getByRole('region',{name:'Updates',exact:true});await settings.waitFor();
 await app.evaluate(({BrowserWindow},url)=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);window.unmaximize();window.setBounds({x:40,y:40,width:1000,height:700});},page.url());
 for(const dark of [false,true]){const toggle=page.getByRole('switch',{name:'Dark appearance',exact:true});if((await toggle.getAttribute('aria-checked')==='true')!==dark)await toggle.click();await settings.scrollIntoViewIfNeeded();const checkbox=settings.getByRole('checkbox',{name:'Automatic updates'});assert((await checkbox.boundingBox()).width<=24);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:reportFile.replace('.json',dark?'-dark.png':'-light.png')});}
 if(fixture){await settings.getByRole('button',{name:'Quit and install',exact:true}).click();assert.equal(await app.evaluate(()=>globalThis.__updateQuitRequests),1);report.checks.push('Settings display progress/ready state and Quit and install delegates to the normal application quit flow.');}
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(()=>{if(globalThis.__updateQaSdk)globalThis.__updateQaSdk.autoInstallOnAppQuit=false;globalThis.__notchHost.updates?.close();}).catch(()=>{});await closeQaApp(app);}if(server)await new Promise(resolve=>server.close(resolve));await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));}
