import { _electron } from 'electron-qa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'analysis/local-ssh-verification.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-ssh-')),profile=path.join(root,'profile'),identity=path.join(root,'identity'),config=path.join(root,'ssh-config');
const remotePath='/tmp/notch-ssh-'+path.basename(root),exec=promisify(execFile),checks=[],errors=[],requests=[];let app,server,keepAlive,passed=false,failure;
const distro=process.env.NOTCH_QA_WSL_DISTRO||'Strix-Ubuntu-24.04';
const linux=command=>exec('wsl.exe',['-d',distro,'--exec','/bin/sh','-c',command],{windowsHide:true,timeout:30000});
try{
 keepAlive=spawn('wsl.exe',['-d',distro,'--','sh','-c','cat >/dev/null'],{windowsHide:true,stdio:['pipe','ignore','ignore']});
 await exec('ssh-keygen.exe',['-t','ed25519','-N','','-f',identity],{windowsHide:true,timeout:10000});
 server=spawn('python',['tests/fixtures/ssh-server.py',identity+'.pub',distro],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let serverErrors='';server.stderr.on('data',data=>{serverErrors=(serverErrors+data).slice(-4000)});
 const ready=await new Promise((resolve,reject)=>{const lines=createInterface({input:server.stdout});const timer=setTimeout(()=>reject(Error('SSH fixture startup timed out: '+serverErrors)),15000);lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line))});server.once('exit',code=>{clearTimeout(timer);reject(Error('SSH fixture exited '+code+': '+serverErrors))})});
 const knownHosts=path.join(root,'known-hosts');await fs.writeFile(knownHosts,`[127.0.0.1]:${ready.port} ${ready.hostKey}\n`);
 await fs.writeFile(config,`Host notch-local-test\n  HostName 127.0.0.1\n  Port ${ready.port}\n  User notch-test\n  IdentityFile "${identity.replaceAll('\\','/')}"\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile "${knownHosts.replaceAll('\\','/')}"\n`);
 await linux(`mkdir -p '${remotePath}/src'; printf 'original\\n' > '${remotePath}/sample.txt'; printf 'search needle\\n' > '${remotePath}/src/example.txt'; git -C '${remotePath}' init -q`);
 app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),timeout:45000});
 app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.evaluate(async(_electron,config)=>{
  const native=globalThis.__notchHost.remoteSsh.nativeSshService,spawn=native.platform.spawn.bind(native.platform),fs=process.getBuiltinModule('fs/promises');
  native.platform.spawn=(executable,args,env)=>spawn(executable,['-F',config,...args],env);
  const spawnPty=native.platform.spawnPty.bind(native.platform);native.platform.spawnPty=(executable,args,...rest)=>spawnPty(executable,['-F',config,...args],...rest);
  native.platform.readConfiguration=()=>fs.readFile(config,'utf8');
  const run=native.run.bind(native);globalThis.__sshQaRemoteTrace=[];native.run=async request=>{const result=await run(request);globalThis.__sshQaRemoteTrace.push({exitCode:result.exitCode,stdout:result.stdout.slice(0,1500),stderr:result.stderr.slice(0,1500)});return result;};
  const fetcher=globalThis.fetch;globalThis.__sshQaRequests=[];globalThis.fetch=(url,options)=>{globalThis.__sshQaRequests.push(String(url));return fetcher(url,options)};
 },config);
 let setup;for(let i=0;i<300;i++){setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));if(setup)break;await new Promise(resolve=>setTimeout(resolve,100));}
 if(setup){await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;}
 const page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 assert.deepEqual(await page.evaluate(()=>window.notchDesktop.getRemoteSshAvailability()),{supported:true});
 const host=await page.evaluate(()=>window.notchDesktop.registerRemoteSshHost({alias:'notch-local-test',label:'Local SSH test'}));
 const connection=await page.evaluate(hostId=>window.notchDesktop.connectRemoteSshHost({hostId}),host.id);
 assert.equal(connection.ok,true,JSON.stringify({connection,trace:await app.evaluate(()=>globalThis.__sshQaRemoteTrace),serverErrors}));assert.equal(connection.executionMode,'ssh-local-agent');checks.push('real OpenSSH key authentication with strict host-key checking; no managed runtime installation');console.log(checks.at(-1));
 const workspace=await page.evaluate(({hostId,path})=>window.notchDesktop.resolveRemoteSshWorkspace({hostId,path,executionMode:'ssh-local-agent'}),{hostId:host.id,path:remotePath});
 const target={mode:'ssh-local-agent',host:{kind:'ssh',id:host.id},workspace:{id:workspace.workspaceId,path:workspace.path}};
 const result=await app.evaluate(async(_electron,target)=>{
  const host=globalThis.__notchHost;
  const remote=await host.remoteWorkspace(target),read=await remote.execute('read',{path:'sample.txt'}),glob=await remote.execute('glob',{pattern:'**/*.txt'}),grep=await remote.execute('grep',{pattern:'needle',max_results:20});
  const undo=await host.openCheckpoints('ssh-direct',target.workspace.path,target);await undo.beginTurn('ssh-turn');await undo.recordBefore(target.workspace.path+'/sample.txt');
  const edit=await remote.execute('edit',{path:'sample.txt',old_string:'original',new_string:'updated'});await undo.recordAfter();await undo.commit('SSH edit');
  const shell=await remote.execute('shell',{command:'printf SSH_SHELL_OK; git status --short'});
  await undo.undo('ssh-turn');const restored=await remote.execute('read',{path:'sample.txt'});
  const escape=await remote.execute('read',{path:'../outside'});
  return {read,glob,grep,edit,shell,restored,escape};
 },target);
 assert.match(result.read.content,/original/);assert.match(result.glob.content,/example.txt/);assert.match(result.grep.content,/needle/);assert.equal(result.edit.isError,undefined);assert.match(result.shell.content,/SSH_SHELL_OK/);assert.match(result.restored.content,/original/);assert.equal(result.escape.isError,true);checks.push('remote read/glob/grep, edit, shell/Git and persisted undo use the remote POSIX filesystem; traversal rejected');
 const harness=await app.evaluate(async(_electron,target)=>{
  const host=globalThis.__notchHost,model='ollama/notch-hf-abd14067e8d7:latest',models=await host.listModels(true),approvals=[];
  await host.modelManager.setContext(model,8192,models);
  const query=host.query({sessionId:'ssh-harness',cwd:target.workspace.path,executionTarget:target,model,permissionMode:'default',tools:['Read','Edit'],maxTurns:6,prompt:'Use Read to read sample.txt, then Edit to replace original with SSH_HARNESS_DONE. Reply DONE after the edit.',canUseTool:async(name,input)=>{approvals.push(name);return {behavior:'allow',updatedInput:input}}});
  const results=[];for await(const event of query)if(event.type==='result')results.push(event);
  const remote=await host.remoteWorkspace(target),written=await remote.execute('read',{path:'sample.txt'}),checkpoints=await host.openCheckpoints('ssh-harness',target.workspace.path,target),messageId=checkpoints.list().find(row=>row.files.length)?.messageId;
  const rewind=await host.acquireRewind('ssh-harness');let preview;try{preview=await rewind.rewindFiles(messageId,{dryRun:true});await rewind.rewindFiles(messageId,{dryRun:false});}finally{await rewind.release()}
  return {results,approvals,written,preview,restored:await remote.execute('read',{path:'sample.txt'})};
 },target);
 assert.equal(harness.results.at(-1)?.subtype,'success',JSON.stringify(harness));assert.ok(harness.approvals.includes('Edit'));assert.match(harness.written.content,/SSH_HARNESS_DONE/);assert.equal(harness.preview.canRewind,true);assert.match(harness.restored.content,/original/);checks.push('real local Qwen3.5 desktop harness reads/edits remote-only cwd with approval and restores persisted remote Undo');
 await page.evaluate(hostId=>window.notchDesktop.disconnectRemoteSshHost({hostId,executionMode:'ssh-local-agent'}),host.id);
 const reconnected=await page.evaluate(hostId=>window.notchDesktop.connectRemoteSshHost({hostId}),host.id);assert.equal(reconnected.ok,true);checks.push('disconnect and reconnect preserve the registered host');
 await page.getByRole('button',{name:'Open user menu',exact:true}).first().click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();await page.getByRole('navigation',{name:'Settings',exact:true}).getByRole('button',{name:'Connections',exact:true}).click();await page.getByText('Local SSH test',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/sign[ -]?in|log[ -]?in|unavailable in this local build/i);checks.push('Connections settings shows local SSH profiles without an account gate');
 requests.push(...await app.evaluate(()=>globalThis.__sshQaRequests));assert.equal(requests.some(url=>/disabled\.notch\.invalid|qoder\./.test(url)),false);assert.deepEqual(errors,[]);passed=true;
}catch(error){failure=error.stack;if(app)console.log('SSH trace',await app.evaluate(()=>globalThis.__sshQaRemoteTrace).catch(()=>null));throw error;}finally{
 if(app)await app.close().catch(()=>{});server?.kill();await linux(`rm -rf -- '${remotePath}'`).catch(()=>{});keepAlive?.stdin.end();
 await fs.writeFile(reportFile,JSON.stringify({passed,executable,root,remotePath,checks,errors,requests,failure},null,2));console.log(JSON.stringify({passed,reportFile,checks,failure}));
}
