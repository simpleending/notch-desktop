import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-model-package-')),profile=path.join(directory,'profile');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const families=[{model:'notch-hf-abd14067e8d7:latest',architecture:'qwen35'},{model:'notch-hf-44f890f704fc:latest',architecture:'gemma4'}];
const checks=[],errors=[];let app;
try {
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  const deadline=Date.now()+30000;let setup;
  while(!setup && Date.now()<deadline){setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(setup,'The installed app must complete first launch.');
  await setup.getByRole('button',{name:/^Continue/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  for(const family of families){
    const receipt=`MODEL_RECEIPT_${randomUUID().replaceAll('-','')}`,cwd=path.join(directory,family.architecture);await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,'receipt.txt'),receipt);
    const metadata=await (await fetch('http://127.0.0.1:11436/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:family.model}),signal:AbortSignal.timeout(15000)})).json();
    assert.equal(metadata.model_info['general.architecture'],family.architecture);
    const nativeContext=metadata.model_info[`${family.architecture}.context_length`];
    const result=await app.evaluate(async(_electron,{cwd,model})=>{
      const host=globalThis.__notchHost,rows=await host.listModels(true),key=`ollama/${model}`;
      const selected=rows.find(row=>row.key===key && row.enabled);if(!selected)throw new Error('Model is unavailable in the installed picker: '+key);
      const query=host.query({cwd,model:key,permissionMode:'read-only',tools:['Read'],prompt:'Use the Read tool to read receipt.txt. Reply with only its contents. Do not guess, edit files or execute commands.',canUseTool:async()=>({behavior:'deny',message:'QA allows only reads.'})});
      const events=[];for await(const event of query)events.push(event);
      return {selected,events,usage:await query.getContextUsage()};
    },{cwd,model:family.model});
    const completed=result.events.findLast(event=>event.type==='result');assert.equal(completed?.subtype,'success',JSON.stringify(completed));
    assert.ok(result.events.some(event=>event.message?.content?.some(part=>part.type==='tool_result' && String(part.content).includes(receipt))),'Native Read result must contain the independent receipt.');
    assert.ok(String(completed.result).includes(receipt),'The model must consume its own tool-result format.');
    assert.equal(result.selected.maxInputTokens,nativeContext);assert.ok(result.usage.totalTokens>0);assert.ok(result.usage.maxTokens<=nativeContext);
    const mounted=(await (await fetch('http://127.0.0.1:11436/api/ps',{signal:AbortSignal.timeout(5000)})).json()).models.find(row=>row.name===family.model);
    assert.equal(mounted?.context_length,result.usage.maxTokens);
    assert.equal(await fs.readFile(path.join(cwd,'receipt.txt'),'utf8'),receipt);
    checks.push({model:family.model,architecture:family.architecture,nativeContext,allocatedContext:mounted.context_length,usage:result.usage,toolResultRoundTrip:true});
    await fetch('http://127.0.0.1:11436/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:family.model,stream:false,keep_alive:0}),signal:AbortSignal.timeout(10000)});
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,profile,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
} catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,profile,checks,errors,error:error.message},null,2));throw error;}
finally {if(app)await app.close().catch(()=>{});for(const {model} of families)await fetch('http://127.0.0.1:11436/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,stream:false,keep_alive:0}),signal:AbortSignal.timeout(10000)}).catch(()=>{});}
