import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkspaceSearch } from '../src/workspace-search.mjs';

test('real fff searches tolerate typos, honor ignores and track new files without crossing roots', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-fff-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  const root = path.join(directory, 'project'), outside = path.join(directory, 'outside');
  await fs.mkdir(path.join(root,'src'), {recursive:true}); await fs.mkdir(outside);
  await fs.writeFile(path.join(root,'.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(root,'src','configuration.ts'), 'export const configuration = true;\n');
  await fs.writeFile(path.join(root,'ignored.txt'), 'do not index');
  await fs.writeFile(path.join(outside,'secret.ts'), 'private');
  await fs.symlink(outside,path.join(root,'linked-outside'),process.platform==='win32'?'junction':'dir');
  const service = createWorkspaceSearch(() => {
    const child = fork(fileURLToPath(new URL('../src/workspace-search-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
    child.postMessage = message => child.send(message); return child;
  });
  try {
    const result = await service.search('picker',root,0,'configuraton');
    assert.ok(result.entries.some(item=>item.path==='src/configuration.ts'));
    assert.equal(service.engine,'fff');
    const ignored = await service.search('picker',root,0,'ignored'); assert.equal(ignored.entries.length,0);
    const secret = await service.search('picker',root,0,'secret'); assert.ok(secret.entries.every(item=>!item.path.startsWith('linked-outside/')));
    await fs.writeFile(path.join(root,'src','freshly-created.ts'),'new');
    let fresh;
    const deadline = Date.now()+5000;
    do { fresh = await service.search('picker',root,0,'freshly-created'); if(fresh.entries.some(item=>item.path==='src/freshly-created.ts'))break; await new Promise(resolve=>setTimeout(resolve,100)); } while(Date.now()<deadline);
    assert.ok(fresh.entries.some(item=>item.path==='src/freshly-created.ts'));
    const switched = await service.search('picker',outside,1,'secret'); assert.equal(switched.entries[0].path,'secret.ts');
    await assert.rejects(service.search('bad',root,0,'x'.repeat(1025)),/Invalid/);
  } finally { await service.shutdown(); await fs.rm(directory,{recursive:true,force:true}); }
});

test('superseded and cancelled searches never deliver stale results, and crashes reject pending work', async () => {
  const child = new EventEmitter(); child.postMessage=()=>{}; child.kill=()=>true;
  const service = createWorkspaceSearch(()=>Promise.resolve(child));
  const old = service.search('picker','project',0,'old');
  const current = service.search('picker','project',0,'new');
  await assert.rejects(old,/CANCELLED/);
  await new Promise(resolve=>setImmediate(resolve));
  child.emit('message',{id:1,result:{entries:[{path:'old'}]}});
  child.emit('message',{id:2,result:{entries:[{path:'new'}]}});
  assert.equal((await current).entries[0].path,'new');
  const cancelled = service.search('picker','project',1,'x'); service.cancel('picker');
  await assert.rejects(cancelled,/CANCELLED/);
  const crash = service.search('picker','project',2,'y'); child.emit('exit',1);
  await assert.rejects(crash,/exited/);
  await service.shutdown(); await assert.rejects(service.search('picker','project',3,'z'),/CANCELLED/);
});
