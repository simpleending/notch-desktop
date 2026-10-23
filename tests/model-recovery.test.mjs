import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelManager} from '../src/model-manager.mjs';

for(const provider of ['colibri','strata'])for(const action of ['setup','install']){
 test(`${provider} ${action}: late cancellation stays cancelled and a retry can complete`,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-engine-cancel-'));
  let finish,started;
  const ready=new Promise(resolve=>started=resolve),operation=async()=>{started();await new Promise(resolve=>finish=resolve);};
  const engine=provider==='colibri'?{prepareColibri:operation,installColibri:operation,stopColibri:async()=>{}}:{prepareStrata:operation,installStrata:operation};
  const manager=createModelManager(directory,{[provider]:engine,hardware:async()=>({})});
  const settle=async()=>{for(let n=0;n<100;n++){const {job}=await manager.status();if(job.state!=='running')return job;await new Promise(resolve=>setImmediate(resolve));}throw Error('Model job stuck running');};
  try{
   await manager[provider](action,'coder');await ready;
   await manager.cancelInstall();finish();
   assert.equal((await settle()).state,'cancelled');
   finish=undefined;await manager[provider](action,'coder');
   while(!finish)await new Promise(resolve=>setImmediate(resolve));
   finish();assert.equal((await settle()).state,'complete');
  }finally{finish?.();await fs.rm(directory,{recursive:true,force:true});}
 });
}
