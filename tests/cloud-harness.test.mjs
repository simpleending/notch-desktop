import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDesktopTurn, CheckpointManager, inspectHubModel } from '../vendor/notch-core/desktop-harness.js';
test('OpenRouter uses the explicit key, correct endpoint, bounded output and provider usage',async()=>{
  const previous=globalThis.fetch, calls=[];
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(options.headers).get('authorization'),'Bearer sk-or-qa-only-fixture');
    const body=JSON.parse(options.body);calls.push(body);
    assert.equal(body.model,'openai/gpt-4.1');assert.ok((body.max_tokens || body.max_completion_tokens)<=4096);
    assert.ok(Array.isArray(body.tools));
    const chunk={id:'qa',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'CLOUD_ROUTE_VERIFIED'},finish_reason:null}]};
    const end={...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:101,completion_tokens:7,total_tokens:108}};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try {
    const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-cloud-route-'));let usage;
    await writeFile(path.join(cwd,'.notch.json'),JSON.stringify({provider:{provider:'openrouter',model:'openai/gpt-4.1',baseUrl:'https://untrusted.invalid/v1',headers:{Authorization:'Bearer unsafe-project-header'}}}));
    const result=await runDesktopTurn({cwd,sessionId:'cloud-route-test',messages:[{role:'user',content:'hello'}],model:'openrouter/openai/gpt-4.1',apiKey:'sk-or-qa-only-fixture',contextWindow:32768,maxOutputTokens:4096,
      accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false,onUsage:value=>{usage=value;}});
    assert.equal(result.text,'CLOUD_ROUTE_VERIFIED');assert.equal(calls.length,1);assert.deepEqual(usage,{inputTokens:101,outputTokens:7,contextWindow:32768});
    assert.doesNotMatch(JSON.stringify(result.messages),/sk-or-/);
  } finally {globalThis.fetch=previous;}
});
test('OpenRouter preserves encrypted reasoning across the desktop tool loop and a saved transcript',async()=>{
  const previous=globalThis.fetch,cwd=await mkdtemp(path.join(os.tmpdir(),'notch-cloud-reasoning-'));
  const details=[{type:'reasoning.encrypted',data:'opaque-fixture',id:'reasoning-fixture',format:'anthropic-claude-v1',index:0}];
  const frame=(delta,finish_reason=null)=>({id:'qa',object:'chat.completion.chunk',created:1,model:'~lab/model-latest',choices:[{index:0,delta,finish_reason}]});
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    const body=JSON.parse(options.body);calls++;
    const frames=calls===1?[frame({reasoning_details:details}),frame({tool_calls:[{index:0,id:'read-fixture',type:'function',function:{name:'read',arguments:JSON.stringify({path:'receipt.txt'})}}]}),frame({},'tool_calls')]:[frame({content:'REASONING_VERIFIED'}),frame({},'stop')];
    if(calls>1){assert.deepEqual(body.messages.find(message=>message.role==='assistant').reasoning_details,details);assert.match(body.messages.find(message=>message.role==='tool').content,/receipt/);}
    return new Response(': OPENROUTER PROCESSING\n\n'+frames.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    await writeFile(path.join(cwd,'receipt.txt'),'receipt');
    const turn={cwd,model:'openrouter/~lab/model-latest',apiKey:'fixture-only',contextWindow:8192,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false};
    const result=await runDesktopTurn({...turn,sessionId:'reasoning-first',messages:[{role:'user',content:'Read receipt.txt'}]});
    assert.equal(result.text,'REASONING_VERIFIED');assert.equal(calls,2);
    const restored=JSON.parse(JSON.stringify(result.messages));
    await runDesktopTurn({...turn,sessionId:'reasoning-resume',messages:[...restored,{role:'user',content:'Continue'}]});assert.equal(calls,3);
  }finally{globalThis.fetch=previous;}
});

for(const partial of [false,true])test(`OpenRouter HTTP 200 stream errors fail the desktop turn${partial?' after partial text':''}`,async()=>{
  const previous=globalThis.fetch,cwd=await mkdtemp(path.join(os.tmpdir(),'notch-cloud-error-'));
  const frame=(delta,finish_reason=null)=>({id:'qa',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
  globalThis.fetch=async()=>new Response((partial?`data: ${JSON.stringify(frame({content:'Partial'}))}\n\n`:'')+`data: ${JSON.stringify({...frame({content:''},'error'),error:{code:'server_error',message:'Provider disconnected unexpectedly'}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  try{await assert.rejects(runDesktopTurn({cwd,sessionId:'cloud-error',messages:[{role:'user',content:'Hello'}],model:'openrouter/fixture',apiKey:'fixture-only',contextWindow:8192,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false}),/Provider disconnected unexpectedly/);}
  finally{globalThis.fetch=previous;}
});

test('MLX inspection uses the repository revision and nested text context configuration',async()=>{
  const previous=globalThis.fetch, calls=[],revision='b'.repeat(40);
  globalThis.fetch=async (url,options)=>{
    calls.push(String(url));assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer hf_fixture_only');
    return Response.json(calls.length===1?{sha:revision,siblings:[{rfilename:'weights.safetensors',size:12345}]}:{max_position_embeddings:77,text_config:{max_position_embeddings:32768}});
  };
  try {
    const row=await inspectHubModel('fixture/mlx-native','mlx',AbortSignal.timeout(5000),'hf_fixture_only',true);
    assert.equal(row.contextLength,32768);assert.equal(calls[1],`https://huggingface.co/fixture/mlx-native/resolve/${revision}/config.json`);
    globalThis.fetch=async()=>new Response('',{status:503});
    await assert.rejects(inspectHubModel('fixture/mlx-native','mlx',AbortSignal.timeout(5000),undefined,true),/HTTP 503/);
  } finally {globalThis.fetch=previous;}
});
test('Ollama request and agent budget use the native limit even with a larger environment override',async()=>{
  const previous=globalThis.fetch, previousContext=process.env.NOTCH_OLLAMA_CONTEXT;process.env.NOTCH_OLLAMA_CONTEXT='32768';
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'http://127.0.0.1:11437/api/chat');
    const body=JSON.parse(options.body);assert.equal(body.options.num_ctx,4096);
    return new Response(JSON.stringify({message:{content:'NATIVE_CONTEXT_VERIFIED'},done:true,prompt_eval_count:100,eval_count:7}),{headers:{'Content-Type':'application/x-ndjson'}});
  };
  try {
    const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-native-context-'));let usage;
    const result=await runDesktopTurn({cwd,sessionId:'native-context-test',messages:[{role:'user',content:'hello'}],model:'ollama/fixture',baseUrl:'http://127.0.0.1:11437',contextWindow:8192,nativeContextWindow:4096,
      accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false,onUsage:value=>{usage=value;}});
    assert.equal(result.text,'NATIVE_CONTEXT_VERIFIED');assert.equal(usage.contextWindow,4096);
  } finally {globalThis.fetch=previous;if(previousContext===undefined)delete process.env.NOTCH_OLLAMA_CONTEXT;else process.env.NOTCH_OLLAMA_CONTEXT=previousContext;}
});
