import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runDesktopTurn,CheckpointManager} from '../vendor/notch-core/desktop-harness.js';

const frame=(delta,finish_reason=null)=>({id:'retry',choices:[{index:0,delta,finish_reason}]});
const stream=(frames)=>new Response(frames.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const mockProvider=(t,handler)=>t.mock.method(globalThis,'fetch',(url,init)=>String(url).endsWith('/chat/completions')?handler(url,init):Promise.resolve(new Response('',{status:404})));
const success=()=>stream([frame({content:'RECOVERED'}),frame({},'stop')]);
async function options(extra={}){return {cwd:await mkdtemp(path.join(os.tmpdir(),'notch-retry-')),sessionId:'retry-fixture',model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',messages:[{role:'user',content:'Hello'}],contextWindow:16384,accessMode:'read-only',signal:AbortSignal.timeout(20000),checkpoints:new CheckpointManager(),tools:[],approve:async()=>false,...extra};}

for(const status of [408,429,503])test(`desktop recovers from HTTP ${status} before output`,async t=>{
 let calls=0;const notices=[];
 mockProvider(t,async()=>++calls===1?Response.json({error:{message:`Temporary HTTP ${status}`}}, {status}):success());
 const result=await runDesktopTurn(await options({onLog:value=>notices.push(value)}));
 assert.equal(result.text,'RECOVERED');assert.equal(calls,2);assert.match(notices[0],/Retrying/);
});

test('desktop retries are bounded and cannot trigger a whole-turn replay',async t=>{
 let calls=0;mockProvider(t,async()=>{calls++;return Response.json({error:{message:'Temporary HTTP 503'}},{status:503});});
 await assert.rejects(runDesktopTurn(await options()),error=>error.retryable===false);assert.equal(calls,3);
});

for(const [status,message] of [[401,'Invalid credentials'],[400,'Invalid context limit'],[500,'out of memory']])test(`desktop does not retry ${message}`,async t=>{
 let calls=0;mockProvider(t,async()=>{calls++;return Response.json({error:{message}}, {status});});
 await assert.rejects(runDesktopTurn(await options()));assert.equal(calls,1);
});

test('cancellation interrupts retry backoff without another request',async t=>{
 const controller=new AbortController();let calls=0;
 mockProvider(t,async()=>{calls++;return Response.json({error:{message:'HTTP 503'}},{status:503});});
 const start=Date.now();
 await assert.rejects(runDesktopTurn(await options({signal:controller.signal,onLog:()=>controller.abort(new DOMException('Stopped','AbortError'))})),/Stopped/);
 assert.equal(calls,1);assert(Date.now()-start<1000);
});

test('a failed follow-up retries with the existing tool result and executes the tool once',async t=>{
 let calls=0,executions=0;const turn=await options({tools:['Read'],onToolResult:()=>executions++});await writeFile(path.join(turn.cwd,'receipt.txt'),'PRESERVED_RECEIPT');
 mockProvider(t,async(_url,init)=>{
   calls++;const body=JSON.parse(init.body);
   if(calls===1)return stream([frame({tool_calls:[{index:0,id:'once',type:'function',function:{name:'read',arguments:'{"path":"receipt.txt"}'}}]}),frame({},'tool_calls')]);
   assert.match(body.messages.find(row=>row.role==='tool').content,/PRESERVED_RECEIPT/);
   return calls===2?Response.json({error:{message:'HTTP 503'}},{status:503}):success();
 });
 assert.equal((await runDesktopTurn(turn)).text,'RECOVERED');assert.equal(calls,3);assert.equal(executions,1);
});

test('visible partial text is never duplicated by an automatic retry',async t=>{
 let calls=0,text='';mockProvider(t,async()=>{calls++;return stream([frame({content:'Partial answer'}),{error:{message:'network socket failure',code:503}}]);});
 await assert.rejects(runDesktopTurn(await options({onText:chunk=>text+=chunk})));
 assert.equal(calls,1);assert.equal(text,'Partial answer');
});

test('an interrupted stream before output can recover',async t=>{
 let calls=0;mockProvider(t,async()=>++calls===1?stream([{error:{message:'network socket failure',code:503}}]):success());
 assert.equal((await runDesktopTurn(await options())).text,'RECOVERED');assert.equal(calls,2);
});

test('an incomplete tool input can recover before any action is dispatched',async t=>{
 let calls=0,executions=0;const turn=await options({tools:['Read'],onToolResult:()=>executions++});await writeFile(path.join(turn.cwd,'receipt.txt'),'ONCE');
 mockProvider(t,async()=>{
   calls++;
   if(calls===1)return stream([frame({tool_calls:[{index:0,id:'partial-tool',type:'function',function:{name:'read',arguments:'{"path":'}}]}),{error:{message:'network socket failure',code:503}}]);
   if(calls===2)return stream([frame({tool_calls:[{index:0,id:'complete-tool',type:'function',function:{name:'read',arguments:'{"path":"receipt.txt"}'}}]}),frame({},'tool_calls')]);
   return success();
 });
 assert.equal((await runDesktopTurn(turn)).text,'RECOVERED');assert.equal(calls,3);assert.equal(executions,1);
});
