import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli, localModels, installLocalModel } from '../src/cli-bridge.mjs';
test('bridge passes literal arguments, preserves Unicode and validates catalog output', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-desktop-'));
  try {
    const entry = path.join(cwd, 'fixture.mjs');
    await writeFile(entry, 'console.log(JSON.stringify({hardware:{platform:"test"},models:[],args:process.argv.slice(2),label:"模型 🚀"}));');
    const data = await localModels({ runner: 'ollama', cwd, entry });
    assert.deepEqual(data.args, ['models', 'recommend', '--json', '--runner', 'ollama']);
    assert.equal(data.label, '模型 🚀');
    const literal = await runCli(['hello; echo secret', '$(do-not-run)'], { cwd, entry });
    assert.deepEqual(JSON.parse(literal.stdout).args, ['hello; echo secret', '$(do-not-run)']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test('installation refuses unsafe repositories and unsupported runners before spawning', () => {
  assert.throws(() => installLocalModel('../model', 'ollama'), /repository/);
  assert.throws(() => installLocalModel('owner/model;echo', 'ollama'), /repository/);
  assert.throws(() => installLocalModel('owner/model', 'unknown'), /ollama or mlx/);
});

test('desktop downloads use the file-only entry without a coding task or model selection',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-download-entry-')),entry=path.join(cwd,'fixture.mjs');
 try{
  await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)));');
  const result=await installLocalModel('Nimbus-Labs/Nimbus-4B-GGUF','ollama',{cwd,entry});
  assert.deepEqual(JSON.parse(result.stdout),['install','--model','Nimbus-Labs/Nimbus-4B-GGUF','--runner','ollama','--yes','--no-launch']);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('bridge rejects nonzero exits and supports cancellation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-desktop-'));
  try {
    const entry = path.join(cwd, 'fixture.mjs');
    await writeFile(entry, 'console.error("tool probe failed");process.exitCode=1;');
    await assert.rejects(runCli([], { cwd, entry }), /tool probe failed/);
    await writeFile(entry, 'setInterval(()=>{},1000);');
    await assert.rejects(runCli([], { cwd, entry, signal: AbortSignal.timeout(100) }), /aborted|Abort/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('cancelling a download stops its helper process and releases inherited output pipes', async () => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-download-cancel-')),controller=new AbortController();
  let helper;
  try {
    const entry=path.join(cwd,'fixture.mjs');
    await writeFile(entry,`import {spawn} from 'node:child_process';import fs from 'node:fs';const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync('helper.pid',String(helper.pid));console.log('ready');setInterval(()=>{},1000);`);
    const task=runCli([],{cwd,entry,signal:controller.signal,onOutput:()=>controller.abort()});
    await assert.rejects(Promise.race([task,new Promise((_,reject)=>setTimeout(()=>reject(Error('Cancellation left the download stuck')),8000).unref())]),/aborted|Abort/);
    helper=Number(await readFile(path.join(cwd,'helper.pid'),'utf8'));
    assert.throws(()=>process.kill(helper,0),{code:'ESRCH'});
  } finally {
    helper??=Number(await readFile(path.join(cwd,'helper.pid'),'utf8').catch(()=>'0'));
    if(helper)try{process.kill(helper,'SIGKILL');}catch{}
    await rm(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('a stalled CLI reaches its deadline and can be retried',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-download-timeout-')),entry=path.join(cwd,'fixture.mjs');
 const controller=new AbortController(),guard=setTimeout(()=>controller.abort(),2000);
 try{
  await writeFile(entry,'setInterval(()=>{},1000);');
  await assert.rejects(runCli([],{cwd,entry,timeout:100,signal:controller.signal}),/timed out/);
  await writeFile(entry,'console.log("retry ready");');
  assert.match((await runCli([],{cwd,entry})).stdout,/retry ready/);
 }finally{clearTimeout(guard);await rm(cwd,{recursive:true,force:true});}
});
