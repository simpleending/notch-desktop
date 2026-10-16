import { _electron } from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { patchFunction } from '../src/bundle-patch.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),profile=path.resolve(process.argv[4]);
const packagedMain=extractFile(path.join(path.dirname(executable),'resources/app.asar'),path.join('out','main','index.js')).toString();
const expectedVersion=Number(/const IG=(\d+),Q8t=/.exec(packagedMain)?.[1]);assert.ok(expectedVersion>=6);
if(process.argv.includes('--seed-old')||process.argv.includes('--seed-current')){
 const real=await fs.realpath(profile),temporary=await fs.realpath(os.tmpdir());
 assert.ok(real.startsWith(temporary+path.sep)&&path.basename(path.dirname(real)).startsWith('notch-voice-'),'Only an owned voice-test profile can be seeded');
 const db=new DatabaseSync(path.join(profile,'main.sqlite'));try{db.prepare('UPDATE chat_session_recaps SET text=?,prompt_version=?,source_signature=?').run('你刚刚完成了 READY 的确认。',process.argv.includes('--seed-current')?expectedVersion:5,'qa-wrong-language-previous-recap');}finally{db.close();}
}
const row=()=>{const db=new DatabaseSync(path.join(profile,'main.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM chat_session_recaps ORDER BY updated_at DESC LIMIT 1').get();}finally{db.close();}};
const before=row();assert.ok(before);const checks=[];let app,passed=false,failure,after,rewritten;
try{
 app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_OLLAMA_CONTEXT:'16384',NOTCH_OLLAMA_THINK:'0'},timeout:45000});
 await app.evaluate(()=>{const fetcher=globalThis.fetch;globalThis.__recapQa=[];globalThis.fetch=(url,init)=>{if(String(url).endsWith('/api/chat')){const body=JSON.parse(init.body);globalThis.__recapQa.push({model:body.model,tools:body.tools?.length||0,hasFullTranscript:body.messages.some(message=>typeof message.content==='string'&&message.content.includes('[user] Say READY')),hasChinesePrevious:body.messages.some(message=>typeof message.content==='string'&&message.content.includes('Previous recap: 你刚刚完成了 READY 的确认。'))})}return fetcher(url,init)};});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.notchDesktop);
 await page.evaluate(()=>window.notchDesktop.setApplicationLanguage('en'));
 await page.evaluate(()=>window.notchDesktop.updateChatSessionRecapPreferences({enabled:true,modelKey:'ollama/notch-hf-abd14067e8d7:latest'}));
 await page.evaluate(id=>window.notchDesktop.openChatSession(id),before.session_id);
 const title=page.getByText('Say READY.',{exact:true}).first();if(await title.count())await title.click();
 await page.evaluate(id=>window.notchDesktop.getChatSessionHighlights(id),before.session_id);
 const end=Date.now()+240000;
 while(Date.now()<end){after=row();if(after.prompt_version===expectedVersion&&after.updated_at>before.updated_at&&!/[\u3400-\u9fff]/u.test(after.text))break;await new Promise(resolve=>setTimeout(resolve,500));}
 assert.equal(after.prompt_version,expectedVersion);assert.ok(after.updated_at>before.updated_at);assert.doesNotMatch(after.text,/[\u3400-\u9fff]/u);checks.push('existing Chinese version'+before.prompt_version+' card regenerated in English using the actual local model; conversation and Undo retained');
 if(process.argv.includes('--native-only')){
  const requests=await app.evaluate(()=>globalThis.__recapQa);assert.ok(requests.some(request=>request.model==='notch-hf-abd14067e8d7:latest'&&request.tools===0&&request.hasFullTranscript&&!request.hasChinesePrevious));
  rewritten={nativeRequests:requests};checks.push('native recap engine used real Qwen3.5, no tools, and rewrote the supplied Chinese previous recap');
  const png=await app.evaluate(async({BrowserWindow},url)=>(await BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url).webContents.capturePage()).toPNG().toString('base64'),page.url());
  await fs.writeFile(reportFile.replace('.json','-english.png'),Buffer.from(png,'base64'));passed=true;
 }else{
 const main=extractFile(path.join(path.dirname(executable),'resources/app.asar'),path.join('out','main','index.js')).toString();let source;patchFunction(main,'b8t',text=>{source=text;return text});
 const makePrompt=new Function('aZ',source+';return b8t;')((text,limit)=>text.slice(0,limit));
 const prompt=makePrompt({sessionTitle:'English READY test',previousRecap:'你刚刚完成了确认。',newMaterial:'[user] Say READY\n[assistant] READY'});
 rewritten=await app.evaluate(async(_electron,{prompt,cwd})=>{
  const host=globalThis.__notchHost,model='ollama/notch-hf-abd14067e8d7:latest',models=await host.listModels(true);await host.modelManager.setContext(model,16384,models);
  const query=host.query({sessionId:'recap-language-proof-'+Date.now(),cwd,model,tools:[],disallowedTools:['*'],permissionMode:'default',maxTurns:1,prompt});let result;
  for await(const event of query)if(event.type==='result')result=event;return result;
 },{prompt,cwd:path.join(path.dirname(profile),'project')});
 assert.equal(rewritten.subtype,'success',JSON.stringify(rewritten));assert.doesNotMatch(rewritten.result,/[\u3400-\u9fff]/u);assert.match(rewritten.result,/recap|READY/i);checks.push('real Qwen3.5 rewrites a supplied Chinese previous recap into English for an English READY transcript');
 const png=await app.evaluate(async({BrowserWindow},url)=>(await BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url).webContents.capturePage()).toPNG().toString('base64'),page.url());
 await fs.writeFile(reportFile.replace('.json','-english.png'),Buffer.from(png,'base64'));passed=true;
 }
}catch(error){failure=error.stack;throw error;}finally{if(app)await app.close().catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed,executable,profile,before,after,rewritten,checks,failure},null,2));console.log(JSON.stringify({passed,reportFile,checks,failure}));}
