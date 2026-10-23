import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile),directory=path.resolve(process.argv[2]||'analysis/hidden-console-native');
await fs.mkdir(directory,{recursive:true});
const helper=path.resolve(process.argv[3]||`vendor/notch-core/native/notch-console-win32-${process.arch}.exe`);
const ready=path.join(directory,'observer-ready'),stop=path.join(directory,'observer-stop'),observations=path.join(directory,'consoles.json');
for(const file of [ready,stop])await fs.rm(file,{force:true});
const observer=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve(import.meta.dirname,'observe-consoles.ps1'),ready,observations,stop],{windowsHide:true,stdio:'ignore'}),observed=new Promise(resolve=>observer.once('exit',resolve));
const wait=async(fn,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out: '+label);};
await wait(async()=>{try{await fs.access(ready);return true;}catch{return false;}},'console observer');
const report={passed:false,benchmarks:false,downloads:false,checks:[]};let host;
try{
  const binary=await fs.readFile(helper),pe=binary.readUInt32LE(0x3c);assert.equal(binary.readUInt16LE(pe+24+68),2,'Host must use the Windows GUI subsystem');
  for(const args of [[],['relative.exe'],[path.join(directory,'missing.exe')]]){
    await assert.rejects(exec(helper,args,{windowsHide:true,timeout:10000}),error=>error.code===1&&!error.killed);
  }report.checks.push('Invalid arguments and failed spawn exit promptly');
  const fixture=path.join(directory,'output-fixture.rs'),fixtureExe=path.join(directory,'output fixture.exe');
  await fs.writeFile(fixture,`use std::{io::{self,Write},process::{Command,exit}};fn main(){if std::env::var_os("NOTCH_CHILD").is_some(){println!("NESTED_CHILD_COMPLETE");return;}let data=vec![b'x';8192];for _ in 0..1024{io::stdout().write_all(&data).unwrap();}let code=Command::new(std::env::current_exe().unwrap()).env("NOTCH_CHILD","1").status().unwrap();assert!(code.success());eprintln!("OUTPUT_DRAINED");exit(42);}`);
  await exec('rustc',[fixture,'-o',fixtureExe],{windowsHide:true,timeout:60000});
  try{await exec(helper,[fixtureExe],{windowsHide:true,timeout:30000,maxBuffer:12*1024*1024});assert.fail('Fixture must return its exit code');}
  catch(error){assert.equal(error.code,42,error.message);assert(error.stdout.length>=8*1024*1024);assert(error.stdout.includes('NESTED_CHILD_COMPLETE'));assert((error.stdout+error.stderr).includes('OUTPUT_DRAINED'));}
  report.checks.push('8 MiB of output and nested child drain without deadlock; exit code preserved; spaced path works');
  await assert.rejects(fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(1000)}));
  const runtime=path.join(os.homedir(),'.notch/runtimes/ollama'),{tag}=JSON.parse(await fs.readFile(path.join(runtime,'installed.json'),'utf8'));
  assert.match(tag,/^v\d+\.\d+\.\d+$/);const executable=path.join(runtime,tag,'ollama.exe');
  const models=process.env.OLLAMA_MODELS||path.join(os.homedir(),'.ollama/models');
  const launcher=path.join(directory,'launch.mjs'),pidFile=path.join(directory,'host.pid');
  await fs.writeFile(launcher,`import{spawn}from'node:child_process';import{writeFileSync,openSync,closeSync}from'node:fs';const log=${JSON.stringify(path.join(directory,'server.log'))},fd=openSync(log,'a');const child=spawn(${JSON.stringify(helper)},['--detach',${JSON.stringify(executable)},log],{windowsHide:true,detached:true,stdio:['ignore',fd,fd],env:{...process.env,OLLAMA_HOST:'127.0.0.1:11439',OLLAMA_MODELS:${JSON.stringify(models)},OLLAMA_NO_CLOUD:'1'}});child.on('error',e=>{throw e});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));closeSync(fd);child.unref();`);
  await exec(process.execPath,[launcher],{windowsHide:true,timeout:15000});host=Number(await fs.readFile(pidFile,'utf8'));
  await wait(async()=>{try{return(await fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},'persistent daemon');
  host=Number((await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Get-NetTCPConnection -LocalPort 11439 -State Listen|Select-Object -First 1;(Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.OwningProcess)).ParentProcessId"],{windowsHide:true})).stdout.trim());
  process.kill(host,0);report.checks.push('Daemon survives the launching application and detach process exiting');
  const model=process.argv[4]||'hf.co/unsloth/Qwen3-0.6B-GGUF:Q4_K_M';
  assert((await(await fetch('http://127.0.0.1:11439/api/tags')).json()).models.some(row=>row.name===model),'Verification requires an already-downloaded model in OLLAMA_MODELS.');
  for(let attempt=0;attempt<2;attempt++){
    const loaded=await fetch('http://127.0.0.1:11439/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,keep_alive:'5m',options:{num_ctx:8192,num_batch:128}}),signal:AbortSignal.timeout(180000)});assert(loaded.ok,await loaded.text());
    assert((await(await fetch('http://127.0.0.1:11439/api/ps')).json()).models.some(row=>row.name===model));
    const unloaded=await fetch('http://127.0.0.1:11439/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,keep_alive:0})});assert(unloaded.ok);
    assert.deepEqual((await(await fetch('http://127.0.0.1:11439/api/ps')).json()).models,[]);
  }report.checks.push('Existing Qwen weights load, eject, remount and eject through real GPU discovery without generation');
  report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  if(host){try{process.kill(host);}catch{}await wait(async()=>{try{await fetch('http://127.0.0.1:11439/api/version',{signal:AbortSignal.timeout(500)});return false;}catch{return true;}},'host shutdown',15000).catch(error=>{report.passed=false;report.shutdownError=error.message;process.exitCode=1;});}
  await fs.writeFile(stop,'stop');await observed;
  report.consoles=JSON.parse(await fs.readFile(observations,'utf8')).VisibleConsoles;
  if(report.consoles.length){report.passed=false;process.exitCode=1;}
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
