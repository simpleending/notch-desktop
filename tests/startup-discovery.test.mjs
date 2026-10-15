import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStartupDiscovery} from '../src/startup-discovery.mjs';
import {patchStartupShutdown} from '../src/bundle-patch.mjs';

test('discovery returns results/errors normally, cancels pending replies and refuses late work',async()=>{
  const discovery=createStartupDiscovery();
  assert.deepEqual(await discovery.run(()=>['editor']),['editor']);
  await assert.rejects(discovery.run(()=>{throw Error('real failure')}),/real failure/);
  let reject,started=false;
  const pending=discovery.run(()=>{started=true;return new Promise((_resolve,r)=>reject=r)});
  await Promise.resolve();assert.equal(started,true);discovery.stop();assert.deepEqual(await pending,[]);
  reject(Error('late failure'));assert.deepEqual(await discovery.run(()=>{throw Error('must not start')}),[]);
  assert.equal(discovery.signal.aborted,true);
});

test('cancellation terminates an owned discovery child rather than leaving it running',async()=>{
  const discovery=createStartupDiscovery();
  const child=promisify(execFile)(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:discovery.signal,windowsHide:true});
  const closed=new Promise(resolve=>child.child.once('close',resolve));
  const pending=discovery.run(()=>child);await Promise.resolve();discovery.stop();
  assert.deepEqual(await pending,[]);await closed;assert.notEqual(child.child.exitCode,0);
});

test('shutdown settles initialization before clearing plugin registries and keeps genuine failures',async()=>{
  const fixture='let Fue=class{async shutdown(){if(this.shuttingDown)return;this.shuttingDown=!0;const t=this.hostController.shutdown();this.clear();const r=(await Promise.allSettled([t,this.initialization])).flatMap(i=>i.status==="rejected"?[i.reason]:[]);if(r.length)throw new AggregateError(r,"PLUGIN_SYSTEM_SHUTDOWN_FAILED");}};class Vwt{listApplications(e){return Promise.resolve([e])}listFileApplications(e){return Promise.resolve([e])}}class WPt{async listApplications(){const e=[];for(const r of this.definitions){e.push(r)}return e}}function dRt(t,e){return rRt("reg.exe",[t,e],{windowsHide:!0,timeout:iRt})}function oRt(){return async()=>{for(const d of s){await lookup(d)}}}function $Ft(){return {findExecutable:async i=>{const n="where.exe";try{const {stdout:a}=await HV(n,[i],{windowsHide:!0});return a}catch{return null}}}}';
  const patched=patchStartupShutdown(fixture+'function D7e(t,e,r=null){return w7e.request(A8r(t),e,r)}function k7e(t){return v7e.request(lr.getAllWindows().map(o8r),t,O3r)}function _7e(){return {closeIpcIngress:()=>{r?.closeIngress(),P7e()}}}');assert.equal(patchStartupShutdown(patched),patched);
  const Plugin=new Function(patched+';return Fue')();
  for(const fails of [false,true]){
    let finish;const events=[],plugin=new Plugin();
    plugin.initialization=new Promise((resolve,reject)=>finish=()=>{events.push('initialized');fails?reject(Error('startup failure')):resolve()});
    plugin.hostController={shutdown:async()=>{events.push('host stopped')}};plugin.clear=()=>events.push('cleared');
    const shutdown=plugin.shutdown();assert.deepEqual(events,[]);finish();
    if(fails)await assert.rejects(shutdown,e=>e instanceof AggregateError&&e.errors[0].message==='startup failure');else await shutdown;
    assert.deepEqual(events,['initialized','host stopped','cleared']);
  }
  let ready;const calls=[];
  const request=new Function('c8r','w7e','A8r',patched+';return D7e;')(()=>new Promise(resolve=>ready=resolve),{request:(...args)=>{calls.push(args);return false;}},value=>value);
  const pending=request('window','quit','unsaved guard');assert.deepEqual(calls,[]);ready();assert.equal(await pending,false);
  assert.deepEqual(calls,[['window','quit','unsaved guard']]);
  const discovery=createStartupDiscovery(),previous=globalThis.__notchDiscovery;globalThis.__notchDiscovery=discovery;
  try{
    assert.equal(discovery.signal.aborted,false,'A vetoed quit must keep discovery usable');
    const cleanup=new Function('r','P7e',patched+';return _7e;')({closeIngress(){}},()=>{});
    cleanup().closeIpcIngress();assert.equal(discovery.signal.aborted,true);
  }finally{globalThis.__notchDiscovery=previous;}
});
