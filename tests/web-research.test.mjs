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
