import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDesktopTurn, CheckpointManager } from '../vendor/notch-core/desktop-harness.js';

test('native local tool turns retain thoughts and recover from an unchanged failed edit', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-tool-recovery-'));
  await writeFile(path.join(cwd, 'example.mjs'), 'const value = "before";\n');
  const steps = [
    ['read', { path: 'example.mjs' }],
    ['edit', { path: 'example.mjs', old_string: 'absent', new_string: 'bad' }],
    ['edit', { path: 'example.mjs', old_string: 'before', new_string: '$& $$ $1' }],
    ['edit', { path: 'example.mjs', old_string: '$& $$ $1', new_string: '$& $$ $1' }],
    ['shell', { command: 'node --check example.mjs', background: false }],
  ];
  let round = 0;
  const results = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11437/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.options.num_predict, 8192);
    if (round) assert.equal(body.messages.find(m => m.role === 'assistant' && m.tool_calls)?.thinking, 'Inspect the file before changing it.');
    const step = steps[round++];
    return Response.json({ message: step ? {
      thinking: 'Inspect the file before changing it.', content: '',
      tool_calls: [{ function: { name: step[0], arguments: step[1] } }],
    } : { content: 'Verified.' }, done: true, prompt_eval_count: 500, eval_count: 30 });
  });
  const result = await runDesktopTurn({ cwd, sessionId: 'local-recovery',
    messages: [{ role: 'user', content: 'Update example.mjs and check its syntax.' }], model: 'ollama/fixture',
    baseUrl: 'http://127.0.0.1:11437', contextWindow: 32768, accessMode: 'full-access',
    signal: AbortSignal.timeout(15000), checkpoints: new CheckpointManager(), tools: ['Read', 'Edit', 'Bash'],
    approve: async () => { throw Error('Full access should not prompt'); },
    onToolResult: (name, content, isError) => results.push({ name, content, isError }),
  });
  assert.equal(result.status, 'completed'); assert.equal(round, 6);
  assert.equal(results[1].isError, true); assert.match(results[1].content, /No files changed/);
  assert.equal(results[2].isError, false); assert.match(results[3].content, /No file contents changed/); assert.equal(results[4].isError, false);
  assert.equal(await readFile(path.join(cwd, 'example.mjs'), 'utf8'), 'const value = "$& $$ $1";\n');
});

test('a native reasoning-only response limit is incomplete and never retries tools', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-response-limit-'));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push({ url: String(_url), messages: body.messages });
    assert.equal(body.options.num_predict, 1024);
    return Response.json({ message: { thinking: 'Not finished yet.', content: '' },
      done: true, done_reason: 'length', prompt_eval_count: 100, eval_count: 1024 });
  });
  const result = await runDesktopTurn({ cwd, sessionId: 'native-response-limit',
    messages: [{ role: 'user', content: 'Inspect the project' }], model: 'ollama/fixture',
    baseUrl: 'http://127.0.0.1:11437', contextWindow: 32768, maxOutputTokens: 1024,
    accessMode: 'read-only', signal: AbortSignal.timeout(15000), tools: ['Read'],
    checkpoints: new CheckpointManager(), approve: async () => false });
  assert.equal(result.status, 'stalled'); assert.match(result.text, /task is incomplete/);
  assert.equal(requests.length, 1, JSON.stringify(requests)); assert.equal(result.toolCallCount, 0);
});
