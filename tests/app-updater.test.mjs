import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAppUpdater} from '../src/app-updater.mjs';
import {registerModelIpc,modelPreload,patchModelPreload} from '../src/model-ipc.mjs';

async function fixture(options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-update-test-'));
 const updater=new EventEmitter();let checks=0,quits=0,downloads=0;
 updater.checkForUpdates=async()=>{checks++;updater.emit('checking-for-update');updater.emit('update-not-available');return{};};
 updater.downloadUpdate=async()=>{downloads++;updater.emit('download-progress',{percent:50});updater.emit('update-downloaded',{version:'0.1.19'});};
 updater.quitAndInstall=()=>{throw new Error('Must not force installation before the normal quit/save flow.');};
 const app={isPackaged:true,getVersion:()=> '0.1.18',quit(){quits++;}};
 if(options.automatic===false)await fs.writeFile(path.join(directory,'app-updates.json'),'{"automatic":false}');
 const service=createAppUpdater({app,updater,directory,platform:'win32',arch:'x64',startupDelay:10,...options});
 await service.status();return{service,app,updater,directory,get checks(){return checks;},get quits(){return quits;},get downloads(){return downloads;}};
}
test('installed Windows checks once on startup, downloads automatically and retains work until normal quit',async()=>{
 const f=await fixture();try{
  await new Promise(r=>setTimeout(r,30));assert.equal(f.checks,1);
  assert.equal(f.updater.autoDownload,true);assert.equal(f.updater.autoInstallOnAppQuit,true);
  assert.equal(f.updater.allowDowngrade,false);assert.equal(f.updater.allowPrerelease,false);assert.equal(f.updater.disableDifferentialDownload,true);
  f.updater.emit('update-available',{version:'0.1.19'});f.updater.emit('download-progress',{percent:103});assert.equal((await f.service.status()).progress,100);
  f.updater.emit('update-downloaded',{version:'0.1.19'});assert.equal((await f.service.status()).phase,'ready');assert.equal(f.quits,0);
  await f.service.quit();assert.equal(f.quits,1);
 }finally{f.service.close();}
});
test('opt out persists, manual checks/downloads work and errors keep the current version usable',async()=>{
 const f=await fixture({automatic:false});try{
  await new Promise(r=>setTimeout(r,25));assert.equal(f.checks,0);
  assert.equal(f.updater.autoDownload,false);await f.service.check();assert.equal(f.checks,1);
  await assert.rejects(f.service.automatic('yes'),/enabled/);await assert.rejects(f.service.quit(),/Download/);
  f.updater.emit('update-available',{version:'0.1.19'});await f.service.download();assert.equal(f.downloads,1);assert.equal((await f.service.status()).phase,'ready');
  await f.service.automatic(false);assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'app-updates.json'))).automatic,false);
  f.updater.emit('error',new Error('offline'));assert.equal((await f.service.status()).phase,'error');assert.equal((await f.service.status()).currentVersion,'0.1.18');assert.equal(f.quits,0);
  f.updater.checkForUpdates=async()=>{throw Error('offline');};await f.service.check();assert.equal((await f.service.status()).phase,'error');
 }finally{f.service.close();}
});
test('shutdown defers installation and closing during startup cancels the startup check',async()=>{
 const f=await fixture();f.service.close();await new Promise(r=>setTimeout(r,25));assert.equal(f.checks,0);
 f.updater.emit('update-downloaded',{version:'0.1.19'});f.service.deferForShutdown();assert.equal(f.updater.autoInstallOnAppQuit,false);assert.match((await f.service.status()).message,/later launch/);assert.equal(f.quits,0);
 await f.service.automatic(true);assert.equal(f.updater.autoInstallOnAppQuit,false);assert.equal(f.checks,0);
});
test('a Windows shutdown before preference loading cannot re-enable an install or startup download',async()=>{
 const updater=new EventEmitter(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-update-shutdown-'));
 const service=createAppUpdater({app:{isPackaged:true,getVersion:()=> '0.1.18'},updater,directory,platform:'win32',arch:'x64',startupDelay:0});
 service.deferForShutdown();service.close();await service.status();assert.equal(updater.autoDownload,false);assert.equal(updater.autoInstallOnAppQuit,false);
});
test('test profiles and unsupported targets never auto-download or install',async()=>{
 for(const options of [{profileOverride:true},{platform:'linux'},{app:{isPackaged:true,getVersion:()=> '0.1.18-preview.1'}}]){
  const f=await fixture(options);try{await new Promise(r=>setTimeout(r,25));assert.equal(f.checks,0);assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);await assert.rejects(f.service.download(),/installed application/);assert.equal((await f.service.status()).canInstall,false);}finally{f.service.close();}
 }
});
test('overlapping manual checks share one network operation',async()=>{
 const f=await fixture({automatic:false});let finish,calls=0;f.updater.checkForUpdates=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 try{const first=f.service.check(),second=f.service.check();await new Promise(r=>setImmediate(r));assert.equal(calls,1);finish({});await Promise.all([first,second]);}finally{f.service.close();}
});
test('update IPC accepts only primary-window actions and repairs the previous preload',async()=>{
 const calls=[],handlers=new Map(),updates={status:()=>({phase:'current'}),automatic:value=>{calls.push(value);}};
 registerModelIpc({handle:(key,fn)=>handlers.set(key,fn)},{modelManager:{},updates});
 const primary={url:'notch-app://renderer/index.html'},event={senderFrame:primary,sender:{mainFrame:primary}},handle=handlers.get('notch-models:updates');
 assert.deepEqual(handle(event),{phase:'current'});handle(event,'automatic',false);assert.deepEqual(calls,[false]);
 assert.throws(()=>handle(event,'shell'),/supported update/);
 const secondary={url:'notch-app://renderer/index.html?surface=live-voice-overlay'};assert.throws(()=>handle({senderFrame:secondary,sender:{mainFrame:secondary}},'quit'),/primary/);
 const previous=modelPreload.replace("\n  updates:(action,value)=>ipcRenderer.invoke('notch-models:updates',action,value),",'');
 assert.equal(patchModelPreload(previous),modelPreload);assert.equal(patchModelPreload(modelPreload),modelPreload);
});
