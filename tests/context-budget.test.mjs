import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextBudget, estimateTextTokens, autoCompress, fullCompact, safeTailStart } from '../vendor/notch-core/desktop-harness.js';
test('small local and large cloud contexts reserve proportional output plus instruction/tool overhead',()=>{
  const small=contextBudget(8192,1800),cloud=contextBudget(131072,1800,4096);
  assert.ok(small.history>3000);assert.equal(small.output,2048);assert.equal(cloud.output,4096);
  assert.ok(small.history+small.output+1800<8192);assert.ok(cloud.history>100000);
  const crowded=contextBudget(8192,6000);assert.ok(crowded.output>=512&&crowded.output<2048);assert.ok(crowded.history>=512);assert.ok(crowded.history+crowded.output+6000<8192);
  assert.throws(()=>contextBudget(8192,8000),/too little/);assert.throws(()=>contextBudget(0),/2,048/);
  assert.ok(estimateTextTokens('中文'.repeat(100))>=200);
});
test('8K does not compact short chats or send an unnecessary summarization request',async()=>{
  const messages=Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:'hello'}));
  assert.equal(await autoCompress(messages,{},8192),messages);
});
test('compaction boundaries preserve the latest user task and entire tool chain',()=>{
  const messages=[{role:'user',content:'old task'},{role:'assistant',content:'old answer'},{role:'user',content:[{type:'text',text:'current task'}]},{role:'assistant',content:[{type:'tool-call',toolName:'read',toolCallId:'a',input:{path:'file'}}]},{role:'tool',content:[{type:'tool-result',toolName:'read',toolCallId:'a',output:{type:'text',value:'result'}}]}];
  assert.equal(safeTailStart(messages,2),2);assert.equal(safeTailStart(messages,4),0);
});
test('full fallback retains the original decision and current multimodal request',async()=>{
  const first={role:'user',content:'The immutable project decision is SILVER-MAUVE-739.'};
  const content=[{type:'text',text:'Continue with the agreed decision.'},{type:'image',image:new Uint8Array([1,2])}];
  const messages=[first,{role:'assistant',content:'Old discussion'},{role:'user',content:'An earlier task'},{role:'assistant',content:'Done'},{role:'user',content}];
  const result=await fullCompact(messages,{},8192);
  assert.equal(result.messages[0],first);
  const last=result.messages.at(-1);assert.equal(last.role,'user');assert.deepEqual(last.content.slice(-2),content);
});
