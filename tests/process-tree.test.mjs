import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ownedProcessIds} from '../scripts/process-tree.mjs';
test('process ownership excludes old children whose parent PID was reused',()=>{
  const rows=[{ProcessId:10,ParentProcessId:1,CreationDate:1000},{ProcessId:20,ParentProcessId:10,CreationDate:1001},{ProcessId:30,ParentProcessId:20,CreationDate:1002},
    {ProcessId:40,ParentProcessId:10,CreationDate:900},{ProcessId:50,ParentProcessId:40,CreationDate:901}];
  assert.deepEqual([...ownedProcessIds(10,rows)].sort((a,b)=>a-b),[10,20,30]);
  assert.deepEqual([...ownedProcessIds(10,rows.map(row=>({...row,CreationDate:undefined})))],[10]);
});
