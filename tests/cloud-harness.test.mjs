import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDesktopTurn, CheckpointManager } from '../vendor/notch-core/desktop-harness.js';
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
