import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelManager} from '../src/model-manager.mjs';
import {createStrataPanel} from '../src/strata-panel.mjs';
import {modelPreload,patchModelPreload} from '../src/model-ipc.mjs';

test('Strata setup, install, cancellation and context changes use the isolated engine and preserve existing preferences',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-strata-manager-')),calls=[];
  await writeFile(path.join(directory,'model-context.json'),JSON.stringify({'ollama/existing':8192}));
  const strata={
    async prepareStrata(){calls.push('prepare');},async strataCatalog(){return{installed:true,models:[{id:'coder',fits:true}]};},
    async strataModels(){return[];},async strataStatus(){return{running:false};},async strataPlan(){return{fits:true};},
    async installStrata(id,_memory,signal){calls.push(['install',id,signal instanceof AbortSignal]);},async stopStrata(){calls.push('unload');},async setStrataDirectory(dir){calls.push(['directory',dir]);}
  };
  const manager=createModelManager(directory,{strata,hardware:async()=>({}),chooseModelDirectory:async()=>directory});
  const settled=async()=>{for(let i=0;i<50;i++){if((await manager.status()).job.state!=='running')return;await new Promise(r=>setTimeout(r,2));}throw Error('Job stuck');};
  await manager.strata('setup');await settled();assert.equal((await manager.status()).job.state,'complete');
  await assert.rejects(manager.strata('install','../bad'),/catalog/);
  await manager.strata('install','coder');await settled();await manager.strata('unload');await manager.strata('directory');
  assert.deepEqual(calls,['prepare',['install','coder',true],'unload',['directory',directory]]);
  const model={key:'strata/coder',provider:'strata',enabled:true,availableContextWindows:[8192,32768]};
  await manager.setContext(model.key,32768,[model]);
  strata.strataPlan=async()=>({fits:false});await assert.rejects(manager.setContext(model.key,8192,[model]),/free memory/);
  assert.equal(manager.requestedContext(model.key),32768);
  const saved=JSON.parse(await readFile(path.join(directory,'model-context.json'),'utf8'));assert.equal(saved['ollama/existing'],8192);
});

test('a folder picker opened before a download cannot change its destination during installation',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'notch-strata-folder-'));
  let choose,entered,started,leased=false,writes=0;
  const choosing=new Promise(resolve=>entered=resolve),installing=new Promise(resolve=>started=resolve);
  const manager=createModelManager(directory,{
    hardware:async()=>({}),withInference:async fn=>{leased=true;try{return await fn();}finally{leased=false;}},
    chooseModelDirectory:()=>{entered();return new Promise(resolve=>choose=resolve);},
    strata:{
      strataStatus:async()=>({running:false}),strataCatalog:async()=>({models:[]}),
      setStrataDirectory:async()=>{assert(leased);writes++;},
      installStrata:async(_id,_memory,signal)=>{started();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
    },
  });
  const selection=manager.strata('directory');await choosing;
  await manager.strata('install','coder');await installing;choose(directory);
  await assert.rejects(selection,/download is already running/);assert.equal(writes,0);
  await manager.cancelInstall();
  for(let i=0;i<50&&(await manager.status()).job.state==='running';i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await manager.status()).job.state,'cancelled');
  await manager.strata('directory',directory);assert.equal(writes,1);
});

test('Strata keeps unavailable backends and models visible with reasons, with benchmarks off',()=>{
  const React={Fragment:'fragment',useState:value=>[value,()=>{}],useRef:()=>({current:null}),useEffect(){},createElement:(type,props,...children)=>({type,props:props||{},children})};
  const cached={installed:true,version:'0.2.2',gpu:'AMD Radeon 8060S',backend:'hip',reason:'Strix Halo support is experimental',dataDirectory:'Z:/Strata',freeDiskBytes:100e9,
    backends:[{backend:'cuda',available:false,reason:'No NVIDIA GPU'},{backend:'hip',available:true,reason:'AMD HIP'},{backend:'cpu',available:false,reason:'GPU required'}],
    models:[{id:'large',name:'Large model',download_gb:70,fits:false,reason:'Insufficient current memory'}]};
  const tree=createStrataPanel(React)({cached,api:{},onCatalog(){}});
  const all=n=>[n,...n.children.flat(Infinity).filter(v=>v&&typeof v==='object').flatMap(all)],nodes=all(tree);
  assert.equal(nodes.filter(n=>n.type==='input').length,3);assert(nodes.filter(n=>n.type==='input').every(n=>n.props.disabled));
  assert(nodes.find(n=>n.type==='button'&&n.props.title==='Insufficient current memory').props.disabled);
  assert.match(JSON.stringify(tree),/Speed benchmarks are off/);assert.match(JSON.stringify(tree),/No NVIDIA GPU/);
});

test('upgraded preload installs the Strata IPC once',()=>{
  assert.equal(patchModelPreload(modelPreload),modelPreload);
  const previous=modelPreload.replace("\n  strata:(action,model)=>ipcRenderer.invoke('notch-models:strata',action,model),",'');
  assert.equal(patchModelPreload(previous),modelPreload);
});
