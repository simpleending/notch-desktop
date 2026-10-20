import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDesktopTurn, CheckpointManager } from '../vendor/notch-core/desktop-harness.js';

test('a native IDE GitHub tool call reaches the authenticated API and returns its result', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-github-harness-'));
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'fake-harness-token';
  let rounds = 0, apiCalls = 0, toolResult;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.github.com/')) {
      apiCalls += 1;
      assert.equal(options.headers.Authorization, 'Bearer fake-harness-token');
      return Response.json({ full_name: 'company/project', default_branch: 'develop', private: true });
    }
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.tools.map(tool => tool.function.name).filter(name => name !== 'notch_tool_error'), ['github']);
    const delta = rounds++ === 0 ? { tool_calls: [{ index: 0, id: 'github-fixture', type: 'function', function: { name: 'github', arguments: JSON.stringify({ action: 'repo_info', owner: 'company', repo: 'project' }) } }] } : { content: 'Repository verified.' };
    const frame = (delta, finish_reason = null) => ({ id: 'fixture', model: request.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({}, rounds === 1 ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const result = await runDesktopTurn({ cwd, sessionId: 'github-fixture', messages: [{ role: 'user', content: 'Inspect company/project on GitHub.' }], model: 'openrouter/fixture/coder', apiKey: 'fake-provider-key', contextWindow: 16384, maxOutputTokens: 1000, accessMode: 'full-access', signal: AbortSignal.timeout(15000), checkpoints: new CheckpointManager(), tools: ['GitHub'], approve: async () => true, maxIterations: 3, onToolResult: (_name, result, isError) => { assert.equal(isError, false); toolResult = result; } });
    assert.equal(apiCalls, 1);
    assert.match(toolResult, /company\/project/);
    assert.match(toolResult, /Default branch: develop/);
    assert.equal(result.status, 'completed');
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep + 'notch-github-harness-'));
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
