import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {managedOllama,withManagedOllamaStart} from '../vendor/notch-core/desktop-harness.js';

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

test('runtime start and migration share a reentrant lease; cancellation and failure cannot strand it',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-runtime-start-'));
  t.mock.method(os,'homedir',()=>directory);
  const events=[];let unlock;const gate=new Promise(resolve=>unlock=resolve);
  const first=withManagedOllamaStart(async()=>{events.push('first');await withManagedOllamaStart(async()=>events.push('nested'));await gate;events.push('first-done');});
  while(!events.includes('nested'))await new Promise(resolve=>setTimeout(resolve,5));
  const controller=new AbortController();const cancelled=assert.rejects(withManagedOllamaStart(async()=>events.push('cancelled'),controller.signal),{name:'AbortError'});controller.abort();
  const second=withManagedOllamaStart(async()=>events.push('second'));
  await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(events,['first','nested']);unlock();
  await Promise.all([first,second,cancelled]);assert.deepEqual(events,['first','nested','first-done','second']);
  await assert.rejects(withManagedOllamaStart(async()=>{throw Error('Failed startup');}),/Failed startup/);
  assert.equal(await withManagedOllamaStart(async()=>42),42);
});
