import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDesktopTurn } from '../vendor/notch-core/desktop-harness.js';
import { desktopInstructionsForContext } from '../src/context-prompts.mjs';

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
