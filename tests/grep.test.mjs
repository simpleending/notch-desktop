import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { grepTool } from '../vendor/notch-cli/src/tools/grep.ts';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch grep 中文-'));
  assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await fs.mkdir(path.join(cwd, '.git'));
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(cwd, 'ignored.txt'), 'ignored_marker\n');
  await fs.writeFile(path.join(cwd, 'sample.txt'), 'before\nneedle\nafter\n');
  return cwd;
}

const search = (cwd, params, abortSignal) => grepTool.execute(grepTool.parameters.parse(params), { cwd, abortSignal });

test('grep yields to the event loop and passes paths, regex and glob as literal arguments', async t => {
  const cwd = await fixture(t);
  let yielded = false;
  const tick = new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const result = await search(cwd, { pattern: 'needle', glob: '*.txt', context: 1 });
  assert.equal(yielded, true);
  await tick;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /sample\.txt:2:needle/);
  assert.match(result.content, /before/);
  assert.match(result.content, /after/);
  const literal = 'literal "quote" $(echo unwanted) & value';
  await fs.writeFile(path.join(cwd, 'literal.txt'), literal + '\n');
  const pattern = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.ok((await search(cwd, { pattern })).content.includes(literal));
  assert.equal((await search(cwd, { pattern: 'needle', glob: '*.txt; echo unwanted' })).content, '(no matches)');
});

test('no-match exit never rescans ignored files and invalid regex is reported', async t => {
  const cwd = await fixture(t);
  assert.deepEqual(await search(cwd, { pattern: 'ignored_marker' }), { content: '(no matches)' });
  const invalid = await search(cwd, { pattern: '(?=needle)needle' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /regex|look-around/i);
  const missing = await search(cwd, { pattern: 'needle', path: 'missing.txt' });
  assert.equal(missing.isError, true);
});

test('missing ripgrep retains the Node fallback and honors its result limit', async t => {
  const cwd = await fixture(t), previous = process.env.PATH;
  process.env.PATH = '';
  t.after(() => { process.env.PATH = previous; });
  await fs.writeFile(path.join(cwd, 'sample.txt'), 'needle\nneedle\n');
  const result = await search(cwd, { pattern: 'needle', path: 'sample.txt', max_results: 1 });
  assert.deepEqual(result, { content: 'sample.txt:1:needle' });
});

test('cancellation stops ripgrep and cannot trigger a fallback scan', async t => {
  const cwd = await fixture(t), controller = new AbortController();
  const pending = search(cwd, { pattern: 'needle' }, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { content: 'Search cancelled.', isError: true });
  assert.deepEqual(await search(cwd, { pattern: 'needle' }, controller.signal), { content: 'Search cancelled.', isError: true });
});

test('fallback cancellation during a read is not swallowed', async t => {
  const cwd = await fixture(t), previous = process.env.PATH, controller = new AbortController();
  process.env.PATH = '';
  t.after(() => { process.env.PATH = previous; });
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => {
    const content = await readFile(...args);
    controller.abort(new Error('fixture cancelled'));
    return content;
  });
  const result = await search(cwd, { pattern: 'needle' }, controller.signal);
  assert.equal(result.isError, true);
  assert.match(result.content, /cancelled/);
});

test('grep rejects negative, fractional and empty result limits', () => {
  for (const params of [{ context: -1 }, { context: 0.5 }, { max_results: 0 }, { max_results: 1.5 }]) {
    assert.equal(grepTool.parameters.safeParse({ pattern: 'needle', ...params }).success, false);
  }
});

test('missing ripgrep still honors nested ignore rules and brace globs',async t=>{
  const cwd=await fixture(t);await fs.mkdir(path.join(cwd,'nested'));
  await fs.writeFile(path.join(cwd,'nested/.ignore'),'private.ts\n');
  await fs.writeFile(path.join(cwd,'nested/private.ts'),'ignored_marker');
  await fs.writeFile(path.join(cwd,'nested/visible.ts'),'needle');
  const ctx={cwd,ripgrepPath:path.join(cwd,'missing-rg')};
  assert.deepEqual(await grepTool.execute(grepTool.parameters.parse({pattern:'ignored_marker'}),ctx),{content:'(no matches)'});
  assert.match((await grepTool.execute(grepTool.parameters.parse({pattern:'needle',glob:'**/*.{ts,tsx}'}),ctx)).content,/visible.ts:1:needle/);
});

test('the rebuilt desktop harness executes grep through its real tool loop', async t => {
  const { runDesktopTurn, CheckpointManager } = await import('../vendor/notch-core/desktop-harness.js');
  const cwd = await fixture(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    const toolResult = body.messages.find(message => message.role === 'tool');
    if (requests++ > 0) {
      assert.ok(toolResult);
      assert.match(toolResult.content, /sample\.txt:2:needle/);
    }
    const delta = toolResult ? { content: 'SEARCH_VERIFIED' } : {
      tool_calls: [{ index: 0, id: 'grep-fixture', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle' }) } }],
    };
    const chunk = { id: 'grep-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const result = await runDesktopTurn({ cwd, sessionId: 'grep-test', messages: [{ role: 'user', content: 'Search for needle' }],
    model: 'openrouter/openai/gpt-4.1', apiKey: 'fixture-only', contextWindow: 8192,
    accessMode: 'read-only', signal: AbortSignal.timeout(15000), checkpoints: new CheckpointManager(), tools: ['Grep'], approve: async () => true });
  assert.equal(result.text, 'SEARCH_VERIFIED');
  assert.equal(requests, 2);
});
