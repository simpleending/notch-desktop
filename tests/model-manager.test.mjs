import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelManager } from '../src/model-manager.mjs';
import { cloudModelRows, localContextProfile, isPrimaryModelSender } from '../src/model-policy.mjs';
const GiB=2**30;
const model = { id:'lab/new-model',name:'New model',created:10,context_length:131072,architecture:{output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0.000001',completion:'0.000002'},top_provider:{max_completion_tokens:4096} };
const encrypted = { async isAsyncEncryptionAvailable(){return true;},getSelectedStorageBackend(){return 'gnome_libsecret';},async encryptStringAsync(value){return Buffer.from([...value].reverse().join(''));},async decryptStringAsync(value){return { result:[...value.toString()].reverse().join('') };} };

test('local context defaults to 8K and respects model context, KV memory and tools',()=>{
  const hardware={availableMemory:14*GiB,totalMemory:24*GiB,availableVram:0};
  const metadata={capabilities:['tools'],model_info:{'general.architecture':'test','test.block_count':32,'test.attention.head_count_kv':4,'test.attention.key_length':128,'test.attention.value_length':128,'test.context_length':16384}};
  const profile=localContextProfile(3*GiB,hardware,metadata);
  assert.equal(profile.contextWindow,8192);assert.deepEqual(profile.choices,[4096,8192,16384]);
  assert.equal(localContextProfile(16*GiB,hardware,metadata).fits,false);
  assert.equal(localContextProfile(3*GiB,hardware,{}).fits,false);
  metadata.model_info['test.context_length']=4096;assert.deepEqual(localContextProfile(3*GiB,hardware,metadata).choices,[4096]);
});
test('cloud catalog filters tool support, orders by age and separates context from RAM',()=>{
  const rows=cloudModelRows([{...model,id:'old',created:1},model,{...model,id:'no-tools',supported_parameters:[]}],true);
  assert.equal(rows[0].key,'openrouter/lab/new-model');assert.equal(rows.length,2);assert.equal(rows[0].defaultContextWindow,32768);
  assert.deepEqual(rows[0].pricing,{input:1,output:2});assert.equal(cloudModelRows([model],false)[0].enabled,false);
});
test('refreshing a loaded model does not count its own allocation twice',()=>{
  const hardware={availableMemory:2*GiB,totalMemory:24*GiB,availableVram:2*GiB},metadata={capabilities:['tools']};
  assert.equal(localContextProfile(3*GiB,hardware,metadata).fits,false);
  assert.equal(localContextProfile(3*GiB,hardware,metadata,{size:5*GiB,size_vram:5*GiB}).fits,true);
  assert.equal(localContextProfile(3*GiB,hardware,metadata,{size:Infinity,size_vram:Infinity}).fits,false);
});
test('keys never appear in status/plaintext disk; catalog caches/coalesces and context survives restart',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-model-test-'));let fetches=0;
  const fetcher=async (url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer sk-or-example-secret');fetches++;return {ok:true,json:async()=>({data:[model]})};};
  const manager=createModelManager(directory,{safeStorage:encrypted,fetcher});
  assert.deepEqual(await manager.cloudCatalog(),[]);
  await assert.rejects(manager.connect('untrusted','sk-or-example-secret'),/valid/);
  await manager.connect('openrouter','sk-or-example-secret');
  assert.doesNotMatch(JSON.stringify(await manager.status()),/sk-or-example-secret/);
  assert.doesNotMatch(await readFile(path.join(directory,'provider-keys.encrypted.json'),'utf8'),/sk-or-example-secret/);
  const [a,b]=await Promise.all([manager.cloudCatalog(),manager.cloudCatalog()]);assert.deepEqual(a,b);assert.equal(fetches,2);
  await manager.setContext(a[0].key,65536,a);await assert.rejects(manager.setContext(a[0].key,999999,a),/supported/);
  const restored=createModelManager(directory,{safeStorage:encrypted,fetcher});
  assert.equal((await restored.cloudCatalog())[0].defaultContextWindow,65536);assert.equal(fetches,2);
  await restored.disconnect('openrouter');assert.equal((await restored.status()).openrouter,false);assert.deepEqual(await restored.cloudCatalog(),[]);
});
test('no secure key store means session-only credentials; invalid keys do not overwrite',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-model-session-'));
  let ok=true;const manager=createModelManager(directory,{fetcher:async()=>({ok,status:401})});
  await manager.connect('openrouter','sk-or-example-secret');ok=false;
  await assert.rejects(manager.connect('openrouter','sk-or-bad-example-key'),/rejected/);
  assert.equal(await manager.key('openrouter'),'sk-or-example-secret');assert.equal((await manager.status()).persistentKeys,false);
  assert.equal((await readdir(directory)).includes('provider-keys.encrypted.json'),false);
});
test('model IPC rejects remote pages, child frames and auxiliary notch surfaces',()=>{
  const frame={url:'notch-app://renderer/index.html'}, sender={mainFrame:frame};assert.equal(isPrimaryModelSender({sender,senderFrame:frame}),true);
  for(const url of ['https://notch-app/renderer','notch-app://renderer/index.html?surface=browser','notch-app://other/index.html'])assert.equal(isPrimaryModelSender({sender,senderFrame:{url}}),false);
  const child={url:frame.url};assert.equal(isPrimaryModelSender({sender,senderFrame:child}),false);
});
test('model download validates memory, supports cancellation and only forwards the HF token',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-model-download-'));
  const manager=createModelManager(directory,{recommend:async()=>({models:[{repo:'owner/public-model',fits:true}]}),install:async (repo,runner,{signal,env,onOutput})=>{assert.equal(repo,'owner/public-model');assert.deepEqual(env,{});onOutput({text:'Downloading 10%'});await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  await assert.rejects(manager.startInstall('bad/missing','ollama'),/fits/);
  assert.equal((await manager.startInstall('owner/public-model','ollama')).job.state,'running');
  await assert.rejects(manager.startInstall('owner/public-model','ollama'),/already/);
  await manager.cancelInstall();await new Promise(resolve=>setImmediate(resolve));assert.equal((await manager.status()).job.state,'cancelled');
});
test('a verified MLX installation appears after restart only on supported Apple hardware',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-model-mlx-'));
  const manager=createModelManager(directory,{recommend:async()=>({models:[{repo:'owner/apple-model',fits:true,bytes:3*GiB}]}),install:async (_repo,_runner,{cwd})=>{assert.ok(cwd.startsWith(directory));}});
  await manager.startInstall('owner/apple-model','mlx');
  while((await manager.status()).job.state==='running')await new Promise(resolve=>setImmediate(resolve));
  const restored=createModelManager(directory), hardware={mlxSupported:true,availableMemory:16*GiB,totalMemory:24*GiB,availableVram:0};
  const rows=await restored.mlxModels(hardware);assert.equal(rows[0].key,'mlx/owner/apple-model');assert.equal(rows[0].defaultContextWindow,8192);
  assert.deepEqual(await restored.mlxModels({...hardware,mlxSupported:false}),[]);
});
