import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-download-close-'));
let app,pull,disconnected=false,before,children=[];const checks={};
const server=createServer((request,response)=>{
 request.resume();
 if(request.url==='/api/pull'){pull=response;response.writeHead(200,{'content-type':'application/x-ndjson'});response.write(JSON.stringify({status:'pulling test weights',total:100000000,completed:1000000})+'\n');response.on('close',()=>{disconnected=true;});return;}
 response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/api/version'?{version:'0.40.3'}:{models:[]}));
});
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),OLLAMA_HOST:'http://127.0.0.1:11436'};
async function waitFor(operation,label,timeout=30000){const until=Date.now()+timeout;while(Date.now()<until){if(await operation())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label);}
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(11436,'127.0.0.1',resolve);});
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${root}`],env,timeout:45000});
 let setup;await waitFor(()=>{setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));return setup;},'Setup missing');await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;const page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 await page.evaluate(()=>window.notchModels.install('unsloth/Qwen3-0.6B-GGUF','ollama'));
 await waitFor(()=>!!pull,'The real CLI did not start its pull');
 children=await app.evaluate(()=>process._getActiveHandles().filter(handle=>handle.spawnargs?.includes('models')&&handle.spawnargs.includes('install')).map(handle=>handle.pid));assert.ok(children.length);
 before=await processSnapshot();checks.activeDownloader=children;
 const started=Date.now(),child=app.process(),exit=new Promise(resolve=>child.once('exit',resolve));await app.evaluate(({app})=>{setImmediate(()=>app.quit());});let timer;await Promise.race([exit,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('IDE did not quit')),15000)})]).finally(()=>clearTimeout(timer));app=null;checks.ideClosedMs=Date.now()-started;
 await waitFor(async()=>{const live=await processSnapshot();return !live.some(row=>children.includes(row.ProcessId)&&before.some(old=>old.ProcessId===row.ProcessId&&old.CreationDate===row.CreationDate));},'Downloader survived the IDE quitting',8000);
 assert.equal(disconnected,true,'The pending runtime pull must be disconnected');checks.downloaderExited=true;checks.pullDisconnected=true;
 await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,root,checks,method:'Real packaged CLI child and IDE quit; loopback runtime holds a pull open to make shutdown ownership deterministic. No model inference.'},null,2));console.log(JSON.stringify({passed:true,checks}));
}catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,root,checks,error:error.stack,disconnected},null,2));throw error;}
finally{
 if(app){const child=app.process(),snapshot=await processSnapshot();await app.close().catch(()=>{});await stopOwnedProcesses(child.pid,snapshot);}
 if(before)for(const pid of children)await stopOwnedProcesses(pid,before);
 pull?.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
