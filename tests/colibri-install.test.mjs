import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';

// Run the production transaction with controlled IO and the same reentrant lease contract.
const source=await readFile(new URL('../vendor/notch-cli/src/providers/colibri.ts',import.meta.url),'utf8');
const body=stripTypeScriptTypes(source.slice(source.indexOf('export async function installColibri('),source.indexOf('\nasync function stopInternal(')).replace(/^export /,''));
function fixture(){
  const calls=[],owner=new AsyncLocalStorage();let tail=Promise.resolve(),releaseSetup;
  const setup=new Promise(resolve=>releaseSetup=resolve),previous={model:'previous'};
  const deps={path,process,
    prepareColibri:async()=>{},
    withLocalInference:async(fn,signal)=>{if(owner.getStore())return fn();const prior=tail;let release;tail=new Promise(resolve=>release=resolve);await prior;try{signal?.throwIfAborted();return await owner.run(true,fn);}finally{release();}},
    acquireLease:async()=>{assert(owner.getStore(),'Selection changes need the local-inference lease');return async()=>calls.push('release-install');},
    colibriCatalog:async()=>[{id:'next',fits:true}],colibriStatus:async()=>({running:false}),
    json:async()=>previous,atomic:async()=>{assert(owner.getStore());calls.push('save');},
    transactionFile:()=>'/transaction',setupFile:()=>'/setup',receiptFile:()=>'/receipt',root:()=>'/root',
    invoke:async()=>{calls.push('setup');await setup;},unlink:async file=>calls.push('unlink '+file),
    validateColibri:async()=>{calls.push('validate');return {modelId:'next'};},
    stopInternal:async()=>{assert(owner.getStore());calls.push('stop');},
    restoreSelection:async value=>{assert(owner.getStore());assert.equal(value.config,previous);calls.push('restore');},
  };
  const install=new Function(...Object.keys(deps),body+';return installColibri;')(...Object.values(deps));
  return {install,calls,releaseSetup,queue:deps.withLocalInference};
}
const until=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setImmediate(resolve));assert(check());};

test('Colibri setup, validation and optional unload finish before a queued model mount',async()=>{
  const f=fixture(),install=f.install('next',{unloadAfterValidation:true});
  await until(()=>f.calls.includes('setup'));
  const mount=f.queue(async()=>f.calls.push('mount'));
  await new Promise(resolve=>setImmediate(resolve));assert(!f.calls.includes('mount'));
  f.releaseSetup();assert.deepEqual(await install,{modelId:'next'});await mount;
  assert(f.calls.indexOf('stop')<f.calls.indexOf('mount'));
  assert(f.calls.indexOf('unlink /transaction')<f.calls.indexOf('mount'));
});

test('cancellation during Colibri validation unloads and restores before releasing the selection',async()=>{
  const f=fixture(),controller=new AbortController();
  const install=f.install('next',{signal:controller.signal,unloadAfterValidation:true});
  await until(()=>f.calls.includes('setup'));controller.abort();f.releaseSetup();
  await assert.rejects(install,{name:'AbortError'});
  assert(f.calls.includes('stop'));assert(f.calls.includes('restore'));
  assert(!f.calls.includes('unlink /transaction'));
  await f.queue(async()=>f.calls.push('retry'));assert.equal(f.calls.at(-1),'retry');
});

test('embedded Colibri install can retain its validated model without a later stale stop',async()=>{
  const f=fixture();f.releaseSetup();await f.install('next');assert(!f.calls.includes('stop'));
});
