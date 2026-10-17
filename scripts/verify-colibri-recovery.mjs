import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {colibriStatus} from '../vendor/notch-core/desktop-harness.js';

const root=path.join(os.homedir(),'.notch/runtimes/colibri'),configFile=path.join(root,'state/setup.json'),receiptFile=path.join(root,'verified-model.json'),journal=path.join(root,'pending-model.json');
const before=await colibriStatus();assert(before.verified&&!before.running,'Run recovery checks only with a verified, unloaded test model.');
const config=await fs.readFile(configFile,'utf8'),verified=await fs.readFile(receiptFile,'utf8');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-colibri-recovery-')),bad=path.join(directory,'bad-model');await fs.mkdir(bad);await fs.writeFile(path.join(bad,'config.json'),'{"model_type":"unsupported_test_model"}');
const project={provider:{provider:'ollama',model:'previous-selection'}};await fs.writeFile(path.join(directory,'.notch.json'),JSON.stringify(project));
const report={passed:false,checks:[]};
try {
  let failure;
  try {await promisify(execFile)(process.execPath,[path.resolve(process.argv[2]),'models','install','--runner','colibri','--model-dir',bad,'--yes','--no-launch','--cwd',directory],{windowsHide:true,timeout:60000,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key/i.test(key)))});}catch(error){failure=error;}
  assert.equal(failure?.code,1);assert.match(failure.stderr,/not a model colibri recognises|unsupported|no family/i);
  assert.deepEqual(JSON.parse(await fs.readFile(configFile,'utf8')),JSON.parse(config));assert.deepEqual(JSON.parse(await fs.readFile(receiptFile,'utf8')),JSON.parse(verified));assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'.notch.json'),'utf8')),project);
  report.checks.push('Failed import preserves runtime selection, validation receipt and project configuration');
  const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>child.once('exit',resolve));
  await fs.writeFile(journal,JSON.stringify({pid:child.pid,config:JSON.parse(config),verified:JSON.parse(verified)}));await fs.writeFile(configFile,'{"status":"pending"}');
  assert.equal((await colibriStatus()).verified,true);assert.deepEqual(JSON.parse(await fs.readFile(configFile,'utf8')),JSON.parse(config));await assert.rejects(fs.access(journal),{code:'ENOENT'});
  report.checks.push('A dead installer owner restores the saved configuration and verified receipt');
  await fs.writeFile(journal,JSON.stringify({pid:process.pid,config:JSON.parse(config),verified:JSON.parse(verified)}));await fs.writeFile(configFile,'{"status":"pending"}');
  assert.equal((await colibriStatus()).configured,false);assert.equal(JSON.parse(await fs.readFile(configFile,'utf8')).status,'pending');
  report.checks.push('An active installer is not rolled back by model discovery');report.passed=true;
} finally {await fs.writeFile(configFile,config);await fs.writeFile(receiptFile,verified);await fs.unlink(journal).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.writeFile(path.resolve(process.argv[3]),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
