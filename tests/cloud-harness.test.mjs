import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDesktopTurn, CheckpointManager, inspectHubModel } from '../vendor/notch-core/desktop-harness.js';
test('tool-free background turns do not advertise a validation tool or permit tool execution',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-no-tools-'));
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);assert.ok(!body.tools||body.tools.length===0,'An empty allowed toolset must stay empty');
    const chunk={id:'recap',model:body.model,choices:[{index:0,delta:{content:'{"recap":"You confirmed READY."}'},finish_reason:null}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  });
  const result=await runDesktopTurn({cwd,sessionId:'no-tools',messages:[{role:'user',content:'Return a JSON recap'}],model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',contextWindow:8192,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:[],approve:async()=>{throw Error('No tool can request permission')}});
  assert.equal(JSON.parse(result.text).recap,'You confirmed READY.');
});
test('OpenRouter uses the explicit key, correct endpoint, bounded output and provider usage',async()=>{
  const previous=globalThis.fetch, calls=[];
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(options.headers).get('authorization'),'Bearer sk-or-qa-only-fixture');
    const body=JSON.parse(options.body);calls.push(body);
    assert.equal(body.model,'openai/gpt-4.1');assert.equal(body.models,undefined);assert.ok((body.max_tokens || body.max_completion_tokens)<=4096);
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
test('OpenRouter sends ordered fallback models and drops the primary from that list',async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    const body=JSON.parse(options.body);calls.push(body);
    const chunk={id:'qa',object:'chat.completion.chunk',created:1,model:'google/gemini-3.5-flash',choices:[{index:0,delta:{role:'assistant',content:'FALLBACK_ROUTE_VERIFIED'},finish_reason:null}]};
    const end={...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:3,total_tokens:11}};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-cloud-fallback-'));
    const result=await runDesktopTurn({cwd,sessionId:'cloud-fallback-test',messages:[{role:'user',content:'hello'}],model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',contextWindow:8192,maxOutputTokens:4096,
      fallbacks:['openrouter/openai/gpt-4.1','google/gemini-3.5-flash','openrouter/deepseek/deepseek-v4-flash'],
      accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false});
    assert.equal(result.text,'FALLBACK_ROUTE_VERIFIED');
    assert.equal(calls[0].model,'openai/gpt-4.1');
    assert.deepEqual(calls[0].models,['google/gemini-3.5-flash','deepseek/deepseek-v4-flash']);
  }finally{globalThis.fetch=previous;}
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

for (const contextWindow of [8192, 131072]) test(`OpenRouter ${contextWindow}-token compaction summarizes successfully and retains tool permissions on resume`, async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-cloud-compact-'));
  const decision = 'MIDDLE_DECISION_USE_SQLITE';
  const messages = [{role:'user', content:'Original task: maintain the project.'}, {role:'assistant', content:'Ready.'}];
  for (let i = 0; i < 24; i++) messages.push(
    {role:'user', content:(i === 0 ? decision : `Completed task ${i}`) + (contextWindow > 8192 ? ' Earlier project requirement.'.repeat(500) : '')},
    {role:'assistant', content:'Completed review. '.repeat(contextWindow === 8192 ? 150 : 1500)},
  );
  messages.push({role:'user', content:'Continue the current task.'},
    {role:'assistant', content:[{type:'tool-call', toolName:'read', toolCallId:'current-read', input:{path:'receipt.txt'}}]},
    {role:'tool', content:[{type:'tool-result', toolName:'read', toolCallId:'current-read', output:{type:'text', value:'CURRENT_RECEIPT'}}]});
  let summaries = 0, streams = 0, archived;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-only');
    if (!body.stream) {
      summaries++;
      assert.match(JSON.stringify(body.messages), new RegExp(decision));
      assert.ok((body.max_tokens ?? body.max_completion_tokens) <= (contextWindow === 8192 ? 512 : 1024));
      return Response.json({id:'summary', object:'chat.completion', created:1, model:body.model,
        choices:[{index:0, message:{role:'assistant', content:`Project decision: ${decision}. Prior reviews completed.`}, finish_reason:'stop'}],
        usage:{prompt_tokens:1000, completion_tokens:20, total_tokens:1020}});
    }
    streams++;
    const history = JSON.stringify(body.messages);
    assert.match(history, new RegExp(decision));
    assert.match(history, /Original task/);
    assert.match(history, /Continue the current task/);
    assert.equal(body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'current-read')?.content, 'CURRENT_RECEIPT');
    assert.ok((body.max_tokens ?? body.max_completion_tokens) <= (contextWindow === 8192 ? 512 : 4096));
    const delta = streams === 1
      ? {tool_calls:[{index:0, id:'denied-write', type:'function', function:{name:'write', arguments:JSON.stringify({path:'forbidden.txt', content:'must not write'})}}]}
      : {content:`${decision} COMPACTION_CONTRACT_VERIFIED`};
    if (streams > 1) assert.match(body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'denied-write')?.content ?? '', /denied|read.only|not allowed|permission/i);
    const frame = (value, reason = null) => ({id:'compact', object:'chat.completion.chunk', created:1, model:body.model, choices:[{index:0, delta:value, finish_reason:reason}]});
    return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({}, streams === 1 ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`, {headers:{'content-type':'text/event-stream'}});
  });
  const turn = {cwd, model:'openrouter/openai/gpt-4.1', apiKey:'fixture-only', contextWindow, maxOutputTokens:contextWindow === 8192 ? 512 : 4096, accessMode:'read-only',
    signal:AbortSignal.timeout(15000), checkpoints:new CheckpointManager(), tools:['Read', 'Write'], approve:async()=>{throw Error('Read-only must reject writes');},
    onCompact:async original=>{archived = JSON.parse(JSON.stringify(original));}};
  const result = await runDesktopTurn({...turn, sessionId:'compact-first', messages});
  assert.equal(summaries, 1, 'The semantic summarizer must succeed rather than use fallback');
  assert.deepEqual(archived, messages);
  assert.equal(result.text, `${decision} COMPACTION_CONTRACT_VERIFIED`);
  await assert.rejects(access(path.join(cwd, 'forbidden.txt')));
  const resumed = await runDesktopTurn({...turn, sessionId:'compact-resume', messages:[...JSON.parse(JSON.stringify(result.messages)), {role:'user', content:'Continue after restart.'}]});
  assert.equal(resumed.text, result.text);
  assert.equal(summaries, 1, 'A compacted short history must not immediately compact again');
});

for(const partial of [false,true])test(`OpenRouter HTTP 200 stream errors fail the desktop turn${partial?' after partial text':''}`,async()=>{
  const previous=globalThis.fetch,cwd=await mkdtemp(path.join(os.tmpdir(),'notch-cloud-error-'));
  const frame=(delta,finish_reason=null)=>({id:'qa',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
  globalThis.fetch=async()=>new Response((partial?`data: ${JSON.stringify(frame({content:'Partial'}))}\n\n`:'')+`data: ${JSON.stringify({...frame({content:''},'error'),error:{code:'server_error',message:'Provider disconnected unexpectedly'}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  try{await assert.rejects(runDesktopTurn({cwd,sessionId:'cloud-error',messages:[{role:'user',content:'Hello'}],model:'openrouter/fixture',apiKey:'fixture-only',contextWindow:8192,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false}),/Provider disconnected unexpectedly/);}
  finally{globalThis.fetch=previous;}
});

test('a disconnected summary never replaces history with partial text, and restart retains the active tool chain',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-summary-restart-')),messages=[{role:'user',content:'ORIGINAL_DECISION_KEEP_SQLITE'}];
  for(let i=0;i<20;i++)messages.push({role:'user',content:'Completed review '+i},{role:'assistant',content:'Reviewed files and tests. '.repeat(160)});
  messages.push({role:'user',content:'Continue CURRENT_TASK'}, {role:'assistant',content:[{type:'tool-call',toolName:'read',toolCallId:'preserved-read',input:{path:'receipt.txt'}}]}, {role:'tool',content:[{type:'tool-result',toolName:'read',toolCallId:'preserved-read',output:{type:'text',value:'PRESERVED_TOOL_RECEIPT'}}]});
  let summaries=0,archived;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(!body.stream){summaries++;return new Response('{"choices":[{"message":{"content":"PARTIAL_SUMMARY_MUST_NEVER_BE_SAVED', {headers:{'content-type':'application/json'}});}
    const history=JSON.stringify(body.messages);assert.match(history,/ORIGINAL_DECISION_KEEP_SQLITE/);assert.match(history,/CURRENT_TASK/);assert.doesNotMatch(history,/PARTIAL_SUMMARY_MUST_NEVER_BE_SAVED/);
    assert.equal(body.messages.find(row=>row.role==='tool'&&row.tool_call_id==='preserved-read')?.content,'PRESERVED_TOOL_RECEIPT');
    const frame=(delta,finish_reason=null)=>({id:'restart',choices:[{index:0,delta,finish_reason}]});return new Response(`data: ${JSON.stringify(frame({content:'RESUME_OK'}))}\n\ndata: ${JSON.stringify(frame({},'stop'))}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  });
  const turn={cwd,model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',contextWindow:8192,maxOutputTokens:512,accessMode:'read-only',signal:AbortSignal.timeout(30000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false,onCompact:async original=>{archived=structuredClone(original);}};
  const result=await runDesktopTurn({...turn,sessionId:'summary-disconnect',messages});assert.equal(result.text,'RESUME_OK');assert.deepEqual(archived,messages);assert(summaries>0);assert.doesNotMatch(JSON.stringify(result.messages),/PARTIAL_SUMMARY/);
  const restored=JSON.parse(JSON.stringify(result.messages));assert.equal((await runDesktopTurn({...turn,sessionId:'summary-restart',messages:[...restored,{role:'user',content:'Continue after restarting Notch'}]})).text,'RESUME_OK');
});

test('automation token budgets prevent inference when the prompt already exceeds the allowance',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-token-cap-'));const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));throw Error('No request should be sent');});
  await assert.rejects(runDesktopTurn({cwd,sessionId:'token-cap',model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',messages:[{role:'user',content:'Hello'}],contextWindow:8192,maxTotalTokens:1,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:[],approve:async()=>false}),error=>error.code==='token-limit');assert.deepEqual(calls.filter(url=>url.endsWith('/chat/completions')),[]);
});

test('compaction usage counts toward an automation budget before the next generation',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'notch-compaction-cap-')),messages=[{role:'user',content:'Keep ORIGINAL_DECISION'}];for(let i=0;i<24;i++)messages.push({role:'user',content:'Task '+i},{role:'assistant',content:'Reviewed files and tests. '.repeat(160)});messages.push({role:'user',content:'Continue'});
  let summaries=0,streams=0,usage;
  t.mock.method(globalThis,'fetch',async(url,options)=>{if(!String(url).endsWith('/chat/completions'))throw Error('Metadata unavailable');const body=JSON.parse(options.body);if(body.stream){streams++;throw Error('Budget exhausted');}summaries++;return Response.json({id:'summary',choices:[{index:0,message:{role:'assistant',content:'ORIGINAL_DECISION'},finish_reason:'stop'}],usage:{prompt_tokens:9000,completion_tokens:1000,total_tokens:10000}});});
  await assert.rejects(runDesktopTurn({cwd,sessionId:'summary-budget',model:'openrouter/openai/gpt-4.1',apiKey:'fixture-only',messages,contextWindow:8192,maxOutputTokens:512,maxTotalTokens:10000,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:new CheckpointManager(),tools:[],approve:async()=>false,onUsage:value=>{usage=value;}}),error=>error.code==='token-limit');assert.equal(summaries,1);assert.equal(streams,0);assert.equal(usage.inputTokens+usage.outputTokens,10000);
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
