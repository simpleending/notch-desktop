import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {markOwnedRuntime,pruneOwnedRuntimes,rotateRuntimeLog} from '../vendor/notch-core/desktop-harness.js';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-owned-runtime-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));async function add(name,owned=true){const folder=path.join(root,name);await fs.mkdir(folder);await fs.writeFile(path.join(folder,'engine'),'engine');if(owned)await markOwnedRuntime(folder);await new Promise(resolve=>setTimeout(resolve,2));return folder;}return{root,add};}
test('runtime cleanup keeps current, previous, active, unknown and modified folders',async t=>{
  const {root,add}=await fixture(t);const oldest=await add('v1.0.0'),modified=await add('v1.1.0'),active=await add('v1.2.0');await add('v1.3.0',false);await add('v1.4.0');await add('v1.5.0');
  await fs.writeFile(path.join(modified,'my-model.gguf'),'user model');
  const scan=async()=>[active+' --serve'];const preview=await pruneOwnedRuntimes(root,'v1.5.0',scan);
  assert.deepEqual(preview.available,['v1.0.0']);assert(await fs.stat(oldest));
  assert.deepEqual((await pruneOwnedRuntimes(root,'v1.5.0',scan,true)).removed,['v1.0.0']);
  assert.deepEqual((await fs.readdir(root)).sort(),['v1.1.0','v1.2.0','v1.3.0','v1.4.0','v1.5.0']);assert.equal(await fs.readFile(path.join(modified,'my-model.gguf'),'utf8'),'user model');
});
test('an engine starting during quarantine restores the version instead of deleting it',async t=>{
  const {root,add}=await fixture(t);const old=await add('v1.0.0');await add('v1.1.0');await add('v1.2.0');let scans=0;
  const result=await pruneOwnedRuntimes(root,'v1.2.0',async()=>++scans===1?[]:[old+' --serve'],true);
  assert.deepEqual(result.removed,[]);assert(await fs.stat(path.join(old,'engine')));assert(!(await fs.readdir(root)).some(name=>name.startsWith('cleanup-')));
});
test('failed process inspection restores quarantined files',async t=>{
  const {root,add}=await fixture(t);const old=await add('v1.0.0');await add('v1.1.0');await add('v1.2.0');let scans=0;
  await assert.rejects(pruneOwnedRuntimes(root,'v1.2.0',async()=>{if(++scans===2)throw Error('Inspection unavailable');return[];},true),/Inspection unavailable/);assert(await fs.stat(path.join(old,'engine')));
});
test('even a user-added empty directory prevents runtime cleanup',async t=>{
  const {root,add}=await fixture(t);const old=await add('v1.0.0');await add('v1.1.0');await add('v1.2.0');await fs.mkdir(path.join(old,'user-folder'));
  assert.deepEqual((await pruneOwnedRuntimes(root,'v1.2.0',async()=>[],true)).removed,[]);assert((await fs.stat(path.join(old,'user-folder'))).isDirectory());
});
test('runtime links are retained and path traversal is rejected',async t=>{
  const {root,add}=await fixture(t);const target=await add('unowned',false);await fs.symlink(target,path.join(root,'v1.0.0'),'junction');await add('v1.1.0');await add('v1.2.0');
  assert.deepEqual((await pruneOwnedRuntimes(root,'v1.2.0',async()=>[],true)).removed,[]);assert.equal(await fs.readFile(path.join(target,'engine'),'utf8'),'engine');await assert.rejects(pruneOwnedRuntimes(root,'../outside',async()=>[],true),/version/);
});
test('inactive logs rotate to a bounded diagnostic tail',async t=>{
  const {root}=await fixture(t),file=path.join(root,'server.log');await fs.writeFile(file,'old lines\n'+'Z'.repeat(128));await rotateRuntimeLog(file,64);assert.equal((await fs.stat(file)).size,0);assert.equal(await fs.readFile(file+'.previous','utf8'),'Z'.repeat(64));await fs.writeFile(file,'new');await rotateRuntimeLog(file,64);assert.equal(await fs.readFile(file,'utf8'),'new');
});
