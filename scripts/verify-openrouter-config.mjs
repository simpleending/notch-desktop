import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-cloud-config-')),profile=path.join(root,'profile'),cwd=path.join(root,'project');
await fs.mkdir(cwd);
await fs.mkdir(profile);
await fs.writeFile(path.join(profile,'openrouter-models.json'),JSON.stringify({at:Date.now(),data:['small','large'].map((size,i)=>({id:'lab/'+size,name:'QA '+size,
  architecture:{input_modalities:['text'],output_modalities:['text']},context_length:i?131072:8192,
  top_provider:{context_length:i?131072:8192,max_completion_tokens:i?4000:512},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}))}));
const receipts=Array.from({length:3},()=>randomUUID()),models=['lab/small','lab/large'],checks=[];
await Promise.all(receipts.map((value,i)=>fs.writeFile(path.join(cwd,`receipt-${i}.txt`),value)));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
let app,page,sessionId;
async function close(){
  if(!app)return;
  const current=app;app=null;
  // Forced exit also checks that the completed transcript was committed before restart.
  await stopOwnedProcesses(current.process().pid,await processSnapshot());
}
async function launch(){
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});page=await app.firstWindow();page.setDefaultTimeout(15000);
}
async function fixture(){
  console.log('Installing isolated OpenRouter fixture');
  await app.evaluate(async()=>{
    const host=globalThis.__notchHost,original=globalThis.fetch;
    const trace=globalThis.__cloudConfig={requests:[],summaries:0,results:[]};
    const fetcher=globalThis.fetch=async(url,options)=>{
      if(!String(url).startsWith('https://openrouter.ai/api/v1/')){
        if(/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(String(url)))return original(url,options);
        throw Error('QA blocks external requests: '+url);
      }
      if(String(url).endsWith('/key'))return Response.json({data:{}});
      if(String(url).endsWith('/models'))return Response.json({data:['small','large'].map((size,i)=>({id:'lab/'+size,name:'QA '+size,
        architecture:{input_modalities:['text'],output_modalities:['text']},context_length:i?131072:8192,
        top_provider:{context_length:i?131072:8192,max_completion_tokens:i?4000:512},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}))});
      if(!String(url).endsWith('/chat/completions'))throw Error('Unexpected QA endpoint');
      const body=JSON.parse(options.body),cap=body.model==='lab/small'?512:4000;
      trace.requests.push({model:body.model,output:body.max_tokens,stream:!!body.stream,tail:body.messages.slice(-3)});
      if(!(body.max_tokens>0&&body.max_tokens<=cap))throw Error('Output exceeds selected model: '+body.max_tokens);
      if(!JSON.stringify(body.messages).includes('CONFIG_DECISION_SQLITE'))throw Error('Compaction lost project decision');
      if(!body.stream){trace.summaries++;return Response.json({id:'qa-summary',model:body.model,choices:[{index:0,message:{role:'assistant',content:'Keep CONFIG_DECISION_SQLITE.'},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:10,total_tokens:1010}});}
      const prompt=JSON.stringify(body.messages.filter(row=>row.role==='user').at(-1));
      const file=/receipt-\d\.txt/.exec(prompt)?.[0];if(!file)throw Error('Receipt request missing');
      const result=body.messages.findLast(row=>row.role==='tool'&&row.tool_call_id==='qa-'+file);
      const delta=result?{content:'CONFIG_DECISION_SQLITE '+result.content}:{tool_calls:[{index:0,id:'qa-'+file,type:'function',function:{name:'read',arguments:JSON.stringify({path:file})}}]};
      const frame=(delta,finish_reason=null)=>({id:'qa-turn',model:body.model,choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:1200,completion_tokens:20,total_tokens:1220}});
      return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({},result?'stop':'tool_calls'))}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    };
    const catalog=await host.modelManager.cloudCatalog(false,true);
    host.modelManager.cloudCatalog=async()=>catalog.map(row=>({...row,enabled:true}));
    host.modelManager.status=async()=>({openrouter:true,huggingface:false,persistentKeys:false,keyLoadError:null,job:null});
    host.modelManager.key=async()=> 'fixture-only-no-live-key';await host.listModels(true);
    if(!host.getCachedModels().some(row=>row.key==='openrouter/lab/small'))throw Error('QA catalog not installed: '+JSON.stringify(catalog));
    const load=host.loadSession.bind(host);host.loadSession=async(...args)=>{
      const state=await load(...args);
      if(!state.messages.length){state.messages.push({role:'user',content:'Original task: preserve CONFIG_DECISION_SQLITE.'},{role:'assistant',content:'Ready.'});
        for(let i=0;i<24;i++)state.messages.push({role:'user',content:i===0?'Project decision CONFIG_DECISION_SQLITE.':'Completed task '+i},{role:'assistant',content:'Routine review complete. '.repeat(150)});}
      return state;
    };
    const query=host.query.bind(host);host.query=request=>{
      const result=query({...request,tools:['Read']}),emit=result.emit.bind(result);
      result.emit=event=>{if(event.type==='result')trace.results.push({...event,model:result.model});return emit(event)};return result;
    };
  });
}
async function select(model){
  console.log('Selecting '+model);
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('tab',{name:'OpenRouter',exact:true}).click();await page.getByRole('searchbox',{name:'Search models'}).fill(model);
  await page.locator(`button[role="option"][title="openrouter/${model}"]`).click();
}
async function turn(index,model){
  console.log('Running receipt '+index+' with '+model);
  const before=await app.evaluate(()=>globalThis.__cloudConfig.results.length),composer=page.locator('[contenteditable=true][role=textbox]').first();
  await composer.fill(`Read receipt-${index}.txt and return its contents.`);await page.locator('button[data-send-button]').click();
  if(index===2){
    // The workbench may restore its query before the probe attaches on restart.
    await page.getByText(new RegExp(receipts[index])).last().waitFor({timeout:30000});
    const until=Date.now()+10000;let saved,trace;
    do{saved=await app.evaluate(async(_electron,{id,cwd})=>globalThis.__notchHost.loadSession(id,cwd),{id:sessionId,cwd});
      if(JSON.stringify(saved.messages.at(-1)).includes(receipts[index]))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
    assert.ok(JSON.stringify(saved.messages.at(-1)).includes(receipts[index]));trace=await app.evaluate(()=>globalThis.__cloudConfig);
    assert.ok(trace.requests.length>=2&&trace.requests.every(row=>row.model===model));checks.push({index,model,requests:trace.requests,savedAfterRestart:true});return;
  }
  await page.waitForFunction(()=>document.querySelector('[contenteditable=true][role=textbox]')!==null);
  const deadline=Date.now()+30000;let trace;
  do{trace=await app.evaluate(()=>globalThis.__cloudConfig);if(trace.results.length>before)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
  const result=trace.results.at(-1);assert.equal(trace.results.length,before+1,JSON.stringify(trace));assert.equal(result.subtype,'success',JSON.stringify(result));
  assert.equal(result.model,'openrouter/'+model);assert.match(result.result,new RegExp(receipts[index]));sessionId=result.session_id;
  checks.push({index,model,requests:trace.requests,summaries:trace.summaries});
}
try{
  await launch();let setup;const until=Date.now()+30000;
  while(!setup&&Date.now()<until){setup=app.windows().find(w=>w.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();await fixture();await select(models[0]);
  await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},cwd);
  await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('Cloud configuration QA');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await turn(0,models[0]);assert.ok(checks[0].summaries>0);await select(models[1]);await turn(1,models[1]);
  const label=await page.getByRole('button',{name:'Model',exact:true}).innerText();await close();
  await launch();await fixture();const reopened=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);await page.getByText(reopened.summary.title,{exact:true}).first().click();
  // The fixture connects after startup; refresh the UI's earlier disconnected catalog.
  await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.keyboard.press('Escape');
  await page.waitForFunction(expected=>document.querySelector('button[aria-label="Model"]')?.innerText===expected,label,{timeout:15000});await turn(2,models[1]);
  const saved=await app.evaluate(async(_electron,{id,cwd})=>globalThis.__notchHost.loadSession(id,cwd),{id:sessionId,cwd});
  assert.match(JSON.stringify(saved.messages),/CONFIG_DECISION_SQLITE/);for(const receipt of receipts)assert.ok(JSON.stringify(saved.messages).includes(receipt));
  assert.doesNotMatch(JSON.stringify(saved),/fixture-only-no-live-key/);
  const report={passed:true,live:false,executable,profile,sessionId,checks};await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});
  const trace=app?await app.evaluate(()=>globalThis.__cloudConfig).catch(()=>null):null;
  await fs.writeFile(reportFile,JSON.stringify({passed:false,live:false,executable,profile,checks,trace,error:error.message},null,2));throw error;
}finally{await close();}
