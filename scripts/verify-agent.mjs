import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || '../notch-agent-verification.json');
const directory = await fs.mkdtemp(path.join(os.tmpdir(),'notch-agent-'));
const profile = path.join(directory,'profile'), workspacePath = path.join(directory,'project');
await fs.mkdir(profile); await fs.mkdir(workspacePath);
await fs.writeFile(path.join(workspacePath,'test.mjs'), "import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);assert.throws(()=>sum('2',3),TypeError);assert.throws(()=>sum(NaN,1),TypeError);assert.throws(()=>sum(1,Infinity),TypeError);console.log('SUM_TEST_PASSED');\n");
const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors = [], checks = {}, started = Date.now();
let app, page, sessionId;
async function launch() {
  app = await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
  page = await app.firstWindow();
}
async function debug() { return app.evaluate(()=>globalThis.__notchAgentChecks); }
async function installProbe() {
  await app.evaluate(()=>{
    const host=globalThis.__notchHost,query=host.query.bind(host);
    globalThis.__notchAgentChecks={events:[],approvals:[],requests:[]};
    globalThis.__notchQueries=new Map();
    host.query=request=>{
      const log=globalThis.__notchAgentChecks;
      log.requests.push({model:request.model,cwd:request.cwd,permissionMode:request.permissionMode});
      const nativeApprove=request.canUseTool;
      const wrapped={...request,canUseTool:async(name,input,options)=>{
        const row={name,input,allowed:false,id:options.toolUseID};log.approvals.push(row);
        const decision=await nativeApprove(name,input,options);row.allowed=decision.behavior==='allow';return decision;
      }};
      const result=query(wrapped),emit=result.emit.bind(result);
      globalThis.__notchQueries.set(result.id,result);
      result.emit=event=>{log.events.push({type:event.type,subtype:event.subtype,status:event.status,text:event.result,errors:event.errors,sessionId:event.session_id,streamType:event.event?.type,content:event.message?.content});return emit(event);};
      return result;
    };
  });
}
async function completeTurn(resultCount) {
  const deadline=Date.now()+240000;
  while(Date.now()<deadline) {
    const state=await debug();
    const results=state.events.filter(event=>event.type==='result');
    if(results.length>=resultCount) { assert.equal(results.at(-1).subtype,'success',JSON.stringify(results.at(-1))); return state; }
    const allow=page.getByRole('button',{name:'Allow once',exact:true});
    if(await allow.count() && await allow.first().isVisible()) {
      const requests=state.approvals.filter(request=>!request.allowed);
      assert.ok(requests.length>0,'Visible approval must correspond to an actual tool callback.');
      const request=requests.at(-1);
      if(request.name==='Write' && request.input.file_path.endsWith('sum.mjs')) {
        await assert.rejects(fs.access(path.join(workspacePath,'sum.mjs')));
        checks.writeWaitedForApproval=true;
      }
      await page.screenshot({path:reportFile.replace(/\.json$/,'-approval.png')});
      await allow.first().click();
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('Agent turn did not complete within four minutes.');
}
try {
  await launch();
  let setup;
  const deadline=Date.now()+30000;
  while(!setup && Date.now()<deadline) {setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(setup,'Fresh profile must show setup.');
  await setup.getByRole('button',{name:/^Continue/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  await installProbe();
  const catalog=await page.evaluate(()=>window.notchDesktop.listChatComposerModels({fetchStrategy:'live',executionHostKind:'local',workspaceDirectories:[]}));
  assert.ok(JSON.stringify(catalog).includes('notch-hf-'),'The installed Hugging Face model must be available.');
  await page.getByRole('button',{name:'Open project',exact:true}).click();
  await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});},workspacePath);
  await page.getByText('Click to add a readable and editable folder',{exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox').fill('notch agent check');
  await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Access permissions',exact:true}).click();
  await page.getByRole('menuitem',{name:/^Ask for approval/}).click();
  const composer=page.getByRole('textbox',{name:'New Task',exact:true});
  await composer.fill('Read test.mjs. Create sum.mjs exporting sum(a,b), adding two finite numbers and throwing TypeError for invalid inputs. Run node test.mjs. Report its output.');
  await composer.press('Enter');
  const first=await completeTurn(1);sessionId=first.events.find(event=>event.type==='result').sessionId;
  assert.equal(checks.writeWaitedForApproval,true);
  assert.ok(first.approvals.some(row=>row.name==='Bash' && row.allowed));
  assert.ok(first.events.some(event=>event.content?.some(part=>part.type==='tool_result' && part.content.includes('SUM_TEST_PASSED'))));
  const independent=await promisify(execFile)(process.execPath,['test.mjs'],{cwd:workspacePath,windowsHide:true,timeout:10000});
  assert.match(independent.stdout,/SUM_TEST_PASSED/);checks.independentTest=independent.stdout.trim();
  checks.nativeState=await page.evaluate(id=>window.notchDesktop.getChatSessionExecutionState(id),sessionId);
  assert.equal(checks.nativeState.facts.executionStatus.status,'known');
  assert.equal(checks.nativeState.facts.executionStatus.value,'idle');
  checks.contextUsage=await page.evaluate(id=>window.notchDesktop.getChatSessionContextUsage(id),sessionId);
  assert.ok(checks.contextUsage?.totalTokens>0,'Native context usage must contain provider counts.');
  assert.ok(checks.contextUsage.totalTokens<checks.contextUsage.maxTokens);
  const mounted=(await (await fetch('http://127.0.0.1:11436/api/ps',{signal:AbortSignal.timeout(5000)})).json()).models.find(model=>model.name==='notch-hf-abd14067e8d7:latest');
  assert.ok(mounted,'The real inference model must be mounted.');
  assert.equal(mounted.context_length,checks.contextUsage.maxTokens,'The runtime allocation must match the reported context.');
  checks.allocatedContext=mounted.context_length;checks.gpuAllocation={bytes:mounted.size,bytesVram:mounted.size_vram};
  await page.screenshot({path:reportFile.replace(/\.json$/,'-completed.png')});
  await app.close();app=null;
  await launch();await page.waitForLoadState('domcontentloaded');
  const reopened=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);
  assert.ok(JSON.stringify(reopened).includes('SUM_TEST_PASSED'),'Completed tool output must survive a restart.');
  const persisted=JSON.parse(await fs.readFile(path.join(profile,'notch-sessions',sessionId+'.json'),'utf8'));
  assert.ok(persisted.messages.some(message=>message.role==='tool'));checks.persisted=true;
  assert.equal(persisted.contextUsage.totalTokens,checks.contextUsage.totalTokens);
  await page.evaluate(()=>window.notchDesktop.listChatComposerModels({fetchStrategy:'live',executionHostKind:'local',workspaceDirectories:[]}));
  await installProbe();
  await page.getByText(reopened.summary.title,{exact:true}).first().click();
  const continuation=page.locator('[contenteditable=true][role=textbox]').first();
  const original=await fs.readFile(path.join(workspacePath,'sum.mjs'),'utf8');
  await continuation.fill('Read sum.mjs and answer ONLY SUM_RESUME_VERIFIED if it implements finite-number addition. Do not edit files or execute commands.');
  await continuation.press('Enter');
  const resumed=await completeTurn(1);
  assert.ok(resumed.events.some(event=>event.type==='result' && event.text.includes('SUM_RESUME_VERIFIED')));
  assert.equal(resumed.events.find(event=>event.type==='result').sessionId,sessionId);
  assert.equal(resumed.approvals.length,0);assert.equal(await fs.readFile(path.join(workspacePath,'sum.mjs'),'utf8'),original);
  const savedAgain=JSON.parse(await fs.readFile(path.join(profile,'notch-sessions',sessionId+'.json'),'utf8'));
  assert.ok(savedAgain.messages.length>persisted.messages.length);checks.resumedWithoutReplaying=true;
  const approvalCount=resumed.approvals.length;
  await continuation.fill('Use the Write tool to create cancelled.txt containing CANCELLED_WRITE. Do not run commands.');
  await continuation.press('Enter');
  await page.getByRole('button',{name:'Allow once',exact:true}).first().waitFor({timeout:60000});
  await assert.rejects(fs.access(path.join(workspacePath,'cancelled.txt')));
  assert.ok((await debug()).approvals.length>approvalCount);
  await page.evaluate(id=>window.notchDesktop.interruptChatSession(id),sessionId);
  const interruptDeadline=Date.now()+15000;
  while(Date.now()<interruptDeadline && (await debug()).events.filter(event=>event.type==='result').length<2)await new Promise(resolve=>setTimeout(resolve,100));
  const interrupted=await debug();
  assert.equal(interrupted.events.filter(event=>event.type==='result').length,2);
  assert.equal(interrupted.events.filter(event=>event.type==='result').at(-1).subtype,'error_during_execution');
  await page.getByRole('button',{name:'Allow once',exact:true}).first().waitFor({state:'hidden'});
  await assert.rejects(fs.access(path.join(workspacePath,'cancelled.txt')));checks.cancelledApprovalWithoutWriting=true;
  // Synthetic old turns exercise real compaction without making dozens of inference calls.
  await app.evaluate(async (_electron,id)=>{const query=globalThis.__notchQueries.get(id);if(!query)throw new Error('Missing compaction fixture session');await query.ready;
    const count=Math.ceil((query.state.contextUsage?.maxTokens || 8192)/512);
    for(let i=0;i<count;i++)query.state.messages.push({role:'user',content:`Completed context fixture ${i}.`},{role:'assistant',content:'Completed file review. Tests passed. No outstanding changes. '.repeat(40)});
    await globalThis.__notchHost.saveSession(id,query.state);
  },sessionId);
  await continuation.fill('Reply exactly COMPACTION_UI_VERIFIED. Do not use tools or change files.');await continuation.press('Enter');
  const compacted=await completeTurn(3);
  assert.ok(compacted.events.some(event=>event.subtype==='status'&&event.status==='compacting'));
  assert.ok(compacted.events.some(event=>event.type==='result'&&event.text.includes('COMPACTION_UI_VERIFIED')));
  const compactState=await page.evaluate(id=>window.notchDesktop.getChatSessionExecutionState(id),sessionId);
  assert.equal(compactState.facts.compaction.status,'known');checks.nativeCompaction=compactState.facts.compaction;
  assert.ok((await fs.readdir(path.join(profile,'notch-sessions',sessionId+'.archives'))).length>0);
  assert.equal(await fs.readFile(path.join(workspacePath,'sum.mjs'),'utf8'),original);
  assert.deepEqual(errors,[]);
  const report={passed:true,executable,profile,workspacePath,sessionId,elapsedMs:Date.now()-started,checks,errors};
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,reportFile,sessionId,elapsedMs:report.elapsedMs}));
} catch(error) {
  const state=app?await debug().catch(()=>null):null;
  const body=page?await page.locator('body').innerText().catch(()=>null):null;
  if(page)await page.screenshot({path:reportFile.replace(/\.json$/,'-failure.png')}).catch(()=>{});
  await fs.writeFile(reportFile,JSON.stringify({passed:false,profile,workspacePath,sessionId,error:error.message,state,body,checks,errors},null,2));throw error;
} finally {
  if(app)await app.close().catch(()=>{});
  await fetch('http://127.0.0.1:11436/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'notch-hf-abd14067e8d7:latest',stream:false,keep_alive:0}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
}
