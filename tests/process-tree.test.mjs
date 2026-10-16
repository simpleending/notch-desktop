import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ownedProcessIds,closeQaApp} from '../scripts/process-tree.mjs';
import {EventEmitter} from 'node:events';
test('process ownership excludes old children whose parent PID was reused',()=>{
  const rows=[{ProcessId:10,ParentProcessId:1,CreationDate:1000},{ProcessId:20,ParentProcessId:10,CreationDate:1001},{ProcessId:30,ParentProcessId:20,CreationDate:1002},
    {ProcessId:40,ParentProcessId:10,CreationDate:900},{ProcessId:50,ParentProcessId:40,CreationDate:901}];
  assert.deepEqual([...ownedProcessIds(10,rows)].sort((a,b)=>a-b),[10,20,30]);
  assert.deepEqual([...ownedProcessIds(10,rows.map(row=>({...row,CreationDate:undefined})))],[10]);
});
test('QA close completes when the OS process exits while debugger teardown stays pending',async()=>{
  const child=new EventEmitter();child.exitCode=null;
  await closeQaApp({process:()=>child,close:()=>new Promise(()=>queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);} ))});
});
test('QA close tolerates an already exited process',async()=>{
  await closeQaApp({process:()=>({exitCode:0}),close:()=>{throw Error('An exited process needs no further close');}});
});
test('QA close preserves a debugger error before the OS process exits',async()=>{
  const child=new EventEmitter();child.exitCode=null;
  await assert.rejects(closeQaApp({process:()=>child,close:async()=>{throw Error('close failed')}}),/close failed/);
});
