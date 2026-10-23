import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const powershell=path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
// Only the private Notch port and our exact managed executable may be migrated.
const ownerQuery=String.raw`
$ErrorActionPreference='Stop'
$listener=Get-NetTCPConnection -LocalPort 11436 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$listener){'null';exit}
$server=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
$parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$server.ParentProcessId)
@{pid=$server.ProcessId;executable=$server.ExecutablePath;command=$server.CommandLine;created=$server.CreationDate.ToUniversalTime().ToString('o');parent=$parent.ExecutablePath}|ConvertTo-Json -Compress
`;
const stopQuery=String.raw`
$ErrorActionPreference='Stop'
$server=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:NOTCH_QUIET_PID)
if(!$server -or $server.ExecutablePath -ne $env:NOTCH_QUIET_EXE -or $server.CreationDate.ToUniversalTime().ToString('o') -ne $env:NOTCH_QUIET_CREATED){throw 'Managed runtime identity changed; retry.'}
Stop-Process -Id $server.ProcessId -ErrorAction Stop
`;
export async function createQuietOllama({root=path.join(os.homedir(),'.notch/runtimes/ollama'),source=fileURLToPath(new URL(`../vendor/notch-core/native/notch-console-win32-${process.arch}.exe`,import.meta.url)).replace(/\.asar([\\/])/g,'.asar.unpacked$1'),run=exec,fetcher=fetch}={}) {
  const bytes=await fs.readFile(source),digest=createHash('sha256').update(bytes).digest('hex');
  const directory=path.join(root,'console-host'),helper=path.join(directory,`notch-console-${digest}.exe`);
  await fs.mkdir(directory,{recursive:true});
  let cached;try{cached=await fs.readFile(helper);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!cached?.equals(bytes)){
    const temporary=helper+'.'+randomUUID()+'.tmp';
    try{
      await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o700});
      try{await fs.rename(temporary,helper);}catch(error){if(!(await fs.readFile(helper).catch(()=>null))?.equals(bytes))throw error;}
    }finally{await fs.unlink(temporary).catch(()=>{});}
  }
  const query=async(script,env={})=>(await run(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:16384,env:{...process.env,...env}})).stdout;
  const owner=async()=>JSON.parse(await query(ownerQuery));
  const legacy=row=>row&&typeof row.executable==='string'&&path.dirname(path.dirname(row.executable)).toLowerCase()===path.resolve(root).toLowerCase()&&/^v\d+\.\d+\.\d+$/.test(path.basename(path.dirname(row.executable)))&&path.basename(row.executable).toLowerCase()==='ollama.exe'&&/\bserve\s*$/.test(row.command||'')&&!(typeof row.parent==='string'&&path.dirname(row.parent).toLowerCase()===directory.toLowerCase()&&/^notch-console-[a-f0-9]{64}\.exe$/i.test(path.basename(row.parent)));
  return {
    helper,
    // The host is a GUI-subsystem binary: detaching it creates no interactive console.
    launch(executable,options){return spawn(helper,['--detach',executable,path.join(root,'server.log')],{...options,detached:true,cwd:path.dirname(executable),windowsHide:true});},
    async migrate({withLocalInference,withManagedOllamaStart,start,signal}) {
      if(!legacy(await owner()))return;
      await withLocalInference(()=>withManagedOllamaStart(async()=>{
        signal?.throwIfAborted();const current=await owner();if(!legacy(current))return;
        const response=await fetcher('http://127.0.0.1:11436/api/ps',{signal:AbortSignal.timeout(3000)});
        if(!response.ok)throw Error('Could not inspect the managed runtime before restarting it.');
        const {models}=await response.json();if(!Array.isArray(models))throw Error('Invalid managed runtime status.');
        await query(stopQuery,{NOTCH_QUIET_PID:String(current.pid),NOTCH_QUIET_EXE:current.executable,NOTCH_QUIET_CREATED:current.created});
        // Stop-Process can return before the port is released.
        for(let n=0;n<100;n++){try{process.kill(current.pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
        await start();
        for(const model of models){
          if(typeof model.name!=='string')continue;
          const options=Number.isSafeInteger(model.context_length)&&model.context_length>0?{num_ctx:model.context_length,num_batch:128}:{num_batch:128};
          const loaded=await fetcher('http://127.0.0.1:11436/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model.name,stream:false,keep_alive:'5m',options}),signal:AbortSignal.timeout(180000)});
          if(!loaded.ok)throw Error('The hidden runtime restarted, but its previous model could not be restored. Retry loading the model.');
          await loaded.json();
        }
      },signal),signal);
    },
  };
}
