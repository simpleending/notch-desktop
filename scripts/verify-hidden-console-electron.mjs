import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron} from 'electron-qa';

const executable=path.resolve(process.argv[2]),helper=path.resolve(process.argv[3]||`vendor/notch-core/native/notch-console-win32-${process.arch}.exe`),directory=path.resolve(process.argv[4]||'analysis/hidden-console-electron');
const runtime=path.join(os.homedir(),'.notch/runtimes/ollama'),{tag}=JSON.parse(await fs.readFile(path.join(runtime,'installed.json'),'utf8'));
assert.match(tag,/^v\d+\.\d+\.\d+$/);const ollama=path.join(runtime,tag,'ollama.exe');
await fs.mkdir(directory,{recursive:true});
const ready=path.join(directory,'ready'),stop=path.join(directory,'stop'),observations=path.join(directory,'consoles.json');
for(const file of [ready,stop])await fs.rm(file,{force:true});
const observer=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(import.meta.dirname,'observe-consoles.ps1'),ready,observations,stop],{windowsHide:true,stdio:'ignore'}),observed=new Promise(resolve=>observer.once('exit',resolve));
const wait=async(fn,label,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out: '+label);};
await wait(async()=>{try{await fs.access(ready);return true;}catch{return false;}},'console observer');
const report={passed:false,benchmarks:false,downloads:false,checks:[]};let app,host;
try{
  for(const stdio of ['ignore','file']){
    await assert.rejects(fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(500)}));
    const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-console-electron-'));
    app=await _electron.launch({executablePath:executable,args:['--user-data-dir='+profile],timeout:60000});await app.firstWindow();
    await app.evaluate(async()=>await globalThis.__notchHost.runtimeReady);
    const appPid=await app.evaluate(()=>process.pid),log=path.join(directory,'server-'+stdio+'.log');
    await app.evaluate((_,{helper,ollama,log,stdio})=>{
      const cp=process.getBuiltinModule('child_process'),fs=process.getBuiltinModule('fs');
      const fd=stdio==='file'?fs.openSync(log,'a'):null;
      const child=cp.spawn(helper,['--detach',ollama,log],{windowsHide:true,detached:true,stdio:fd===null?'ignore':['ignore',fd,fd],env:{...process.env,OLLAMA_HOST:'127.0.0.1:11439',OLLAMA_NO_CLOUD:'1'}});
      child.on('error',console.error);child.unref();if(fd!==null)fs.closeSync(fd);
    },{helper,ollama,log,stdio});
    await wait(async()=>{try{return(await fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'detached daemon');
    const query="$p=Get-NetTCPConnection -LocalPort 11439 -State Listen|Select-Object -First 1;$s=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.OwningProcess);$h=Get-CimInstance Win32_Process -Filter ('ProcessId='+$s.ParentProcessId);@{executable=$s.ExecutablePath;pid=$h.ProcessId;host=$h.ExecutablePath}|ConvertTo-Json -Compress";
    const owner=JSON.parse((await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',query],{windowsHide:true})).stdout);
    assert.equal(owner.executable.toLowerCase(),ollama.toLowerCase());assert.equal(owner.host.toLowerCase(),helper.toLowerCase());host=owner.pid;
    let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Electron exit retained inherited handles')),30000))]);}finally{clearTimeout(timer);}
    app=null;assert.throws(()=>process.kill(appPid,0));assert((await fetch('http://127.0.0.1:11439/api/version')).ok);
    process.kill(host);host=null;
    await wait(async()=>{try{await fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(500)});return false;}catch{return true;}},'owned host shutdown');
    report.checks.push({stdio,normalElectronExit:true,daemonSurvives:true,noStreamOrDebuggerWorkaround:true});
  }
  report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  if(host)try{process.kill(host);}catch{}
  if(app)await app.close().catch(()=>{});
  await fs.writeFile(stop,'stop');await observed;report.visibleConsoles=JSON.parse(await fs.readFile(observations,'utf8')).VisibleConsoles;
  if(report.visibleConsoles.length){report.passed=false;process.exitCode=1;}
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
