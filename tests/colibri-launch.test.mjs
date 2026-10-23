import {test} from 'node:test';
import assert from 'node:assert/strict';
import {colibriLaunchPid} from '../vendor/notch-cli/src/providers/colibri-selection.ts';

test('Colibri accepts an official ready/loading PID and rejects a stopped engine immediately',()=>{
 for(const state of ['loading','ready'])assert.equal(colibriLaunchPid(JSON.stringify({state,pid:process.pid})),process.pid);
 for(const report of [{state:'stopped',pid:null},{state:'loading',pid:null},{state:'ready',pid:-1},{state:'ready',pid:'42'},{}])
  assert.throws(()=>colibriLaunchPid(JSON.stringify(report)),/stopped during initialization/);
});
