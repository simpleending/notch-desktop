import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModelManager} from '../src/model-manager.mjs';
import {modelPreload,patchModelPreload} from '../src/model-ipc.mjs';

function fixture(overrides={}) {
  const calls=[],status={installed:true,configured:true,running:false};
  const colibri={
    async prepareColibri(){calls.push('prepare');},async colibriStatus(){return status;},async colibriCatalog(){return[{id:'coder',fits:true}];},async colibriModels(){return[];},
    async colibriPlan(){return{fits:true};},async installColibri(id){calls.push(`install:${id}`);calls.push('validate');},async validateColibri(){calls.push('validate');},async stopColibri(){calls.push('unload');},...overrides,
  };
  return{colibri,calls,status};
}
async function manager(f) {return createModelManager(await mkdtemp(path.join(os.tmpdir(),'notch-colibri-')),{colibri:f.colibri});}
async function settled(m) {for(let i=0;i<100;i++){const s=await m.status();if(s.job?.state!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw new Error('Job did not finish.');}
test('Colibri downloads, validates tools and unloads before reporting ready',async()=>{
  const f=fixture(),m=await manager(f);
  assert.equal((await m.colibri('catalog')).models[0].id,'coder');
  await assert.rejects(m.colibri('install','../bad'),/catalog model/);await assert.rejects(m.colibri('shell'),/Choose/);
  await m.colibri('install','coder');assert.equal((await settled(m)).job.state,'complete');assert.deepEqual(f.calls,['install:coder','validate','unload']);
});
test('an atomic installer validation failure is never advertised as success',async()=>{
  const f=fixture({async installColibri(){throw new Error('Bad tool result');}}),m=await manager(f);
  await m.colibri('install','coder');const s=await settled(m);assert.equal(s.job.state,'failed');assert.match(s.job.message,/Bad tool result/);assert.deepEqual(f.calls,[]);
});
test('an install rejected while another model runs does not unload that model',async()=>{
  const f=fixture({async installColibri(){throw new Error('Unload first');}}),m=await manager(f);
  await m.colibri('install','coder');assert.equal((await settled(m)).job.state,'failed');assert.deepEqual(f.calls,[]);
});
test('Colibri context changes check current memory and preserve the old preference on failure',async()=>{
  const f=fixture(),m=await manager(f),rows=[{key:'colibri/coder',provider:'colibri',enabled:true,availableContextWindows:[2048,4096,8192]}];
  await m.setContext(rows[0].key,2048,rows);assert.equal(m.requestedContext(rows[0].key),2048);
  f.status.running=true;await assert.rejects(m.setContext(rows[0].key,8192,rows),/Unload/);
  f.status.running=false;f.colibri.colibriPlan=async()=>({fits:false});await assert.rejects(m.setContext(rows[0].key,8192,rows),/free memory/);assert.equal(m.requestedContext(rows[0].key),2048);
  f.colibri.colibriPlan=async()=>({fits:true});await m.setContext(rows[0].key,4096,[{...rows[0],enabled:false}]);assert.equal(m.requestedContext(rows[0].key),4096);
  const checked=[];f.colibri.colibriPlan=async value=>{checked.push(value);return{fits:true,contextWindow:8192};};
  await m.setContext(rows[0].key,'auto',rows);assert.deepEqual(checked,[undefined]);assert.equal(m.requestedContext(rows[0].key),undefined);
});
test('Colibri preload is installed once and repairs the prior release bridge',()=>{
  assert.equal(patchModelPreload(modelPreload),modelPreload);
  const old=modelPreload.replace("\n  colibri:(action,model)=>ipcRenderer.invoke('notch-models:colibri',action,model),",'');
  assert.equal(patchModelPreload(old),modelPreload);
});

test('backend and benchmark preferences are validated by the engine and catalog includes disabled choices',async()=>{
  const backends=[{backend:'vulkan',available:true},{backend:'cuda',available:false,reason:'No NVIDIA GPU'}];
  const f=fixture({async colibriCompatibility(){return{backends,gpu:'AMD Radeon 8060S'};},async setColibriPreference(key,value){if(value==='cuda')throw new Error('No NVIDIA GPU');f.calls.push([key,value]);}}),m=await manager(f);
  assert.deepEqual((await m.colibri('catalog')).backends,backends);
  await m.colibri('backend','vulkan');await m.colibri('benchmark',false);
  assert.deepEqual(f.calls,[['backend','vulkan'],['benchmarkEnabled',false]]);
  await assert.rejects(m.colibri('backend','cuda'),/No NVIDIA/);
});
