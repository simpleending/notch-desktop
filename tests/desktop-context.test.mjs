import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDesktopTurn } from '../vendor/notch-core/desktop-harness.js';
import { desktopInstructionsForContext } from '../src/context-prompts.mjs';

test('Auto grows for conversation pressure before summarizing, while manual and native limits stay respected', async t => {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'notch-history-grow-')),requests=[],archives=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const body=JSON.parse(init.body);requests.push(body);
    const frame={message:{role:'assistant',content:body.stream?'HISTORY_OK':'Earlier decisions preserved.'},done:true,done_reason:'stop',prompt_eval_count:5000,eval_count:3};
    return body.stream?new Response(JSON.stringify(frame)+'\n'):Response.json(frame);
  });
  const messages=[{role:'user',content:'Preserve the original decision.'}];
  for(let i=0;i<6;i++)messages.push({role:'user',content:'Earlier request '+i},{role:'assistant',content:'Completed project work. '.repeat(120)});
  messages.push({role:'user',content:'Continue the current task.'});
  const turn={cwd,sessionId:'history-grow',model:'ollama/fixture',baseUrl:'http://127.0.0.1:18888',contextWindow:8192,nativeContextWindow:16384,availableContextWindows:[8192,16384,32768],automaticContext:true,maxOutputTokens:2048,tools:[],messages,accessMode:'read-only',signal:AbortSignal.timeout(15000),checkpoints:{commit:async()=>{}},approve:async()=>false,onCompact:history=>archives.push(history)};
  assert.equal((await runDesktopTurn(turn)).text,'HISTORY_OK');assert.equal(requests.length,1);assert.equal(requests[0].options.num_ctx,16384);assert.equal(archives.length,0);
  requests.length=0;
  await runDesktopTurn({...turn,automaticContext:false});assert(requests.every(body=>body.options.num_ctx===8192));assert(archives.length>0);
  requests.length=0;
  await runDesktopTurn({...turn,nativeContextWindow:8192});assert(requests.every(body=>body.options.num_ctx===8192));
  requests.length=0;let refreshed=0;
  await runDesktopTurn({...turn,refreshContextWindows:async()=>{refreshed++;return [8192];}});
  assert(refreshed>0);assert(requests.every(body=>body.options.num_ctx===8192),'Memory pressure must invalidate previously available larger contexts.');
});

test('the full desktop tool request grows only to a validated automatic context and sends that context to Ollama', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-desktop-context-'));
  await fs.writeFile(path.join(cwd, '.notch.md'), 'PROJECT_RULE_SENTINEL: preserve all existing files.');
  const actualFetch = globalThis.fetch, requests = [], usage = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'READY' }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 1 }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  };
  const turn = { cwd, sessionId: 'context-test', messages: [{ role: 'user', content: 'Say READY' }], model: 'ollama/fixture', baseUrl: 'http://127.0.0.1:18888/v1', contextWindow: 8192, nativeContextWindow: 32768, availableContextWindows: [8192, 16384], automaticContext: true,
    maxOutputTokens: 2048, instructions: 'Desktop instruction. '.repeat(800), tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'BrowserRead', 'BrowserInteract', 'Git', 'GitHub', 'Agent'],
    accessMode: 'read-only', signal: new AbortController().signal, checkpoints: { commit: async () => {} }, approve: async () => false, maxIterations: 1, onUsage: value => usage.push(value) };
  try {
    const result = await runDesktopTurn(turn);
    assert.equal(result.text, 'READY');
    assert.equal(requests[0].options.num_ctx, 16384);
    assert(requests[0].tools.some(tool => tool.function.name === 'web_search'));
    assert.equal(usage.at(-1).contextWindow, 16384);
    assert(requests[0].messages[0].content.includes(turn.instructions), 'Long custom instructions must remain intact when the automatic context grows.');
    const count = requests.length;
    await assert.rejects(runDesktopTurn({ ...turn, automaticContext: false }), /too little context/);
    await assert.rejects(runDesktopTurn({ ...turn, availableContextWindows: [8192] }), /too little context/);
    assert.equal(requests.length, count, 'Manual limits and insufficient hardware must fail before inference.');
    const builtin = (await fs.readFile(new URL('./fixtures/desktop-general-instructions.txt', import.meta.url), 'utf8')).replaceAll('\r\n', '\n').trim();
    await runDesktopTurn({ ...turn, automaticContext: false, instructions: desktopInstructionsForContext(builtin, 8192) });
    assert.equal(requests.at(-1).options.num_ctx, 8192, 'The compact built-in prompt and full tools must actually fit an explicit 8K context.');
    assert(requests.at(-1).tools.every(tool => typeof tool.function.parameters === 'object'));
    assert(requests.at(-1).messages[0].content.includes('PROJECT_RULE_SENTINEL'), 'Compact guidance must retain project rules.');
    const compactTools = requests.at(-1).tools;
    await runDesktopTurn({ ...turn, contextWindow: 16384, automaticContext: false, instructions: desktopInstructionsForContext(builtin, 16384) });
    const fullTools = requests.at(-1).tools;
    assert.deepEqual(compactTools.map(t => t.function.parameters), fullTools.map(t => t.function.parameters), 'Prompt tiers must keep identical argument schemas.');
    assert(JSON.stringify(compactTools).length < JSON.stringify(fullTools).length);
  } finally { globalThis.fetch = actualFetch; }
});

test('8K compaction preserves a parallel web fetch chain and continues the turn', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-context-'));
  const task = { role: 'user', content: 'Summarize the three pages and cite them.' };
  const pages = ['first', 'second', 'third'];
  const calls = pages.map(page => ({
    type: 'tool-call', toolName: 'web_fetch', toolCallId: page, input: { url: `https://example.com/${page}` },
  }));
  const messages = [task, { role: 'assistant', content: calls }, {
    role: 'tool', content: pages.map(page => ({
      type: 'tool-result', toolName: 'web_fetch', toolCallId: page,
      output: { type: 'text', value: `https://example.com/${page}\n${'Useful page text. '.repeat(1300)}` },
    })),
  }];
  const actualFetch = globalThis.fetch;
  const requests = [];
  const archives = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const message = requests.length === 1
      ? { role: 'assistant', content: '', thinking: 'I can answer this.' }
      : { role: 'assistant', content: 'Summary with citations.' };
    return new Response(JSON.stringify({ message, done: true, done_reason: 'stop' }) + '\n');
  };
  try {
    const result = await runDesktopTurn({
      cwd, sessionId: 'web-context-test', messages, model: 'ollama/fixture', baseUrl: 'http://127.0.0.1:18888/v1',
      contextWindow: 8192, tools: ['WebFetch'], accessMode: 'read-only', signal: new AbortController().signal,
      checkpoints: { commit: async () => {} }, maxIterations: 2, onCompact: history => archives.push(structuredClone(history)),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Summary with citations.');
    assert.equal(result.compressed, true);
    assert.deepEqual(archives, [messages]);
    assert.equal(requests.length, 2);
    const request = requests.at(-1);
    assert.match(request.messages[0].content, /previous response was empty/);
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.messages.find(message => message.role === 'user').content, task.content);
    assert.equal(request.messages.find(message => message.role === 'assistant').tool_calls.length, pages.length);
    const results = request.messages.filter(message => message.role === 'tool');
    assert.equal(results.length, pages.length);
    for (const [index, page] of pages.entries()) {
      assert.equal(results[index].tool_name, 'web_fetch');
      assert.match(results[index].content, new RegExp(`https://example.com/${page}`));
      assert.ok(results[index].content.length < 1000);
    }
  } finally {
    globalThis.fetch = actualFetch;
  }
});
