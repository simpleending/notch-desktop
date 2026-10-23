import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchBackgroundProcesses } from '../src/background-process-patch.mjs';

test('compiled background commands hide consoles and retain arguments, callbacks, environment and explicit windows', () => {
  const fixture = `import {spawn as run,execFile as execute} from 'node:child_process';
import {promisify as promise} from 'node:util';
const exec=promise(execute);
run('cmd.exe',['/c','vol C:'],{stdio:'pipe'});
exec('powershell.exe',['-NoProfile'],{timeout:5000});
execute('git',['status'],{env:{GIT_OPTIONAL_LOCKS:'0'}},()=>{});
run('helper.exe',[],options);
run('helper.exe',[]);
execute('git',['version'],()=>{});
run('explicit.exe',[],{windowsHide:false});`;
  const patched = patchBackgroundProcesses(fixture);
  assert.equal(patchBackgroundProcesses(patched), patched);
  const calls = [];
  const scope = vm.createContext({ run: (...args) => calls.push(args), execute: (...args) => calls.push(args), promise: fn => fn, options: { cwd: 'project' } });
  vm.runInContext(patched.replace(/^import[^\n]+\n/gm, ''), scope);
  assert.equal(calls.length, 7);
  for (const args of calls.slice(0, 6)) assert.equal(args[2].windowsHide, true);
  assert.equal(calls[6][2].windowsHide, false);
  assert.equal(JSON.stringify(calls[0].slice(0, 2)), JSON.stringify(['cmd.exe', ['/c', 'vol C:']]));
  assert.equal(calls[1][2].timeout, 5000);
  assert.equal(calls[2][2].env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(typeof calls[2][3], 'function');
  assert.equal(calls[3][2].cwd, 'project');
  assert.equal(typeof calls[5][3], 'function');
});

test('cross-spawn gets the same console default; unrelated application calls remain unchanged', () => {
  assert.equal(patchBackgroundProcesses("import spawn from 'cross-spawn';spawn('git',[],{shell:false});"), "import spawn from 'cross-spawn';spawn('git',[],{windowsHide:true,shell:false});");
  const unrelated = "import {spawn} from './terminal.mjs';spawn('terminal',[],{visible:true});";
  assert.equal(patchBackgroundProcesses(unrelated), unrelated);
});

test('shell command APIs receive options after the command rather than after an argv array', () => {
  const source = "import {execSync as run} from 'node:child_process';run('git rev-parse HEAD',{encoding:'utf8'});";
  const patched = patchBackgroundProcesses(source);
  assert.equal(patched, source.replace("{encoding:", "{windowsHide:true,encoding:"));
  assert.equal(patchBackgroundProcesses(patched), patched);
});

test('namespace, default and CommonJS child-process imports stay quiet, including promisified and no-argv calls',()=>{
  const source=`import cp from 'node:child_process';
import * as children from 'child_process';
import {promisify} from 'node:util';
const cjs=require('child_process');
const {execFile: execute}=require('node:child_process');
const exec=promisify(cp.execFile);
cp.spawn('one',{stdio:'pipe'});
children.execSync('two');cjs.spawn('three',[]);execute('four',[]);exec('five',[]);
require('child_process').exec('six');`;
  const patched=patchBackgroundProcesses(source);
  assert.equal((patched.match(/windowsHide:true/g)||[]).length,6);
  assert.equal(patchBackgroundProcesses(patched),patched);
  assert.match(patched,/spawn\('one',\{windowsHide:true,stdio/);
});

test('bundled CommonJS and namespace promisify calls also get quiet defaults',()=>{
  const source=`import * as util from 'node:util';import cp from 'child_process';
const exec=util.promisify(cp.execFile);exec('one',[]);
var child=__toESM(require('node:child_process'));
var helpers=require('node:util');var run=helpers.promisify(child.default.execFile);run('two',[]);
cp.spawn('three',[],);`;
  const patched=patchBackgroundProcesses(source);
  assert.equal((patched.match(/windowsHide:true/g)||[]).length,3);
  assert.equal(patchBackgroundProcesses(patched),patched);
});
