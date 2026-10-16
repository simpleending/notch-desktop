import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-renderer-quit-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),checks=[];let app;
const trace=[];
const collect=message=>{const text=message.text(),prefix='NOTCH_SHUTDOWN_TRACE ';if(text.startsWith(prefix))trace.push(JSON.parse(text.slice(prefix.length)));};
async function launch(profile){app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});app.on('console',collect);app.on('window',page=>page.on('console',collect));const page=await app.firstWindow();page.on('console',collect);return page;}
async function exit(){const child=app.process(),ended=new Promise(resolve=>child.once('exit',code=>resolve(code)));await app.evaluate(({app})=>{setImmediate(()=>app.quit())});let timer;const code=await Promise.race([ended,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Renderer shutdown exceeded global test deadline')),15000)})]).finally(()=>clearTimeout(timer));app=null;assert.equal(code,0);}
try{
  const seed=path.join(root,'seed');await launch(seed);let setup;const until=Date.now()+30000;while(!setup&&Date.now()<until){setup=app.windows().find(w=>w.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(setup);
  await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;await(app.windows().find(w=>!w.url().includes('surface='))).locator('.notch-welcome').waitFor();await app.close();app=null;
  for(const kind of ['pending-startup-read','busy-renderer']){
    const profile=path.join(root,kind);await fs.cp(seed,profile,{recursive:true});const page=await launch(profile);await page.locator('.notch-welcome').waitFor();trace.length=0;
    await app.evaluate(({BrowserWindow,ipcMain},kind)=>{
      const emit=row=>console.info('NOTCH_SHUTDOWN_TRACE '+JSON.stringify({...row,at:Date.now()}));
      const discovery=globalThis.__notchDiscovery;globalThis.__heldReadStarted=false;globalThis.__heldReadSettled=false;
      if(kind==='pending-startup-read'){const read=discovery.read.bind(discovery);discovery.read=(channel,operation)=>read(channel,channel==='app-plugin:views-list'?()=>{globalThis.__heldReadStarted=true;return new Promise(()=>{})}:operation).then(value=>{if(channel==='app-plugin:views-list'){globalThis.__heldReadSettled=true;emit({phase:'read-settled'})}return value});}
      for(const window of BrowserWindow.getAllWindows()){const send=window.webContents.send.bind(window.webContents);window.webContents.send=(channel,...args)=>{if(channel==='workbench:will-shutdown')emit({phase:'send',requestId:args[0].requestId,discoveryAborted:discovery.signal.aborted,readSettled:globalThis.__heldReadSettled});return send(channel,...args);};}
      const handler=ipcMain._invokeHandlers.get('workbench:shutdown-ready');if(typeof handler!=='function')throw Error('Missing native shutdown ACK handler');
      ipcMain._invokeHandlers.set('workbench:shutdown-ready',(...args)=>{emit({phase:'ack',requestId:args[1]});return handler(...args)});
    },kind);
    if(kind==='pending-startup-read'){
      await page.evaluate(()=>{window.__heldRead=window.notchDesktop.listAppPluginViews().catch(error=>({error:error.message}));});
      const deadline=Date.now()+10000;while(!await app.evaluate(()=>globalThis.__heldReadStarted)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(await app.evaluate(()=>globalThis.__heldReadStarted),true);
    }else{
      const started=page.waitForEvent('console',{predicate:message=>message.text().includes('NOTCH_SHUTDOWN_TRACE {"phase":"busy-start"')});
      await page.evaluate(()=>{setTimeout(()=>{console.warn('NOTCH_SHUTDOWN_TRACE '+JSON.stringify({phase:'busy-start',at:Date.now()}));const until=Date.now()+1500;while(Date.now()<until){}console.warn('NOTCH_SHUTDOWN_TRACE '+JSON.stringify({phase:'busy-end',at:Date.now()}));},0)});await started;
    }
    await exit();const sent=trace.find(row=>row.phase==='send'),ack=trace.find(row=>row.phase==='ack'&&row.requestId===sent?.requestId);assert.ok(sent);assert.ok(ack,'The real renderer must acknowledge shutdown');
    if(kind==='pending-startup-read'){assert.equal(sent.discoveryAborted,true);assert.equal(sent.readSettled,true,'Optional startup IPC must settle before renderer teardown');}
    const logs=(await fs.readdir(path.join(profile,'logs'),{recursive:true})).filter(file=>path.basename(file)==='main.log');const lines=(await Promise.all(logs.map(file=>fs.readFile(path.join(profile,'logs',file),'utf8')))).flatMap(text=>text.split(/\r?\n/));
    assert.deepEqual(lines.filter(line=>/\[ERROR\]|renderer quiesce timed out/.test(line)),[]);
    checks.push({kind,ackElapsedMs:ack.at-sent.at,trace:[...trace]});
  }
  await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,checks},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,root,checks,trace,error:error.stack},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();await stopOwnedProcesses(child.pid,before);}}
