import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

for(const reused of [false,true])test(`desktop file-only download succeeds with 128 MB free RAM (${reused?'retained weights':'new download'})`,async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'notch-download-only-'));
 try{
  const fixture=new URL('./fixtures/download-only.mjs',import.meta.url).href;
  const entry=fileURLToPath(new URL('../vendor/notch-core/desktop-model-download.js',import.meta.url));
  const result=await promisify(execFile)(process.execPath,['--import',fixture,entry,'install','--model','Nimbus-Labs/Nimbus-4B-GGUF','--runner','ollama','--yes','--no-launch'],{cwd:home,windowsHide:true,timeout:20000,env:{...process.env,NOTCH_DOWNLOAD_FIXTURE_HOME:home,...(reused?{NOTCH_DOWNLOAD_REUSED:'1'}:{})}});
  assert.match(result.stdout,/Downloaded: ollama\/hf.co\/Nimbus-Labs/);
  const requests=JSON.parse(await fs.readFile(path.join(home,'requests.json'),'utf8'));
  assert.equal(requests.includes('/api/pull'),!reused);
  assert(!requests.some(route=>/chat|generate|create|delete/.test(route)));
  await assert.rejects(fs.access(path.join(home,'.notch.json')));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
