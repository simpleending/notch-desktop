import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStartupDiscovery,stopPluginHost,isPluginStop} from '../src/startup-discovery.mjs';
import {patchStartupShutdown} from '../src/bundle-patch.mjs';

test('discovery returns results/errors normally, cancels pending replies and refuses late work',async()=>{
  const discovery=createStartupDiscovery();
  assert.deepEqual(await discovery.run(()=>['editor']),['editor']);
  assert.deepEqual(await discovery.wait(()=>({catalog:'verified'})),{catalog:'verified'});
  const cancelledCatalog=assert.rejects(discovery.wait(()=>new Promise(()=>{})),isPluginStop);
  await assert.rejects(discovery.run(()=>{throw Error('real failure')}),/real failure/);
  let reject,started=false;
  const pending=discovery.run(()=>{started=true;return new Promise((_resolve,r)=>reject=r)});
  await Promise.resolve();assert.equal(started,true);discovery.stop();assert.deepEqual(await pending,[]);await cancelledCatalog;
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
  const fixture='let Fue=class{async shutdown(){if(this.shuttingDown)return;this.shuttingDown=!0;const t=this.hostController.shutdown();this.clear();const r=(await Promise.allSettled([t,this.initialization])).flatMap(i=>i.status==="rejected"?[i.reason]:[]);if(r.length)throw new AggregateError(r,"PLUGIN_SYSTEM_SHUTDOWN_FAILED");}async initializeInternal(){try{const e=await new vYr(this.options.catalogDirectory,{catalogKind:this.options.catalogKind,productId:this.options.productId,developmentSources:this.options.developmentSources}).load(),r=r2r(this.options.productId);return e}catch(e){throw e}}};class Vwt{listApplications(e){return Promise.resolve([e])}listFileApplications(e){return Promise.resolve([e])}}class WPt{async listApplications(){const e=[];for(const r of this.definitions){e.push(r)}return e}}function dRt(t,e){return rRt("reg.exe",[t,e],{windowsHide:!0,timeout:iRt})}function oRt(){return async()=>{for(const d of s){await lookup(d)}}}function $Ft(){return {findExecutable:async i=>{const n="where.exe";try{const {stdout:a}=await HV(n,[i],{windowsHide:!0});return a}catch{return null}}}}';
  const ipc='class D8e{constructor(target){this.target=target}inFlight=new Set;handle(e,r,i){const n=async(a,...s)=>{const o=Promise.resolve().then(()=>r(a,...s)),A={channel:e,completion:o.then(()=>{},()=>{})};this.inFlight.add(A);A.completion.finally(()=>this.inFlight.delete(A));return await o};this.target.handle(e,n)}}';
  const controller='class zYr{shutdown(){}startProcess(e){}async initialize(){await this.replayInitialActivations()}async startProcessOnce(e){const r=this.processFactory();this.process=r;const i=this.liveness;try{if(await r.ready,this.process!==r)throw new Error("APP_PLUGIN_HOST_PROCESS_REPLACED");await i.check($Oe),this.setState("running"),i.startHeartbeat()}catch(n){this.failures.push(n);throw n}}async performActivation(e,r,i){this.process||await this.startProcess("starting");const n=1;try{if(await this.request("plugin.activate"),!this.runtimeStates.markActive(e,n))throw new Error("APP_PLUGIN_GENERATION_STALE:x");this.onActivationResult(e,n,"success")}catch(s){this.failures.push(s);throw s}}handleExit(e){if(this.process!==e)return;this.failures.push(new Error("unexpected exit"))}}';
  const overlay='class Ude{async createOverlayWindow(){const o=this.window;try{await this.load()}catch(c){throw this.logger.error("Onboarding overlay could not be opened",{error:c}),this.destroyOverlay(o),c}}}';
  const patched=patchStartupShutdown(fixture+ipc+controller+overlay+'function D7e(t,e,r=null){return w7e.request(A8r(t),e,r)}function k7e(t){return v7e.request(lr.getAllWindows().map(o8r),t,O3r)}function _7e(){return {closeIpcIngress:()=>{r?.closeIngress(),P7e()}}}');assert.equal(patchStartupShutdown(patched),patched);
  const Plugin=new Function(patched+';return Fue')();
  for(const fails of [false,true]){
    let finish;const events=[],plugin=new Plugin();
    plugin.initialization=new Promise((resolve,reject)=>finish=()=>{events.push('initialized');fails?reject(Error('startup failure')):resolve()});
    plugin.hostController={shutdown:async()=>{events.push('host stopped')}};plugin.clear=()=>events.push('cleared');
    const shutdown=plugin.shutdown();assert.deepEqual(events,['host stopped']);finish();
    if(fails)await assert.rejects(shutdown,e=>e instanceof AggregateError&&e.errors[0].message==='startup failure');else await shutdown;
    assert.deepEqual(events,['host stopped','initialized','cleared']);
  }
  let ready;const calls=[];
  const request=new Function('c8r','w7e','A8r',patched+';return D7e;')(()=>new Promise(resolve=>ready=resolve),{request:(...args)=>{calls.push(args);return false;}},value=>value);
  const pending=request('window','quit','unsaved guard');assert.deepEqual(calls,[]);ready();assert.equal(await pending,false);
  assert.deepEqual(calls,[['window','quit','unsaved guard']]);
  let readyToQuit;const quiesced=[];
  const quiesce=new Function('c8r','kp','v7e','o8r','O3r',patched+';return k7e;')(()=>new Promise(resolve=>readyToQuit=resolve),new Set([{isDestroyed:()=>false}]),{request:(...args)=>{quiesced.push(args);return {completed:true}}},value=>value,1800);
  const quitting=quiesce('quit');assert.deepEqual(quiesced,[]);readyToQuit();await quitting;assert.equal(quiesced.length,1);
  const Overlay=new Function(patched+';return Ude;')(),loading=new Overlay();let destroyed=true;
  loading.window={isDestroyed:()=>destroyed};loading.logger={error(){}};loading.destroyOverlay=()=>{};
  loading.load=async()=>{throw Object.assign(Error('cancelled load'),{code:'ERR_FAILED'})};
  const discovery=createStartupDiscovery(),previous=globalThis.__notchDiscovery;globalThis.__notchDiscovery=discovery;
  try{
    await assert.rejects(loading.createOverlayWindow(),/cancelled load/);
    assert.equal(discovery.signal.aborted,false,'A vetoed quit must keep discovery usable');
    const cleanup=new Function('r','P7e',patched+';return _7e;')({closeIngress(){}},()=>{});
    cleanup().closeIpcIngress();assert.equal(discovery.signal.aborted,true);
    await loading.createOverlayWindow();destroyed=false;await assert.rejects(loading.createOverlayWindow(),/cancelled load/);destroyed=true;
    loading.load=async()=>{throw Error('genuine failure')};await assert.rejects(loading.createOverlayWindow(),/genuine failure/);
    globalThis.__notchDiscovery=createStartupDiscovery();
    const channels=['external-application:list','chat-model:list','chat-composer-model:list','app-plugin:views-list','app-plugin:configuration-settings-list','app-plugin:mcp-tool-presentations-list'];
    const handlers=new Map();let allowInit;
    const initialized=new Promise(resolve=>allowInit=resolve);
    const Tracker=new Function(patched+';return D8e;')(),tracker=new Tracker({handle:(key,handler)=>handlers.set(key,handler)});
    for(const channel of channels)tracker.handle(channel,()=>initialized.then(()=>['entry']));
    tracker.handle('app-plugin:configuration-update',()=>initialized.then(()=> 'saved'));
    const reads=channels.map(channel=>handlers.get(channel)());let saved=false;const update=handlers.get('app-plugin:configuration-update')().then(result=>{saved=true;return result;});
    await Promise.resolve();await Promise.resolve();globalThis.__notchDiscovery.stop();
    assert.deepEqual(await Promise.all(reads),channels.map(()=>[]));await Promise.resolve();assert.equal(tracker.inFlight.size,1);assert.equal(saved,false);
    allowInit();assert.equal(await update,'saved','Shutdown cancellation must not discard configuration writes');
    await Promise.resolve();assert.equal(tracker.inFlight.size,0);
    const Controller=new Function('$Oe',patched+';return zYr;')(100),host=new Controller();
    let readyHost;host.failures=[];host.processFactory=()=>({ready:new Promise(resolve=>readyHost=resolve)});
    const states=[];host.setState=state=>states.push(state);host.liveness={check:async()=>{},startHeartbeat(){states.push('heartbeat')}};
    const startup=host.startProcessOnce('starting');host.shuttingDown=true;readyHost();await startup;assert.deepEqual(states,[]);
    host.shuttingDown=false;host.process={};let rejectActivation;host.request=()=>new Promise((_resolve,reject)=>rejectActivation=reject);
    host.runtimeStates={markActive(){throw Error('Late activation must not become active')}};host.onActivationResult=()=>{throw Error('Late activation callback')};
    const activation=host.performActivation('plugin');host.shuttingDown=true;rejectActivation(Error('APP_PLUGIN_ACTIVATION_STALE:plugin'));await activation;assert.deepEqual(host.failures,[]);
    host.shuttingDown=false;const genuine=host.performActivation('plugin');host.shuttingDown=true;rejectActivation(Error('genuine failure'));await assert.rejects(genuine,/genuine failure/);

  }finally{globalThis.__notchDiscovery=previous;}
});

test('plugin stop joins cancelled startup and activation before resetting runtime state',async()=>{
  const events=[];let rejectStartup,rejectActivation;
  const startup=new Promise((_resolve,reject)=>rejectStartup=reject).catch(error=>{assert.equal(isPluginStop(error),true);events.push('startup cancelled')});
  const activation=new Promise((_resolve,reject)=>rejectActivation=reject).catch(error=>{assert.equal(isPluginStop(error),true);events.push('activation cancelled')});
  const host={process:{kill(){events.push('killed')}},processStart:startup,activationPromises:new Map([['plugin',activation]]),
    request:async()=>{},setState:state=>events.push(state),disposeProcess(){this.process=undefined},
    rejectPending(error){rejectStartup(error);rejectActivation(error)},runtimeStates:{resetForShutdown(){events.push('reset')}}};
  const stopped=stopPluginHost(host);assert.equal(stopPluginHost(host),stopped);await stopped;
  assert.deepEqual(events,['shuttingDown','killed','startup cancelled','activation cancelled','reset','stopped']);
  assert.equal(isPluginStop(Error('genuine failure')),false);
  assert.equal(isPluginStop(Error('APP_PLUGIN_HOST_LIVENESS_STOPPED')),true);
});
