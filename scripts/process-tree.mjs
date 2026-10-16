import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export async function closeQaApp(app) {
  const child=app.process();
  if(child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  // A forced-recovery run can leave the debugger close pending after the OS process exits.
  await Promise.race([app.close(),exited]);
}

export async function processSnapshot() {
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="CreationDate";Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress'],{windowsHide:true,timeout:15000,maxBuffer:2**20});
  return JSON.parse(stdout);
}

export async function stopOwnedProcesses(root, before) {
  const owned=ownedProcessIds(root,before),live=await processSnapshot();
  for(const old of before.filter(row=>owned.has(row.ProcessId)).sort((a,b)=>Number(b.ProcessId===root)-Number(a.ProcessId===root))){
    if(live.some(row=>row.ProcessId===old.ProcessId&&row.CreationDate===old.CreationDate))await promisify(execFile)('taskkill.exe',['/PID',String(old.ProcessId),'/F'],{windowsHide:true}).catch(()=>{});
  }
}

export function ownedProcessIds(root, rows) {
  const processes=new Map(rows.map(row=>[row.ProcessId,row])),owned=new Set([root]);let changed=true;
  while(changed){changed=false;for(const row of rows){
    const parent=processes.get(row.ParentProcessId);
    if(owned.has(row.ParentProcessId)&&!owned.has(row.ProcessId)&&Number.isSafeInteger(row.CreationDate)&&Number.isSafeInteger(parent?.CreationDate)&&row.CreationDate>=parent.CreationDate){owned.add(row.ProcessId);changed=true;}
  }}
  return owned;
}
