import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const entry=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const key=process.env.OPENROUTER_API_KEY;
assert.ok(key && !/fixture|example|test-only/i.test(key),'Configure a live OPENROUTER_API_KEY; this check never substitutes a fixture.');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-cli-openrouter-')),home=path.join(root,'home'),cwd=path.join(root,'project');
await fs.mkdir(home);await fs.mkdir(cwd);
const modelA='qwen/qwen3-30b-a3b-instruct-2507',modelB='openai/gpt-4o-mini';
const response=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});assert.equal(response.ok,true);
const catalog=(await response.json()).data.filter(row=>[modelA,modelB].includes(row.id));
assert.equal(catalog.length,2);assert.ok(catalog.every(row=>row.supported_parameters.includes('tools')&&row.context_length>=8192));
const traceFile=path.join(root,'network.jsonl'),catalogFile=path.join(root,'models.json');await fs.writeFile(catalogFile,JSON.stringify(catalog));
const code='CLOUD_DECISION_'+randomUUID().replaceAll('-',''),receipts=Array.from({length:3},()=>`FILE_PROOF_${randomUUID().replaceAll('-','')}`);
await fs.writeFile(path.join(cwd,'.notch.md'),'Respond in English. Preserve release decisions. Never write files in read-only mode.');
for(let i=0;i<receipts.length;i++)await fs.writeFile(path.join(cwd,`proof-${i}.txt`),receipts[i]);
await fs.writeFile(path.join(cwd,'.notch.json'),JSON.stringify({provider:{provider:'openrouter',model:modelA,contextWindow:8192}}));
const messages=[{role:'user',content:'Maintain this project and remember project decisions.'},{role:'assistant',content:'Ready.'}];
for(let i=0;i<4;i++)messages.push({role:'user',content:i===0?`The release codename is ${code}. Preserve this exact decision.`:`Completed review ${i}.`},{role:'assistant',content:'Completed routine review; no changes remain. '.repeat(130)});
messages.push({role:'user',content:'Reviews are complete. Preserve the release codename for later.'},{role:'assistant',content:'I will preserve it.'});
const id='live-openrouter-restart',sessionFile=path.join(home,'.notch/sessions',id+'.json'),now=new Date().toISOString();
await fs.mkdir(path.dirname(sessionFile),{recursive:true});await fs.writeFile(sessionFile,JSON.stringify({meta:{id,project:cwd,model:'openrouter/'+modelA,created:now,updated:now,turns:6,preview:'Live OpenRouter compaction'},messages}));
const clients=[],checks=[];
const redact=text=>String(text).replaceAll(key,'[REDACTED]').replace(/sk-or-v1-[A-Za-z0-9_-]+/g,'[REDACTED]');
const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(name))),
  HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),OPENROUTER_API_KEY:key,NOTCH_AUTO_UPDATE:'0',NOTCH_AUTO_DREAM:'0',TERM:'dumb',NO_COLOR:'1',
  NOTCH_OPENROUTER_TRACE_FILE:traceFile,NOTCH_OPENROUTER_CATALOG_FILE:catalogFile};
const readSession=async()=>JSON.parse(await fs.readFile(sessionFile,'utf8'));
const trace=async()=>{try{return (await fs.readFile(traceFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
function launch(prompt){
 const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./openrouter-network-trace.mjs',import.meta.url)),entry,'--cwd',cwd,'--session',id,'--access','read-only','--no-update','--no-auto-dream','--no-repo-map','--no-markdown','--max-iterations','4',...(prompt?[prompt]:[])],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const client={child,stdout:'',stderr:'',closed:new Promise(resolve=>child.once('close',resolve))};
 child.stdout.on('data',chunk=>client.stdout+=redact(chunk));child.stderr.on('data',chunk=>client.stderr+=redact(chunk));if(prompt)child.stdin.end();clients.push(client);return client;
}
async function until(check,label){const end=Date.now()+180000;while(Date.now()<end){if(await check())return;for(const client of clients)if(!client.stopped)assert.ok(client.child.exitCode===null||client.child.exitCode===0,client.stderr);await delay(50);}throw Error('Timed out: '+label+'\n'+clients.map(c=>c.stdout.slice(-1500)+c.stderr.slice(-1500)).join('\n'));}
async function kill(client){client.stopped=true;client.child.kill('SIGKILL');await client.closed;}
async function turn(client,index){
 client.child.stdin.write(`Use the read tool to read proof-${index}.txt. Reply with that file's complete contents and the release codename from our previous conversation. Do not guess or change files.\n`);
 await until(async()=>{const state=await readSession();const last=state.messages.filter(row=>row.role==='assistant').at(-1);return JSON.stringify(last).includes(receipts[index])&&JSON.stringify(last).includes(code);},'live file-tool answer '+index);
}
let passed=false,failure,compacted;
try{
 const first=launch();await until(()=>first.stdout.includes('notch> '),'REPL');first.child.stdin.write('/compact\n');await until(()=>first.stdout.includes('Compressed:'),'semantic compaction');await kill(first);
 compacted=await readSession();assert.ok(compacted.messages.length<messages.length);assert.match(JSON.stringify(compacted.messages),new RegExp(code));
 assert.ok((await trace()).some(row=>row.type==='request'&&!row.stream&&row.messages.some(message=>/summariz|Compress this/i.test(JSON.stringify(message)))));
 assert.ok((await trace()).some(row=>row.type==='response'&&row.responseId&&row.usage));checks.push('real semantic compaction saved before acknowledgement and survived forced termination');
 const second=launch();await until(()=>second.stdout.includes('notch> '),'restart after compaction');await turn(second,0);checks.push('resumed model A retained a middle decision and completed a real file-tool round trip');
 second.child.stdin.write(`/model openrouter/${modelB}\n`);await until(()=>second.stdout.includes('Switched to openrouter/'+modelB),'model switch');await turn(second,1);
 assert.equal((await readSession()).meta.model,'openrouter/'+modelB);checks.push('model A to model B switch preserved history, tools and persisted selection');await kill(second);
 const last=launch("Use the read tool to read proof-2.txt. Reply with that file's complete contents and the release codename from our previous conversation. Do not guess or change files.");
 await until(()=>last.child.exitCode!==null,'restart on model B');await last.closed;assert.equal(last.child.exitCode,0,last.stderr);
 const saved=await readSession(),answer=JSON.stringify(saved.messages.filter(row=>row.role==='assistant').at(-1));assert.match(answer,new RegExp(code));assert.match(answer,new RegExp(receipts[2]));
 assert.equal(saved.meta.model,'openrouter/'+modelB);checks.push('second forced restart resumed the selected model and compacted conversation');
 const rows=await trace(),requests=rows.filter(row=>row.type==='request');
 for(const model of [modelA,modelB])assert.ok(requests.some(row=>row.model===model&&row.messages.some(message=>message.role==='tool')),'Both real models must receive file-tool results');
 for(let i=0;i<receipts.length;i++)assert.equal(await fs.readFile(path.join(cwd,`proof-${i}.txt`),'utf8'),receipts[i]);
 for(const file of [sessionFile,path.join(cwd,'.notch.json'),traceFile])assert.equal((await fs.readFile(file,'utf8')).includes(key),false);
 passed=true;
}catch(error){failure=redact(error.stack);}finally{
 for(const client of clients)if(client.child.exitCode===null)await kill(client);
 const rows=await trace();await fs.writeFile(reportFile,JSON.stringify({passed,entry,root,models:[modelA,modelB],checks,beforeMessages:messages.length,afterCompaction:compacted?.messages.length,
  requests:rows.filter(row=>row.type==='request').length,reservedCostUpperBoundUsd:rows.filter(row=>row.type==='request').reduce((sum,row)=>sum+row.reserveUsd,0),responses:rows.filter(row=>row.type==='response'),failure},null,2));
}
console.log(JSON.stringify({passed,reportFile,checks,failure}));if(!passed)process.exitCode=1;
