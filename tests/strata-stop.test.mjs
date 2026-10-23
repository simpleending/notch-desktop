import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

test('the actual Strata Python bridge rejects failed/still-stopping control replies before switching',async t=>{
 try{await run('python',['--version'],{windowsHide:true});}catch{t.skip('Strata requires Python; unavailable on this test host.');return;}
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'notch-strata-stop-'));
 try{
  const source=await fs.readFile(new URL('../vendor/notch-cli/src/providers/strata.ts',import.meta.url),'utf8');
  const bridge=source.match(/export const STRATA_BRIDGE=String.raw`([\s\S]*?)`;/)[1];
  for(const [file,text] of [
   ['strata_cli/launch/catalog.py','class Catalog:\n    def __init__(self,root): pass\n'],
   ['strata_cli/launch/settings.py','class LaunchSettings: pass\n'],
   ['strata_cli/launch/runner.py','class Runner: pass\n'],
   ['strata_control/runtime.py','import os,json\ndef stop(*args,**kw): return json.loads(os.environ["NOTCH_STOP_REPLY"])\n'],
  ]){const target=path.join(folder,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);}
  for(const reply of [{ok:false,state:'ready',error:'instance_mismatch'},{ok:false,state:'failed',error:'leftover_process_not_ended'},{ok:true,state:'stopping'},{ok:true,state:'stopped'}]){
   const request=run('python',['-c',bridge,folder,'stop',JSON.stringify({profile:'fixture',instanceId:'a'.repeat(32)}),folder],{windowsHide:true,timeout:10000,env:{...process.env,NOTCH_STOP_REPLY:JSON.stringify(reply)}});
   if(reply.ok&&reply.state==='stopped')assert.deepEqual(JSON.parse((await request).stdout),reply);
   else await assert.rejects(request,error=>error.stderr.includes('could not release the previous model'));
  }
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
