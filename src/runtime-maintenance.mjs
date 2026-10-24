import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withLocalInference,withManagedOllamaStart,acquireLease,pruneOwnedRuntimes,COLIBRI_VERSION,STRATA_CONTROL} from '../vendor/notch-core/desktop-harness.js';
const exec=promisify(execFile);
export function createRuntimeMaintenance({root=path.join(os.homedir(),'.notch/runtimes'),processes=runtimeProcesses}={}){
  return async function maintenance(action){
    if(!['review','clean'].includes(action))throw Error('Choose a supported storage action.');
    return withLocalInference(()=>withManagedOllamaStart(async()=>{
      const releases=[];
      try{for(const name of ['colibri-install','strata-install'])releases.push(await acquireLease(name,AbortSignal.timeout(30000)));
        const result=[];
        for(const provider of ['ollama','colibri','strata']){
          const directory=path.join(root,provider);if(!(await fs.lstat(directory).catch(()=>null)))continue;
          let current=provider==='colibri'?'v'+COLIBRI_VERSION:provider==='strata'?'control-'+STRATA_CONTROL:null;
          if(provider==='ollama'){try{current=JSON.parse(await fs.readFile(path.join(directory,'installed.json'),'utf8')).tag;}catch{continue;}}
          const row=await pruneOwnedRuntimes(directory,current,processes,action==='clean');result.push({provider,...row});
        }
        return result;
      }finally{for(const release of releases.reverse())await release();}
    },AbortSignal.timeout(30000)),AbortSignal.timeout(30000));
  };
}
async function runtimeProcesses(){
  if(process.platform==='win32'){
    const script="$ErrorActionPreference='Stop';@(Get-CimInstance Win32_Process | ForEach-Object { ([string]$_.ExecutablePath)+' '+([string]$_.CommandLine) }) | ConvertTo-Json -Compress";
    const {stdout}=await exec(path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:8*2**20});
    const rows=JSON.parse(stdout);if(!Array.isArray(rows)||!rows.length||rows.some(row=>typeof row!=='string'))throw Error('Could not inspect running engines. No runtimes were removed.');return rows;
  }
  const {stdout}=await exec('ps',['-axo','command='],{windowsHide:true,timeout:15000,maxBuffer:8*2**20});if(!stdout.trim())throw Error('Could not inspect running engines.');return stdout.split('\n');
}
