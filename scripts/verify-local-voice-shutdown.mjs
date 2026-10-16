import { _electron } from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { processSnapshot, ownedProcessIds, stopOwnedProcesses } from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'analysis/local-voice-shutdown.json'),checks=[];
const cache=path.resolve(process.argv[4]||'analysis/voice-runtime/local-voice');
const sample=await fs.readFile('analysis/voice-runtime/jfk.wav');let pcm;
for(let i=12;i+8<=sample.length;){const n=sample.readUInt32LE(i+4);if(sample.toString('ascii',i,i+4)==='data'){pcm=sample.subarray(i+8,i+8+n);break;}i+=8+n+(n%2);}
assert.ok(pcm);const source=Buffer.concat([pcm,pcm,pcm]);let passed=false,failure;
try{
 for(const scenario of ['transcription','speech','download']){
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-voice-exit-'));
  if(scenario!=='download')await fs.cp(cache,path.join(profile,'local-voice'),{recursive:true});
  const app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),timeout:45000});
  const pid=app.process().pid;let before;
  try{
   await app.evaluate(async(_electron,{scenario,audio})=>{
    const voice=globalThis.__notchHost.voice;
    if(scenario==='transcription'){
     const id=await voice.startRecognition(()=>{},{}),pcm=Buffer.from(audio,'base64');
     for(let i=0;i<pcm.length;i+=32000)voice.sendRecognition(id,pcm.subarray(i,i+32000));
    }else if(scenario==='speech')globalThis.__voiceShutdownTask=voice.synthesize('This speech is generated locally on your device. '.repeat(125)).catch(()=>{});
    else await voice.install();
   },{scenario,audio:source.subarray(0,960000).toString('base64')});
   before=await processSnapshot();const owned=ownedProcessIds(pid,before),children=before.filter(row=>owned.has(row.ProcessId)&&row.ProcessId!==pid);
   const started=Date.now();await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Voice shutdown timed out.')),20000).unref())]);
   const after=await processSnapshot();const survivors=after.filter(row=>before.some(old=>owned.has(old.ProcessId)&&old.ProcessId===row.ProcessId&&old.CreationDate===row.CreationDate));
   assert.deepEqual(survivors,[],scenario+' left an owned process running');checks.push({scenario,passed:true,elapsedMs:Date.now()-started,observedChildren:children.map(row=>row.ProcessId)});
  }finally{if(before)await stopOwnedProcesses(pid,before);else await app.close().catch(()=>{});}
 }
 passed=true;
}catch(error){failure=error.stack;throw error;}finally{await fs.writeFile(reportFile,JSON.stringify({passed,executable,checks,failure},null,2));console.log(JSON.stringify({passed,reportFile,checks,failure}));}
