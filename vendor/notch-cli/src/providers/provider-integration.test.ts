import { isStepCount } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import { resolveByokModel, validateByokConfig } from './byok.js';
import { ollamaFetch, ollamaBatchSize } from './ollama-transport.js';
import { ollamaChatUrl, ollamaRoot } from './ollama-url.js';
import { resolveModel } from './registry.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const encoder = new TextEncoder();
const sse = (frames: unknown[]) => new Response(new ReadableStream({ start(controller) {
  const bytes = encoder.encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
  // Deliberately split JSON and UTF-8 bytes across transport chunks.
  for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
  controller.close();
} }), { headers: { 'Content-Type': 'text/event-stream' } });

describe('provider transport contracts', () => {
  it('retains chat completions for existing Notch endpoints after the SDK upgrade',async()=>{
    vi.stubGlobal('fetch',vi.fn(async url=>{
      expect(String(url)).toBe('http://fixture/v1/chat/completions');
      return Response.json({choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
    }));
    expect((await generateText({model:resolveModel({model:'notch-pyre',apiKey:'fixture',baseUrl:'http://fixture/v1'}),prompt:'Hello'})).text).toBe('ok');
  });
  it.each(['openai', 'anthropic'])('uses the native %s API and replays tool results', async provider => {
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      const first = round++ === 0;
      if (provider === 'openai') {
        expect(String(url)).toBe('https://api.openai.com/v1/responses');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
        if (!first) expect(body.input).toContainEqual(expect.objectContaining({type:'function_call_output',call_id:'call_add',output:'5'}));
        return Response.json({id:`resp_${round}`,object:'response',created_at:1,model:'fixture',status:'completed',output:first
          ? [{type:'function_call',id:'fc_add',call_id:'call_add',name:'add',arguments:'{"a":2,"b":3}'}]
          : [{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'5',annotations:[]}]}],
          usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
      }
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('test-key');
      if (!first) expect(body.messages.at(-1).content).toContainEqual(expect.objectContaining({type:'tool_result',tool_use_id:'call_add',content:'5'}));
      return Response.json({id:'msg',type:'message',role:'assistant',model:'fixture',content:first
        ? [{type:'tool_use',id:'call_add',name:'add',input:{a:2,b:3}}] : [{type:'text',text:'5'}],
        stop_reason:first?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}});
    }));
    const {model} = resolveByokModel({provider,model:'fixture',apiKey:'test-key'});
    const result = await generateText({model,prompt:'Add 2 and 3',stopWhen:isStepCount(2),tools:{add:tool({inputSchema:z.object({a:z.number(),b:z.number()}),execute:async({a,b})=>a+b})}});
    expect(result.text).toBe('5'); expect(round).toBe(2);
  });
  it('routes Ollama Anthropic compatibility to /v1/messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      expect(String(url)).toBe('http://localhost:11434/v1/messages');
      return Response.json({id:'msg',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}});
    }));
    expect((await generateText({model:resolveByokModel({provider:'ollama-anthropic',model:'fixture'}).model,prompt:'hello'})).text).toBe('ok');
  });
  it.each(['openai','anthropic'])('rejects a bad %s key before inference', async provider => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:401})));
    expect(await validateByokConfig({provider,apiKey:'invalid'})).toMatchObject({ok:false,error:expect.stringContaining('401')});
  });
  it('passes Anthropic workspace selection and refuses subscription tokens', async () => {
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID','wrkspc_fixture');
    const fetch = vi.fn(async (_url,init) => {expect(new Headers(init?.headers).get('anthropic-workspace-id')).toBe('wrkspc_fixture');return Response.json({id:'fixture'});});
    vi.stubGlobal('fetch',fetch);
    expect(await validateByokConfig({provider:'anthropic',apiKey:'test-key',model:'fixture'})).toEqual({ok:true});
    expect(await validateByokConfig({provider:'anthropic',apiKey:'sk-ant-oat-fixture'})).toMatchObject({ok:false,error:expect.stringContaining('Console API key')});
    expect(()=>resolveByokModel({provider:'anthropic',apiKey:'sk-ant-oat-fixture'})).toThrow('Console API key');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('validates and forwards an explicit memory-sensitive batch size', async () => {
    vi.stubEnv('NOTCH_OLLAMA_BATCH', '64');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).options.num_batch).toBe(64);
      return Response.json({done:true,message:{content:'ok'}});
    }));
    await ollamaFetch('http://localhost:11434')('http://localhost:11434/v1/chat/completions', {body:JSON.stringify({model:'fixture',messages:[],stream:false})});
    for(const value of ['0','-1','1.5','2049','invalid']) {
      vi.stubEnv('NOTCH_OLLAMA_BATCH', value);expect(()=>ollamaBatchSize()).toThrow('NOTCH_OLLAMA_BATCH');
    }
  });
  it.each(['localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/v1/', 'http://localhost:11434/api'])('normalizes %s', host => {
    expect(ollamaRoot(host)).toBe('http://localhost:11434');
    expect(ollamaChatUrl(host)).toBe('http://localhost:11434/v1');
  });
  it('honors OLLAMA_HOST for explicit --provider ollama and streams Unicode', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:12345');
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:12345/api/chat');
      expect(JSON.parse(init.body).model).toBe('qwen3:4b');
      expect(JSON.parse(init.body).options.num_ctx).toBe(32768);
      return new Response('{"message":{"content":"Ready ✓"},"done":false}\n{"message":{"content":""},"done":true}', { headers: { 'Content-Type': 'application/x-ndjson' } });
    }));
    const { model } = resolveByokModel({ provider: 'ollama', model: 'qwen3:4b', apiKey: 'ollama' });
    const result = streamText({ model, prompt: 'Hello' });
    let text = ''; for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('Ready ✓');
  });
  it('executes OpenRouter tool calls and replays the result with the correct id', async () => {
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
      expect(new Headers(init.headers).get('X-OpenRouter-Title')).toBe('Notch CLI');
      const body = JSON.parse(init.body);
      if (round++ === 0) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_add', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      expect(body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call_add', content: '5' }));
      return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '5' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }));
    const { model } = resolveByokModel({ provider: 'openrouter', model: 'test/coder', apiKey: 'test-key' });
    const result = await generateText({ model, prompt: 'Add 2 and 3', stopWhen: isStepCount(2), tools: { add: tool({ inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => a + b }) } });
    expect(result.text).toBe('5');
    expect(round).toBe(2);
  });
  it('does not report a rejected OpenRouter key as healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    expect(await validateByokConfig({ provider: 'openrouter', apiKey: 'invalid' })).toMatchObject({ ok: false, error: expect.stringContaining('401') });
  });
  it('rejects Ollama models lacking tools in diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ capabilities: ['completion'] })));
    expect(await validateByokConfig({ provider: 'ollama', model: 'chat-only' })).toMatchObject({ ok: false, error: expect.stringContaining('tool calling') });
  });
});


describe('native Ollama stream reliability', () => {
  it('decodes fragmented Unicode and tool calls, preserving tool results on the next turn', async () => {
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (round++ === 0) {
        const bytes = encoder.encode(JSON.stringify({ message: { content: '✓', tool_calls: [{ function: { name: 'add', arguments: { a: 2, b: 3 } } }] }, done: true }));
        return new Response(new ReadableStream({ start(controller) {
          for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
          controller.close();
        } }));
      }
      expect(body.messages).toContainEqual({ role: 'tool', tool_name: 'add', content: '5' });
      expect(body.messages.find((m: any) => m.tool_calls)?.tool_calls[0].function.arguments).toEqual({ a: 2, b: 3 });
      return new Response(JSON.stringify({ message: { content: '5' }, done: true }));
    }));
    const { model } = resolveByokModel({ provider: 'ollama', model: 'qwen3:4b' });
    const result = streamText({ model, prompt: 'Add', stopWhen: isStepCount(2), tools: { add: tool({ inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => a + b }) } });
    let streamed = '';
    for await (const event of result.stream) if (event.type === 'text-delta') streamed += event.text;
    expect(streamed).toBe('✓5');
    expect(await result.text).toBe('5'); // SDK 7 returns the final step's text.
    expect(round).toBe(2);
  });
  it.each(['{"message":{"content":"partial"}}', '{"error":"out of memory"}'])('rejects incomplete/error streams: %s', async frame => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frame)));
    const response = await ollamaFetch('http://localhost:11434')('', { method: 'POST', body: JSON.stringify({ model: 'test', messages: [], stream: true }) });
    await expect(response.text()).rejects.toThrow(/Ollama/);
  });
  it('propagates cancellation to the upstream reader and request signal', async () => {
    const cancelled = vi.fn();
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(init.signal).toBe(abort.signal);
      return new Response(new ReadableStream({ cancel: cancelled }));
    }));
    const response = await ollamaFetch('http://localhost:11434')('', { signal: abort.signal, body: JSON.stringify({ messages: [], stream: true }) });
    await response.body!.cancel('cancelled');
    expect(cancelled).toHaveBeenCalled();
  });
  it('handles OpenRouter SSE text fragmented across transport chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready ✓' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])));
    const { model } = resolveByokModel({ provider: 'openrouter', model: 'test/coder', apiKey: 'test-key' });
    const result = streamText({ model, prompt: 'Hello' });
    let text = ''; for await (const part of result.textStream) text += part;
    expect(text).toBe('Ready ✓');
  });
});
