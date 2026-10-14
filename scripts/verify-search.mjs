import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || '../notch-native-search-verification.json');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-packaged-search-'));
const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'project');
await fs.mkdir(profile); await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored.ts\n');
await fs.writeFile(path.join(workspace, 'ignored.ts'), 'PRIVATE_MARKER\n');
await Promise.all(Array.from({ length: 220 }, (_, i) => fs.writeFile(path.join(workspace, `f${i}.ts`), 'NATIVE_MARKER\n')));
await fs.writeFile(path.join(workspace, 'long.ts'), 'x'.repeat(600) + 'NATIVE_MARKER\r\n');
await fs.writeFile(path.join(workspace, 'spaces.ts'), 'foo  bar\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
env.PATH = ''; // Prove packaged search needs no developer-installed ripgrep.
const errors = [], checks = {};
let app, page;
try {
  const binary = path.join(path.dirname(executable), 'resources/bin/notch-rg.exe');
  assert.equal(createHash('sha256').update(await fs.readFile(binary)).digest('hex'), '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680');
  for (const name of ['fff-LICENSE.txt', 'ripgrep-COPYING.txt', 'ripgrep-LICENSE-MIT.txt', 'ripgrep-UNLICENSE.txt', 'ripgrep-PCRE2-LICENSE.txt', 'ripgrep-PCRE2-COPYING.txt']) await fs.access(path.join(path.dirname(executable), 'resources/notices', name));
  checks.nativeBinaryAndNotices = true;
  app = await _electron.launch({ executablePath: executable, args: ['--lang=en-US', `--user-data-dir=${profile}`], env, timeout: 45000 });
  app.on('window', window => window.on('pageerror', error => errors.push(error.message)));
  let setup; const deadline = Date.now() + 30000;
  while (!setup && Date.now() < deadline) { setup = app.windows().find(window => window.url().includes('first-launch-onboarding-overlay')); if (!setup) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(setup);
  await setup.getByRole('button', { name: /^Continue/ }).click();
  const closed = setup.waitForEvent('close'); await setup.getByRole('button', { name: /^Open notch/ }).click(); await closed;
  page = await app.firstWindow(); await page.locator('.notch-welcome').waitFor();
  await page.evaluate(() => window.notchDesktop.listChatComposerModels({ fetchStrategy: 'live', executionHostKind: 'local', workspaceDirectories: [] }));
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, workspace);
  await page.getByText('Click to add a readable and editable folder', { exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('native search check');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // A protocol fixture drives the actual composer -> harness -> utility process flow deterministically.
  await app.evaluate(() => {
    const host = globalThis.__notchHost, query = host.query.bind(host), search = host.workspaceSearch.tool.bind(host.workspaceSearch), previous = globalThis.fetch;
    const trace = globalThis.__notchSearchChecks = { calls: [], results: [], providerTools: [] };
    host.workspaceSearch.tool = async (...args) => {
      const start = Date.now(), result = await search(...args);
      trace.calls.push({ operation: args[0], params: args[2], engine: host.workspaceSearch.engine, elapsedMs: Date.now() - start, content: result?.content });
      return result;
    };
    host.query = request => {
      const result = query({ ...request, tools: ['Grep', 'Glob'] }), emit = result.emit.bind(result);
      result.emit = event => { if (event.type === 'result') trace.results.push(event); emit(event); };
      return result;
    };
    globalThis.fetch = async (url, options) => {
      const target = typeof url === 'string' ? url : url.url || String(url);
      if (!target.endsWith('/v1/chat/completions') && !target.endsWith('/api/chat')) return previous(url, options);
      const body = JSON.parse(options.body), user = body.messages.filter(message => message.role === 'user').at(-1);
      const compatibility = JSON.stringify(user?.content).includes('CHECK_COMPATIBILITY');
      const toolMessages = body.messages.filter(message => message.role === 'tool');
      trace.providerTools = toolMessages;
      const completed = toolMessages.some(message => message.tool_call_id === (compatibility ? 'compat' : 'native-grep') ||
        (message.tool_name === 'grep' && String(message.content).includes(compatibility ? 'foo  bar' : 'NATIVE_MARKER')));
      const calls = compatibility ? [{ index: 0, id: 'compat', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'foo  bar' }) } }] : [
        { index: 0, id: 'native-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'NATIVE_MARKER' }) } },
        { index: 1, id: 'native-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*.ts' }) } },
      ];
      if (target.endsWith('/api/chat')) {
        const frame = { model: body.model, message: { role: 'assistant', content: completed ? 'PACKAGE_SEARCH_VERIFIED' : '',
          ...(completed ? {} : { tool_calls: calls.map(call => ({ id: call.id, function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) }) },
          done: true, done_reason: 'stop', prompt_eval_count: 1500, eval_count: 30 };
        return new Response(JSON.stringify(frame) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      const chunk = { id: 'search-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: completed ? { content: 'PACKAGE_SEARCH_VERIFIED' } : { tool_calls: calls }, finish_reason: null }] };
      const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1500, completion_tokens: 30, total_tokens: 1530 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  const composer = page.getByRole('textbox', { name: 'New Task', exact: true });
  await composer.fill('CHECK_NATIVE_SEARCH: find the project files and NATIVE_MARKER.'); await composer.press('Enter');
  async function waitResult(count) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const trace = await app.evaluate(() => globalThis.__notchSearchChecks);
      if (trace.results.length >= count) { assert.equal(trace.results.at(-1).is_error, false, JSON.stringify(trace.results.at(-1))); return trace; }
      const allow = page.getByRole('button', { name: 'Allow once', exact: true });
      if (await allow.count() && await allow.first().isVisible()) await allow.first().click();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Packaged search turn timed out.');
  }
  const first = await waitResult(1), nativeGrep = first.calls.find(call => call.operation === 'grep'), nativeGlob = first.calls.find(call => call.operation === 'glob');
  assert.equal(nativeGrep.engine, 'fff'); assert.equal(nativeGlob.engine, 'fff');
  assert.equal(nativeGrep.content.split('\n').filter(line => line.includes('NATIVE_MARKER')).length, 221);
  assert.ok(nativeGrep.content.includes('x'.repeat(600) + 'NATIVE_MARKER\r'));
  assert.doesNotMatch(nativeGlob.content, /ignored\.ts/); assert.match(nativeGlob.content, /Found 222 file/);
  assert.ok((await page.locator('body').innerText()).includes('PACKAGE_SEARCH_VERIFIED'));
  checks.nativeThroughComposer = { grep: nativeGrep.elapsedMs, glob: nativeGlob.elapsedMs, matchedLines: 221 };
  const continuation = page.locator('[contenteditable=true][role=textbox]').first();
  await continuation.fill('CHECK_COMPATIBILITY: find the literal two spaces between foo and bar.'); await continuation.press('Enter');
  const second = await waitResult(2);
  assert.equal(second.calls.at(-1).engine, 'ripgrep');
  assert.ok(second.providerTools.some(message => String(message.content).includes('foo  bar')));
  checks.compatibilityThroughComposer = true;
  await fs.appendFile(path.join(workspace, 'f0.ts'), 'FRESH_MARKER\n');
  await app.evaluate(async (_electron, root) => {
    const service = globalThis.__notchHost.workspaceSearch;
    service.invalidate(root);
    const fresh = await service.tool('grep', root, { pattern: 'FRESH_MARKER', context: 0, max_results: 50 });
    if (!fresh?.content.includes('f0.ts:2:FRESH_MARKER')) throw new Error('Packaged index did not see the edit.');
  }, workspace);
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored.ts\nf0.ts\n');
  checks.refreshAndCancellation = await app.evaluate(async (_electron, root) => {
    const service = globalThis.__notchHost.workspaceSearch;
    service.invalidate(root);
    const ignored = await service.tool('grep', root, { pattern: 'FRESH_MARKER', context: 0, max_results: 50 });
    if (ignored?.content !== '(no matches)') throw new Error('Packaged index did not refresh ignores.');
    const controller = new AbortController(), pending = service.tool('grep', root, { pattern: 'NATIVE_MARKER', context: 0, max_results: 50 }, controller.signal);
    controller.abort();
    try { await pending; throw new Error('Cancellation returned a result.'); } catch (error) { if (!/CANCELLED|abort/i.test(error.message)) throw error; }
    return true;
  }, workspace);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: reportFile.replace(/\.json$/, '.png') });
  await fs.writeFile(reportFile, JSON.stringify({ passed: true, executable, profile, workspace, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, reportFile, checks }));
} catch (error) {
  if (page) await page.screenshot({ path: reportFile.replace(/\.json$/, '-failure.png') }).catch(() => {});
  const trace = app ? await app.evaluate(() => globalThis.__notchSearchChecks).catch(() => null) : null;
  const body = page ? await page.locator('body').innerText().catch(() => null) : null;
  await fs.writeFile(reportFile, JSON.stringify({ passed: false, executable, profile, workspace, error: error.message, trace, body, checks, errors }, null, 2));
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
