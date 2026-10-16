import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
const executable=path.resolve(process.argv[2]),cli=path.resolve(process.argv[3]),reportFile=path.resolve(process.argv[4]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-packaged-queue-')),profile=path.join(root,'profile'),home=path.join(root,'home'),cwd=path.join(root,'project');
await fs.mkdir(home);await fs.mkdir(cwd);
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_AUTO_UPDATE:'0',NOTCH_AUTO_DREAM:'0'};
let calls=0,child,app,stdout='',stderr='';const errors=[],checks=[];
const server=createServer(async(req,res)=>{
  const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/api/version')return json({version:'0.40.3'});
  if(req.url==='/api/show')return json({capabilities:['tools'],model_info:{'general.architecture':'fixture','fixture.context_length':8192}});
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);calls++;assert.equal(body.messages.findLast(row=>row.role==='user').content,'CLI_QUEUE_RECEIPT');
  json({message:{role:'assistant',content:'CLI_QUEUE_RECEIPT_OK'},done:true,prompt_eval_count:100,eval_count:5});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const until=async(check,label)=>{for(let i=0;i<1000;i++){if(await check())return;await delay(20);}throw new Error('Timed out: '+label+' '+stdout+' '+stderr);};
try{
  app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.firstWindow();
  await until(()=>app.windows().some(page=>page.url().includes('first-launch-onboarding-overlay')),'setup window');
  const setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));
  await setup.getByRole('button',{name:/^Continue/}).click();
  const setupClosed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await setupClosed;
  await until(()=>app.evaluate(()=>!!globalThis.__notchHost),'host startup');
  await until(()=>app.windows().some(page=>page.url().startsWith('notch-app:')&&!new URL(page.url()).searchParams.has('surface')),'primary window');
  await app.evaluate(async({BrowserWindow},{cwd,home})=>{
    process.env.HOME=home;process.env.USERPROFILE=home;
    const host=globalThis.__notchHost,fixture='ollama/queue-fixture',cloud='openrouter/openai/gpt-4.1';
    host.listModels=async()=>[{key:fixture,provider:'ollama',enabled:true},{key:cloud,provider:'openrouter',enabled:true}];
    host.resolveModelChoice=model=>model||fixture;
    globalThis.__queueQa={queries:[],events:[],started:0};const state=globalThis.__queueQa;
    globalThis.fetch=async(url,options)=>{
      if(!String(url).endsWith('/api/chat'))throw new Error('Unexpected QA provider request: '+url);
      const body=JSON.parse(options.body),prompt=body.messages.findLast(row=>row.role==='user').content;state.started++;
      if(prompt==='IDE_FIRST')await new Promise(resolve=>{state.release=resolve;});
      return new Response(JSON.stringify({message:{role:'assistant',content:'IDE_FIRST_OK'},done:true,prompt_eval_count:100,eval_count:5})+'\n');
    };
    state.start=prompt=>{const query=host.query({cwd,prompt,model:fixture,permissionMode:'read-only',tools:['Read']}),events=[];const done=(async()=>{for await(const event of query)events.push(event);})();state.queries.push({query,done,events});};
    state.start('IDE_FIRST');
    const primary=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('notch-app:')&&!new URL(window.webContents.getURL()).searchParams.has('surface'));
    primary.setSize(1000,700);primary.show();
  },{cwd,home});
  await until(()=>app.evaluate(()=>globalThis.__queueQa.started===1),'first IDE generation');
  await app.evaluate(()=>globalThis.__queueQa.start('IDE_CANCELLED'));
  await until(()=>app.evaluate(()=>globalThis.__notchHost.getQueueStatus().length===1),'IDE waiting task');
  const page=app.windows().find(page=>page.url().startsWith('notch-app:')&&!new URL(page.url()).searchParams.has('surface'));assert.ok(page);
  await page.bringToFront();
  const badge=page.locator('.notch-queue-status');await badge.waitFor({timeout:15000});assert.match(await badge.innerText(),/Waiting for local model/);
  assert.equal(await badge.evaluate(element=>getComputedStyle(element).webkitAppRegion),'no-drag');
  for(const dark of [true,false]){
    const toggle=page.getByRole('switch',{name:'Dark appearance',exact:true});
    if(await toggle.getAttribute('aria-checked')!==String(dark))await toggle.click();
    await page.screenshot({path:reportFile.replace(/\.json$/,dark?'-dark.png':'-light.png')});
    assert.ok(await badge.isVisible());
  }
  checks.push('medium-window-waiting-indicator-both-themes');
  child=spawn(process.execPath,[cli,'--cwd',cwd,'--provider','ollama','--model','fixture','--base-url',base+'/v1','--api-key','fixture-only','--access','read-only','--json','--no-repo-map','--no-update','--no-auto-dream','CLI_QUEUE_RECEIPT'],{env:{...env,HOME:home,USERPROFILE:home},windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const exit=new Promise(resolve=>child.on('close',code=>resolve(code)));
  await until(()=>stdout.includes('Waiting for local model'),'CLI waits behind packaged IDE');assert.equal(calls,0);
  await app.evaluate(async()=>{const qa=globalThis.__queueQa;await qa.queries[1].query.interrupt();await qa.queries[1].done;});
  assert.equal(await app.evaluate(()=>globalThis.__queueQa.started),1);checks.push('cancelled-IDE-waiter-never-inferred');
  await app.evaluate(()=>globalThis.__queueQa.release());assert.equal(await exit,0,stderr);
  assert.equal(calls,1);assert.ok(stdout.includes('CLI_QUEUE_RECEIPT_OK'));checks.push('shared-packaged-IDE-and-CLI-queue');
  await app.evaluate(async()=>{await globalThis.__queueQa.queries[0].done;});
  const state=await app.evaluate(()=>({waiting:globalThis.__notchHost.getQueueStatus(),first:globalThis.__queueQa.queries[0].events.at(-1),cancelled:globalThis.__queueQa.queries[1].events.at(-1)}));
  assert.equal(state.first.result,'IDE_FIRST_OK');assert.equal(state.first.is_error,false);assert.equal(state.cancelled.terminal_reason,'user_interrupted');assert.deepEqual(state.waiting,[]);
  await until(async()=>await badge.count()===0,'waiting indicator clears');assert.deepEqual(errors,[]);
  const report={passed:true,verifiedAt:new Date().toISOString(),executable,cli,root,checks,errors,method:'Packaged Electron application and a separate installed CLI process; isolated profile/home; loopback inference fixtures, no paid calls.'};
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  if(app){await app.evaluate(async()=>{const qa=globalThis.__queueQa;qa?.release?.();for(const row of qa?.queries||[]){await row.query.close();await row.done;}}).catch(()=>{});await app.close().catch(()=>{});}
  if(child?.exitCode===null)child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
