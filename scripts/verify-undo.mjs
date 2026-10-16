import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { verifyPluginCatalog } from '../src/plugin-integrity.mjs';
import { verifyRecovery, verifyInterruptedUndo } from './verify-recovery.mjs';
import { cloudModelRows } from '../src/model-policy.mjs';
const cloudRow=cloudModelRows([{id:'fixture/chat',name:'Cloud verification',context_length:8192,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}],true)[0];
const args=process.argv.slice(2).filter(arg=>!['--recovery','--cloud-worktrees'].includes(arg));
const executable=path.resolve(args[0]);
const reportFile=path.resolve(args[1]||'release/stable-undo-plugins.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-stable-undo-'));const profile=path.join(root,'profile'),workspace=path.join(root,'project');await fs.mkdir(profile);await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'file.txt'),'original');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
let app,page,sessionId;const checks={},errors=[];checks.errors=errors;
async function launch(){app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});app.on('window',w=>w.on('pageerror',e=>errors.push(e.stack||e.message)));await app.evaluate((_electron,flags)=>{globalThis.__notchRecoveryFixture=flags.recovery;globalThis.__notchCloudWorkspaceFixture=flags.cloud;globalThis.__notchCloudWorkspaceRow=flags.row;if(flags.cloud){process.env.HOME=flags.home;process.env.USERPROFILE=flags.home;}},{recovery:process.argv.includes('--recovery'),cloud:process.argv.includes('--cloud-worktrees'),home:root,row:cloudRow});await probe();page=await app.firstWindow();}
async function openSavedSession(){
 const restored=await page.evaluate(id=>window.notchDesktop.openChatSession(id),sessionId);
 await page.getByText(restored.summary.title,{exact:true}).first().click();
 await page.locator('[data-message-kind="user"]').filter({hasText:'Undo check one'}).first().waitFor();
 await page.waitForFunction(()=>{const model=document.querySelector('button[aria-label="Model"]');return model&&!model.innerText.includes('Loading models');});
}
async function probe(){await app.evaluate(()=>{
 const host=globalThis.__notchHost,query=host.query.bind(host),original=globalThis.fetch;
 const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.map(block=>block.text||'').join('\n'):'';
 const isFixture=value=>/^Undo check (one|two|three)$/.test(textOf(value).trim());
 // Inference is mocked: recovery QA must not depend on memory available to a real model.
 if(globalThis.__notchCloudWorkspaceFixture){
  const row=globalThis.__notchCloudWorkspaceRow,key=row.key;row.isDefault=true;
  host.listModels=async()=>[row];host.getCachedModels=()=>[row];host.getDefaultModel=()=>key;host.resolveModelChoice=()=>key;
  host.modelManager.key=async()=>'fixture-only';
 }else if(globalThis.__notchRecoveryFixture)host.resolveModelChoice=()=>{
  const row=host.getCachedModels().find(row=>row.provider==='ollama'&&row.key!=='auto');
  if(!row)throw Error('Recovery fixture needs local model metadata');
  return row.key;
 };
 globalThis.__undoTrace={results:[],inputs:[]};
 host.query=request=>{const prompt=request.prompt;let fixtureInput=isFixture(prompt);async function* wrapped(){for await(const input of prompt){if(isFixture(input.message?.content)){fixtureInput=true;globalThis.__undoTrace.inputs.push({uuid:input.uuid,keys:Object.keys(input)});}yield input;}}
 const result=query({...request,tools:['Read','Write','Edit','ApplyPatch','Bash'],prompt:typeof prompt==='string'?prompt:wrapped()}),emit=result.emit.bind(result);result.emit=e=>{if(e.type==='result'&&fixtureInput)globalThis.__undoTrace.results.push(e);return emit(e)};return result;};
 globalThis.fetch=async(url,options)=>{
  const target=typeof url==='string'?url:url.url||String(url);if(!target.endsWith('/api/chat')&&!target.endsWith('/v1/chat/completions'))return original(url,options);
  const body=JSON.parse(options.body);const userIndex=body.messages.map(m=>m.role==='user').lastIndexOf(true),user=body.messages[userIndex]?.content,prompt=textOf(user);
  const fixture=isFixture(user),toolResults=body.messages.slice(userIndex+1).filter(m=>m.role==='tool'),reply=fixture?'File change complete.':'{"recap":"Recovery verification in progress."}';
  const third=prompt.includes('Undo check three'),content=prompt.includes('Undo check two')?'two':'one',file=third?'created.txt':'file.txt';
  const done=!fixture||toolResults.length>=(third?1:2);
  const call=!third&&!toolResults.length?{id:'read-before-change',function:{name:'read',arguments:{path:file}}}:{id:'change-'+(third?'third':content),function:third?{name:'apply_patch',arguments:{input:'*** Begin Patch\n*** Add File: created.txt\n+new\n*** End Patch'}}:content==='two'?{name:'edit',arguments:{path:file,old_string:'one',new_string:'two'}}:{name:'write',arguments:{path:file,content}}};
  if(globalThis.__notchCloudWorkspaceFixture&&call.function.name!=='read')call.function={name:'shell',arguments:{command:`node -e "require('fs').writeFileSync('${file}','${third?'new':content}')"`}};
  if(target.endsWith('/api/chat'))return new Response(JSON.stringify({model:body.model,message:{role:'assistant',content:done?reply:'',...(done?{}:{tool_calls:[call]})},done:true,done_reason:'stop',prompt_eval_count:1500,eval_count:30})+'\n',{headers:{'Content-Type':'application/x-ndjson'}});
  const delta=done?{content:reply}:{tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.function.name,arguments:JSON.stringify(call.function.arguments)}}]};
  const chunk={id:'undo-fixture',model:body.model,choices:[{index:0,delta,finish_reason:null}]};const end={...chunk,choices:[{index:0,delta:{},finish_reason:done?'stop':'tool_calls'}],usage:{prompt_tokens:1500,completion_tokens:30,total_tokens:1530}};
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };
});}
async function complete(count){const until=Date.now()+45000;while(Date.now()<until){const trace=await app.evaluate(()=>globalThis.__undoTrace);if(trace.results.length>=count){assert.equal(trace.results.at(-1).subtype,'success',JSON.stringify(trace.results.at(-1)));sessionId=trace.results.at(-1).session_id;return;}
 const allow=page.getByRole('button',{name:'Allow once',exact:true});if(await allow.count()&&await allow.first().isVisible())await allow.first().click();await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture turn timeout');}
try{
 checks.catalog=await verifyPluginCatalog(path.join(path.dirname(executable),'resources/extensions'));
 await launch();let setup;const until=Date.now()+30000;while(!setup&&Date.now()<until){setup=app.windows().find(w=>w.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(r=>setTimeout(r,100));}assert.ok(setup);
 await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 checks.pluginApis=await page.evaluate(()=>Object.keys(window.notchDesktop).filter(k=>/plugin|extension/i.test(k)));
 checks.plugins=await page.evaluate(async()=>({installed:await window.notchDesktop.listInstalledExtensions(),views:await window.notchDesktop.listAppPluginViews()}));
 assert.ok(JSON.stringify(checks.plugins).includes('notch.canvas'),'The bundled canvas plugin must load through the real host.');
 assert.ok(!JSON.stringify(checks.plugins).includes('APP_PLUGIN_INTEGRITY_FAILED'));
 await page.evaluate(()=>window.notchDesktop.listChatComposerModels({fetchStrategy:'live',executionHostKind:'local',workspaceDirectories:[]}));
 await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})},workspace);await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('undo reliability');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 for(const [i,prompt]of ['Undo check one','Undo check two','Undo check three'].entries()){const composer=page.locator('[contenteditable=true][role=textbox]').first();await composer.fill(prompt);await composer.press('Enter');await complete(i+1);}
 assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'two');assert.equal((await fs.readFile(path.join(workspace,'created.txt'),'utf8')).trim(),'new');
 checks.inputs=await app.evaluate(()=>globalThis.__undoTrace.inputs);
 const db=new DatabaseSync(path.join(profile,'main.sqlite'),{readOnly:true});let changes;
 try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();const table=tables.find(t=>db.prepare('PRAGMA table_info('+t.name+')').all().some(c=>c.name==='checkpoint_user_message_id'));if(!table)throw new Error('No native changes table');changes=db.prepare('SELECT change_set_id,turn_id,checkpoint_user_message_id FROM '+table.name+' WHERE session_id=? ORDER BY ordinal').all(sessionId);}finally{db.close();}
 checks.sessionId=sessionId;checks.changeSets=changes;assert.equal(changes.length,3);assert.deepEqual(changes.map(r=>r.checkpoint_user_message_id),checks.inputs.map(r=>r.uuid));
 await page.screenshot({path:reportFile.replace('.json','-before.png')});
 if(process.argv.includes('--recovery'))checks.recovery=await verifyRecovery({app,profile,workspace,sessionId,changes,
  restart:async({early=false}={})=>{await launch();if(!early){await page.waitForLoadState('domcontentloaded');await openSavedSession();}return app;},
  stopped:()=>{app=null;}});
 await app.close();app=null;
 await launch();await page.waitForLoadState('domcontentloaded');await openSavedSession();
 const target={sessionId,changeSetId:changes[1].change_set_id};const preview=await page.evaluate(v=>window.notchDesktop.previewTurnFileChangesUndo(v),target);checks.preview=preview;assert.equal(preview.canRewind,true,JSON.stringify(preview));assert.equal(preview.filesChanged.length,2);
 assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'two');assert.equal((await fs.readFile(path.join(workspace,'created.txt'),'utf8')).trim(),'new');
 await fs.writeFile(path.join(workspace,'file.txt'),'manual edit');const conflict=await page.evaluate(v=>window.notchDesktop.previewTurnFileChangesUndo(v),target);assert.equal(conflict.canRewind,false);assert.match(conflict.error,/changed since/);assert.equal((await fs.readFile(path.join(workspace,'created.txt'),'utf8')).trim(),'new');checks.manualEditProtected=true;
 await fs.writeFile(path.join(workspace,'file.txt'),'two');checks.restored=process.argv.includes('--recovery')?await verifyInterruptedUndo({app,workspace,undoFile:path.join(profile,'notch-undo',sessionId+'.json'),target,
  restart:async()=>{await launch();await page.waitForLoadState('domcontentloaded');await openSavedSession();return app;},stopped:()=>{app=null;}}):await page.evaluate(v=>window.notchDesktop.undoTurnFileChanges(v),target);assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'one');await assert.rejects(fs.access(path.join(workspace,'created.txt')));
 const first={sessionId,changeSetId:changes[0].change_set_id};const firstPreview=await page.evaluate(v=>window.notchDesktop.previewTurnFileChangesUndo(v),first);assert.equal(firstPreview.canRewind,true,JSON.stringify(firstPreview));
 const undo=page.locator('[data-file-changes-summary]').getByRole('button',{name:'Undo',exact:true});await undo.waitFor();assert.equal(await undo.count(),1,'Only the first tracked turn remains available to undo');await undo.scrollIntoViewIfNeeded();await undo.click();
 const confirm=page.getByRole('button',{name:'Undo file changes',exact:true});await confirm.waitFor();
 assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'one','The confirmation dialog must not change files.');
 await confirm.click();await confirm.waitFor({state:'hidden'});const undoDeadline=Date.now()+15000;
 while(Date.now()<undoDeadline){const history=JSON.parse(await fs.readFile(path.join(profile,'notch-undo',sessionId+'.json'),'utf8'));if(await fs.readFile(path.join(workspace,'file.txt'),'utf8')==='original'&&history.checkpoints.length===0)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'original');checks.nativeUndoButton=true;checks.allTurnsRestored=true;
 checks.remaining=JSON.parse(await fs.readFile(path.join(profile,'notch-undo',sessionId+'.json'),'utf8')).checkpoints.length;assert.equal(checks.remaining,0);
 await page.screenshot({path:reportFile.replace('.json','-after.png')});assert.deepEqual(errors,[]);checks.errors=errors;checks.passed=true;
}catch(error){checks.failure=error.stack||String(error);if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});throw error;}finally{if(app)await app.close();checks.root=root;checks.executable=executable;await fs.writeFile(reportFile,JSON.stringify(checks,null,2));console.log(JSON.stringify({passed:checks.passed,catalog:checks.catalog,changeSets:checks.changeSets?.length,preview:checks.preview,manualEditProtected:checks.manualEditProtected,allTurnsRestored:checks.allTurnsRestored,root,failure:checks.failure}));}
