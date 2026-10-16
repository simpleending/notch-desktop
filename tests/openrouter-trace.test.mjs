import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installOpenRouterTrace} from '../scripts/openrouter-network-trace.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notch-trace-unit-')),trace=path.join(root,'trace.jsonl'),catalog=path.join(root,'catalog.json'),original=globalThis.fetch;
 fs.writeFileSync(catalog,JSON.stringify([{id:'fixture/model',pricing:{prompt:'0.000001',completion:'0.000002'}}]));
 t.after(()=>{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});});return {trace,catalog};
}
test('live QA observer forwards real request values unchanged, redacts credentials, and records JSON/stream usage',async t=>{
 const f=fixture(t),key='sk-or-v1-unit-only';let calls=0;
 globalThis.fetch=async(url,init)=>{
  calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init.headers.authorization,'Bearer '+key);
  const body=JSON.parse(init.body);assert.equal(body.messages[0].content,key);
  const value={id:'unit-response',model:body.model,usage:{prompt_tokens:50,completion_tokens:10},choices:[{finish_reason:'stop'}]};
  return body.stream?new Response(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`):Response.json(value);
 };
 const observer=installOpenRouterTrace(f.trace,f.catalog);
 for(const stream of [false,true]){const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{headers:{authorization:'Bearer '+key},body:JSON.stringify({model:'fixture/model',max_tokens:64,messages:[{role:'user',content:key}],stream})});await response.text();}
 await observer.flush();assert.equal(calls,2);const text=fs.readFileSync(f.trace,'utf8');assert.equal(text.includes(key),false);
 const rows=text.trim().split('\n').map(JSON.parse);assert.equal(rows.filter(row=>row.type==='request').length,2);assert.equal(rows.filter(row=>row.type==='response'&&row.usage.prompt_tokens===50).length,2);
});
test('live QA observer refuses unknown models, unbounded output, and excess spending before fetching',async t=>{
 const f=fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Must not fetch');};installOpenRouterTrace(f.trace,f.catalog,0.000001);
 for(const [body,message] of [[{model:'other/model',max_tokens:64},/selected/],[{model:'fixture/model'},/bounded output/],[{model:'fixture/model',max_tokens:64,messages:[]},/cap reached/]]){
  await assert.rejects(fetch('https://openrouter.ai/api/v1/chat/completions',{body:JSON.stringify(body)}),message);
 }
 assert.equal(calls,0);
});
test('live QA spending reservation includes tool schemas',async t=>{
 const f=fixture(t);globalThis.fetch=async()=>{throw Error('Must not fetch');};installOpenRouterTrace(f.trace,f.catalog,0.001);
 await assert.rejects(fetch('https://openrouter.ai/api/v1/chat/completions',{body:JSON.stringify({model:'fixture/model',max_tokens:1,messages:[],tools:[{description:'x'.repeat(5000)}]})}),/cap reached/);
});
