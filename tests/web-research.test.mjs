import { verifyWorkbenchImports } from '../src/workbench-patch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebResearch } from '../src/web-research.mjs';
import { patchWebToolCatalog } from '../src/web-tools-patch.mjs';
import { patchModelPreload } from '../src/model-ipc.mjs';
import { CheckpointManager, runDesktopTurn } from '../vendor/notch-core/desktop-harness.js';

test('desktop WebSearch uses only the selected endpoint and returns filtered sources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-search-turn-'));
  const key = 'fixture-search-credential', query = 'Node fetch';
  let round, calls, response, request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === 'http://localhost:11434/api/tags') return Response.json({ models: [] });
    if (String(url) === 'http://127.0.0.1:11437/api/chat') {
      const message = round++ ? { content: 'Done.' } : {
        content: '', tool_calls: [{ function: { name: 'web_search', arguments: {
          query, include_domains: ['nodejs.org'], exclude_domains: ['old.nodejs.org'],
        } } }],
      };
      return Response.json({ message, done: true, prompt_eval_count: 500, eval_count: 30 });
    }
    calls++;
    request = { url: new URL(url), init };
    return response();
  });
  async function search(searchProvider, credentials = {}, enabled = true) {
    round = calls = 0;
    let result;
    await runDesktopTurn({
      cwd: root, sessionId: 'web-search-fixture', messages: [{ role: 'user', content: 'Find Node documentation.' }],
      model: 'ollama/fixture', baseUrl: 'http://127.0.0.1:11437', contextWindow: 32768, accessMode: 'read-only',
      signal: AbortSignal.timeout(15000), checkpoints: new CheckpointManager(), tools: ['WebSearch'],
      approve: async () => false, maxIterations: 3,
      webSettings: async () => ({ enabled, searchProvider, browser: 'auto', ...credentials }),
      onToolResult: (name, content, isError) => { assert.equal(name, 'web_search'); result = { content, isError }; },
    });
    assert.ok(result);
    return result;
  }
  const source = { title: 'Node documentation', link: 'https://nodejs.org/docs', snippet: 'Fetch documentation.' };
  const organic = [source, { link: 'https://old.nodejs.org/docs' }, { link: 'https://unrelated.example/' }, { link: 'javascript:alert(1)' }];
  function assertSources(result) {
    assert.equal(result.isError, false);
    assert.match(result.content, /\[Node documentation\]\(https:\/\/nodejs\.org\/docs\)/);
    assert.doesNotMatch(result.content, /old\.nodejs|unrelated\.example|javascript:|fixture-search-credential/);
    assert.equal(calls, 1);
  }
  try {
    response = () => new Response('<a class="result__a" href="https://nodejs.org/docs">Node documentation</a>');
    assertSources(await search('duckduckgo', { tavilyKey: key }));
    assert.equal(request.url.origin, 'https://html.duckduckgo.com');
    assert.equal(new Headers(request.init.headers).has('Authorization'), false);
    response = () => Response.json({ results: [{ title: source.title, url: source.link, content: source.snippet }] });
    assertSources(await search('tavily', { tavilyKey: key }));
    assert.equal(request.url.href, 'https://api.tavily.com/search');
    assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${key}`);
    assert.deepEqual(JSON.parse(request.init.body).include_domains, ['nodejs.org']);
    response = () => Response.json({ organic });
    assertSources(await search('serper', { serperKey: key }));
    assert.equal(request.url.href, 'https://google.serper.dev/search');
    assert.equal(new Headers(request.init.headers).get('X-API-KEY'), key);
    assert.match(JSON.parse(request.init.body).q, /site:nodejs\.org.*-site:old\.nodejs\.org/);
    response = () => Response.json({ organic_results: organic });
    assertSources(await search('serpapi', { serpapiKey: key }));
    assert.equal(request.url.origin + request.url.pathname, 'https://serpapi.com/search.json');
    assert.equal(request.url.searchParams.get('api_key'), key);
    response = () => Response.json({
      search_metadata: { status: 'Success' },
      search_information: { organic_results_state: 'Fully empty' },
      error: "Google hasn't returned any results for this query.",
    });
    const empty = await search('serpapi', { serpapiKey: key });
    assert.equal(empty.isError, false);
    assert.match(empty.content, /No results for/);
    response = () => Response.json({ search_metadata: { status: 'Error' }, error: key });
    const rejected = await search('serpapi', { serpapiKey: key });
    assert.equal(rejected.isError, true);
    assert.ok(!rejected.content.includes(key));
    response = () => new Response(key, { status: 429 });
    const quota = await search('serpapi', { serpapiKey: key });
    assert.equal(quota.isError, true);
    assert.match(quota.content, /429/);
    assert.ok(!quota.content.includes(key));
    assert.equal(calls, 1, 'A failed paid search must not fall back.');
    assert.match((await search('serpapi', { serperKey: key })).content, /SERPAPI_API_KEY/);
    assert.equal(calls, 0);
    assert.match((await search('duckduckgo', {}, false)).content, /disabled/);
    assert.equal(calls, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('web research skips repeats and finishes after compaction with real source links', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-research-loop-'));
  const source = 'https://example.com/official';
  const search = { function: { name: 'web_search', arguments: { query: 'official documentation' } } };
  const fetchPage = { function: { name: 'web_fetch', arguments: { url: source, max_length: 25000 } } };
  const requests = [], visible = [], lifecycle = [], archived = [];
  let searches = 0, reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'https://api.tavily.com/search') {
      searches++;
      return Response.json({ results: [{ title: 'Official documentation', url: source }] });
    }
    if (url === source) {
      reads++;
      return new Response('[Fake](https://example.com/fake)\n' + 'The page documents how the feature works. '.repeat(600));
    }
    assert.equal(url, 'http://127.0.0.1:11437/api/chat');
    const request = JSON.parse(init.body);
    requests.push(request);
    const message = [
      { tool_calls: [search] },
      { tool_calls: [search, fetchPage] },
      { content: '<tool_call><function=web_fetch></function></tool_call>' },
      { content: 'Here is the answer from my research.' },
    ][requests.length - 1];
    assert.ok(message, 'Research should switch to synthesis instead of looping.');
    return Response.json({ message, done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 30 });
  });
  try {
    const result = await runDesktopTurn({
      cwd, sessionId: 'research-loop', messages: [{ role: 'user', content: 'Research the feature and report what you found.' }],
      model: 'ollama/fixture', baseUrl: 'http://127.0.0.1:11437', contextWindow: 8192, accessMode: 'read-only',
      signal: AbortSignal.timeout(15000), checkpoints: { commit: async () => {}, recordAfter: async () => {} },
      tools: ['WebSearch', 'WebFetch', 'Read'], maxIterations: 5, approve: async () => false,
      webSettings: async () => ({ enabled: true, searchProvider: 'tavily', tavilyKey: 'fixture-key' }),
      onCompact: history => archived.push(structuredClone(history)), onLifecycle: event => lifecycle.push(event),
      onText: chunk => visible.push(chunk),
    });
    assert.equal(searches, 1, 'The same query was requested in two model rounds.');
    assert.equal(reads, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.compressed, true);
    assert.equal(archived.length, 1);
    assert.ok(lifecycle.includes('post-compact'));
    assert.ok(requests[2].tools.some(tool => tool.function.name === 'read'), 'Keep non-web tools available for mixed tasks.');
    assert.ok(!requests[2].tools.some(tool => /^web_/.test(tool.function.name)));
    assert.ok(!requests[2].messages.some(message => message.role === 'tool'), 'Synthesis consumes excerpts without replaying the web calls.');
    assert.match(requests[2].messages.at(-1).content, /The page documents how the feature works/);
    assert.match(requests[3].messages[0].content, /previous response was empty/);
    assert.match(result.text, /\[Official documentation\]\(https:\/\/example\.com\/official\)/);
    assert.doesNotMatch(result.text, /example\.com\/fake/);
    assert.doesNotMatch(visible.join(''), /<tool_call>/);
    assert.equal(visible.join(''), result.text);
    assert.equal(result.messages.at(-1).content, result.text);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the search limit spans rounds without disabling workspace tools', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-search-limit-'));
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'WORKSPACE_NOTES');
  const search = query => ({ function: { name: 'web_search', arguments: { query } } });
  const queries = [], requests = [], results = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'https://api.tavily.com/search') {
      const { query } = JSON.parse(init.body);
      queries.push(query);
      return Response.json({ results: [{ title: query, url: `https://example.com/${query}` }] });
    }
    assert.equal(url, 'http://127.0.0.1:11437/api/chat');
    requests.push(JSON.parse(init.body));
    const message = [
      { tool_calls: ['one', 'two', 'three'].map(search) },
      { tool_calls: ['one', 'four', 'five'].map(search) },
      { tool_calls: [{ function: { name: 'read', arguments: { path: 'notes.txt' } } }] },
      { content: 'The findings are consistent with the workspace notes.' },
    ][requests.length - 1];
    assert.ok(message);
    return Response.json({ message, done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 30 });
  });
  try {
    const result = await runDesktopTurn({
      cwd, sessionId: 'research-limit', messages: [{ role: 'user', content: 'Compare research findings with notes.txt.' }],
      model: 'ollama/fixture', baseUrl: 'http://127.0.0.1:11437', contextWindow: 32768, accessMode: 'read-only',
      signal: AbortSignal.timeout(15000), checkpoints: { commit: async () => {}, recordAfter: async () => {} },
      tools: ['WebSearch', 'Read'], maxIterations: 5, approve: async () => false,
      webSettings: async () => ({ enabled: true, searchProvider: 'tavily', tavilyKey: 'fixture-key' }),
      onToolResult: (name, text) => results.push({ name, text }),
    });
    assert.deepEqual(queries, ['one', 'two', 'three', 'four']);
    assert.equal(requests.length, 4);
    assert.ok(!requests[2].tools.some(tool => tool.function.name === 'web_search'));
    assert.ok(results.some(row => row.name === 'read' && row.text.includes('WORKSPACE_NOTES')));
    assert.equal(result.status, 'completed');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('web settings keep keys encrypted, redact IPC state and survive restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-settings-'));
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test', encryptStringAsync: async key => Buffer.from(key.split('').reverse().join('')), decryptStringAsync: async bytes => ({ result: bytes.toString().split('').reverse().join('') }) };
  try {
    const service = createWebResearch(root, { safeStorage });
    assert.equal((await service.status()).enabled, true); assert.equal((await service.status()).searchProvider, 'duckduckgo');
    await service.update({ key: 'tvly-test-only-secret', searchProvider: 'tavily', browser: 'msedge', enabled: false });
    const raw = await fs.readFile(path.join(root, 'web-research.json'), 'utf8'); assert.ok(!raw.includes('tvly-test-only-secret'));
    const fresh = createWebResearch(root, { safeStorage }); assert.equal((await fresh.configuration()).tavilyKey, 'tvly-test-only-secret');
    assert.deepEqual((await fresh.status()).credentials.tavily, { saved: true, environment: false });
    await Promise.all([
      fresh.update({ serperKey: 'serper-fixture-secret' }),
      fresh.update({ serpapiKey: 'serpapi-fixture-secret', searchProvider: 'serpapi' }),
    ]);
    const reloaded = createWebResearch(root, { safeStorage });
    assert.deepEqual(await reloaded.configuration(), {
      enabled: false, browser: 'msedge', searchProvider: 'serpapi', tavilyKey: 'tvly-test-only-secret',
      serperKey: 'serper-fixture-secret', serpapiKey: 'serpapi-fixture-secret',
    });
    assert.doesNotMatch(await fs.readFile(path.join(root, 'web-research.json'), 'utf8'), /fixture-secret/);
    assert.doesNotMatch(JSON.stringify(await reloaded.status()), /fixture-secret/);
    await reloaded.update({ serperKey: null });
    assert.equal((await reloaded.configuration()).serperKey, undefined);
    assert.equal((await reloaded.configuration()).serpapiKey, 'serpapi-fixture-secret');
    assert.ok(!JSON.stringify(await fresh.status()).includes('tvly-test-only-secret'));
    await assert.rejects(fresh.update({ browser: 'invalid' })); await assert.rejects(fresh.update({ key: '\ninvalid' })); await assert.rejects(fresh.update({ unexpected: true }));
    await assert.rejects(fresh.update({ searchProvider: 'invalid' }));
    await fresh.update({ searchProvider: 'duckduckgo' }); assert.equal((await fresh.configuration()).tavilyKey, 'tvly-test-only-secret');
    assert.equal((await createWebResearch(root, { safeStorage }).status()).searchProvider, 'duckduckgo');
    await fresh.update({ key: null }); assert.equal((await createWebResearch(root, { safeStorage }).status()).hasKey, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('without system encryption keys stay in memory and browser installs cannot overlap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-session-')); let release;
  try {
    const service = createWebResearch(root, { install: () => new Promise(resolve => { release = resolve; }) });
    await service.update({ key: 'tvly-session-test-only' }); assert.equal((await service.status()).persistentKey, false);
    assert.ok(!(await fs.readFile(path.join(root, 'web-research.json'), 'utf8')).includes('tvly-session-test-only'));
    assert.equal((await createWebResearch(root).status()).hasKey, false);
    const installing = service.install(); await assert.rejects(service.install(), /already running/); release(); await installing; assert.equal((await service.status()).installing, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('web tool and settings bridges patch once and fail closed on a changed native catalog', () => {
  const original = 'const KHe=["Read","Write","Edit","Glob","Grep","Bash","WebSearch","WebFetch","ImageGen"];';
  const patched = patchWebToolCatalog(original); assert.match(patched, /"BrowserRead","BrowserInteract"/); assert.equal(patchWebToolCatalog(patched), patched); assert.throws(() => patchWebToolCatalog('changed'), /differs/);
  assert.match(patched, /"Git","GitHub"/);
  assert.equal(patchWebToolCatalog(patched.replace('"Git","GitHub",', '')), patched);
  const bridge = patchModelPreload(''); assert.match(bridge, /web:patch=>/); assert.match(bridge, /webInstall:/); assert.equal(patchModelPreload(bridge), bridge);
});

test('packaging rejects a missing transitive renderer module before producing an installer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-renderer-modules-'));
  try {
    await fs.writeFile(path.join(root, 'workbench-skin.mjs'), "import './web-settings-view.mjs';");
    await fs.writeFile(path.join(root, 'model-menu.mjs'), 'export const ready = true;');
    await assert.rejects(verifyWorkbenchImports(root), /ENOENT/);
    await fs.writeFile(path.join(root, 'web-settings-view.mjs'), 'export const ready = true;');
    await verifyWorkbenchImports(root);
    await fs.writeFile(path.join(root, 'index-test.js'), "import {createnotchWorkbench} from './workbench-skin.mjs';");
    await fs.writeFile(path.join(root, 'workbench-skin.mjs'), 'export function createNotchWorkbench() {}');
    await verifyWorkbenchImports(root, false);
    await assert.rejects(verifyWorkbenchImports(root), /Renderer export missing: createnotchWorkbench/);
    await fs.writeFile(path.join(root, 'workbench-skin.mjs'), 'export function createnotchWorkbench() {}');
    await verifyWorkbenchImports(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
