import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {managedOllama} from '../vendor/notch-core/desktop-harness.js';

test('startup without a cached Ollama never downloads or calls a remote service',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-no-cached-runtime-')),requests=[];
  t.mock.method(os,'homedir',()=>directory);
  t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));throw new Error('No daemon');});
  await assert.rejects(managedOllama('0.40.3',AbortSignal.timeout(5000),false),/No compatible cached Ollama/);
  assert.deepEqual(requests,['http://127.0.0.1:11436/api/version']);
});

test('cached-only startup reuses a compatible running daemon and rejects an incompatible one',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{assert.equal(String(url),'http://127.0.0.1:11436/api/version');return Response.json({version:'0.40.3'});});
  assert.equal(await managedOllama('0.40.3',undefined,false),'http://127.0.0.1:11436');
  await assert.rejects(managedOllama('0.40.4',undefined,false),/incompatible Ollama/);
});
