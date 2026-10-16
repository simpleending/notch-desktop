const { _electron } = await import(process.env.NOTCH_QA_PLAYWRIGHT || 'electron-qa');
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const executable = path.resolve(process.argv[2]), reportFile = path.resolve(process.argv[3] || 'release/web-installed.json');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-ide-')), profile = path.join(root, 'profile'), cwd = path.join(root, 'project');
await fs.mkdir(cwd);
const model = 'ollama/notch-hf-abd14067e8d7:latest', base = 'http://127.0.0.1:11436';
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))), NOTCH_OLLAMA_CONTEXT: '8192', NOTCH_OLLAMA_THINK: '0', NOTCH_AUTO_DREAM: '0', NOTCH_AUTO_UPDATE: '0' };
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>notch browser test</title><main><h1 id="heading">Loading</h1><input id="name" aria-label="Name"><button id="submit">Submit</button><p id="result"></p><a href="https://playwright.dev/docs/browsers">Official source</a></main><script>setTimeout(()=>{document.querySelector("h1").id="ready";document.querySelector("h1").textContent="IDE_BROWSER_REAL_OK"},80);document.querySelector("button").onclick=()=>{let p=document.querySelector("#result");p.id="submitted";p.textContent="IDE_ACTION_REAL_OK "+document.querySelector("input").value}</script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
const checks = [], errors = []; let app, page, failure, trace;
const until = async (check, label, timeout = 240000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(100); } throw Error('Timed out: ' + label); };
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--lang=en-US', `--user-data-dir=${profile}`], env, timeout: 45000 });
  app.on('window', window => window.on('pageerror', error => errors.push(error.message)));
  await app.evaluate((_electron, root) => {
    process.env.HOME = root; process.env.USERPROFILE = root;
    const host = globalThis.__notchHost, query = host.query.bind(host), actualFetch = globalThis.fetch;
    globalThis.__webQa = { events: [], approvals: [], opened: [], searches: [], requests: [] };

    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://html.duckduckgo.com/html/')) globalThis.__webQa.searches.push({ provider: 'duckduckgo', url: String(url), authorization: new Headers(init?.headers).has('Authorization') });
      if (String(url) === 'https://api.tavily.com/search') {
        if (init.headers.Authorization !== 'Bearer tvly-fixture-only-secret' || JSON.parse(init.body).api_key) throw Error('Incorrect Tavily bearer contract');
        globalThis.__webQa.searches.push({ provider: 'tavily', query: JSON.parse(init.body).query, bearer: true });
        return new Response(JSON.stringify({ results: [{ title: 'Official source', url: 'https://playwright.dev/docs/browsers', content: 'Official browser documentation. IDE_SEARCH_FIXTURE_OK' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/chat')) { const body = JSON.parse(init.body); globalThis.__webQa.requests.push({ model: body.model, context: body.options?.num_ctx }); }
      return actualFetch(url, init);
    };
    host.query = request => {
      const approve = request.canUseTool;
      const result = query({ ...request, canUseTool: async (name, args, options) => {
        const row = { name, allowed: false }; globalThis.__webQa.approvals.push(row);
        const decision = await approve(name, args, options); row.allowed = decision.behavior === 'allow'; return decision;
      } });
      const emit = result.emit.bind(result); result.emit = event => { globalThis.__webQa.events.push(event); return emit(event); }; return result;
    };
  }, root);
}
const inspect = () => app.evaluate(() => globalThis.__webQa);
async function complete(count, allowInteraction = false) {
  await until(async () => {
    const state = await inspect(), results = state.events.filter(event => event.type === 'result');
    if (results.length >= count) { assert.equal(results.at(-1).subtype, 'success', JSON.stringify(results.at(-1))); return true; }
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    if (await allow.count() && await allow.first().isVisible()) {
      assert.ok(allowInteraction, 'Read-only research unexpectedly requires approval');
      assert.equal(state.approvals.at(-1).name, 'BrowserInteract');
      await page.screenshot({ path: reportFile.replace(/\.json$/, '-approval.png') }); await allow.first().click();
    }
  }, `Research turn ${count}`);
  return inspect();
}
try {
  await launch(); let setup;
  await until(() => { setup = app.windows().find(window => window.url().includes('first-launch-onboarding-overlay')); return !!setup; }, 'setup', 30000);
  await setup.getByRole('button', { name: /^Continue(?: →)?$/ }).click(); const closed = setup.waitForEvent('close'); await setup.getByRole('button', { name: /^Open notch(?: →)?$/ }).click(); await closed;
  page = await app.firstWindow(); await page.locator('.notch-welcome').waitFor();
  await app.evaluate(({ shell }) => { const open = shell.openExternal; shell.openExternal = async url => { globalThis.__webQa.opened.push(url); }; });
  await page.getByRole('button', { name: 'Open user menu', exact: true }).first().click(); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.locator('.notch-web-settings').waitFor(); const access = page.getByRole('combobox', { name: 'Web access', exact: true }); await until(async () => !await access.isDisabled(), 'web settings ready', 15000);
  const provider = page.getByRole('combobox', { name: 'Search provider', exact: true });
  assert.equal(await provider.inputValue(), 'duckduckgo');
  await provider.selectOption('tavily'); await until(async () => (await page.evaluate(() => window.notchModels.web())).searchProvider === 'tavily', 'choose Tavily');
  await provider.selectOption('duckduckgo'); await until(async () => (await page.evaluate(() => window.notchModels.web())).searchProvider === 'duckduckgo', 'choose DuckDuckGo');
  checks.push('Provider defaults to no-key DuckDuckGo and both choices save through the visible settings menu');
  await access.selectOption('false'); await until(async () => !(await page.evaluate(() => window.notchModels.web())).enabled, 'disable web access');
  await access.selectOption('true'); await until(async () => (await page.evaluate(() => window.notchModels.web())).enabled, 'enable web access');
  await page.getByLabel('Tavily API key', { exact: true }).fill('tvly-fixture-only-secret');
  await page.getByRole('button', { name: 'Save key', exact: true }).click(); await until(async () => (await page.evaluate(() => window.notchModels.web())).hasKey, 'save encrypted search key');
  await page.getByRole('button', { name: 'Remove key', exact: true }).click(); await until(async () => !(await page.evaluate(() => window.notchModels.web())).hasKey, 'remove search key');
  await page.getByLabel('Tavily API key', { exact: true }).fill('tvly-fixture-only-secret'); await page.getByRole('button', { name: 'Save key', exact: true }).click(); await until(async () => (await page.evaluate(() => window.notchModels.web())).hasKey, 'replace search key');
  assert.ok(!(await fs.readFile(path.join(profile, 'web-research.json'), 'utf8')).includes('tvly-fixture-only-secret')); checks.push('Settings save an encrypted key and toggle web access');
  await page.getByRole('combobox', { name: 'Research browser', exact: true }).selectOption('chromium');
  await until(async () => (await page.evaluate(() => window.notchModels.web())).browser === 'chromium', 'choose browser');
  await page.getByRole('button', { name: 'Install Chromium', exact: true }).click(); await page.getByText('Chromium is ready.', { exact: true }).waitFor({ timeout: 180000 }); checks.push('Installed application runs optional browser setup successfully');
  await page.screenshot({ path: reportFile.replace(/\.json$/, '-settings.png') });
  await app.close(); app = null; await launch(); page = await app.firstWindow();
  await page.locator('.notch-welcome,.notch-appearance').first().waitFor();
  const back = page.getByRole('button', { name: 'Back to app', exact: true }); if (await back.count()) await back.click();
  await page.locator('.notch-welcome').waitFor();
  await app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.__webQa.opened.push(url); }; });
  const saved = await page.evaluate(() => window.notchModels.web()); assert.equal(saved.hasKey, true); assert.equal(saved.searchProvider, 'duckduckgo'); assert.equal(saved.browser, 'chromium'); checks.push('Research settings survive a complete app restart');
  await page.evaluate(model => window.notchModels.context(model, 8192), model);
  await page.getByRole('button', { name: 'Open project', exact: true }).click(); await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, cwd);
  await page.getByText('Click to add a readable and editable folder', { exact: true }).click(); await page.getByRole('dialog').getByRole('textbox').fill('Web research verification'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const state = await page.evaluate(() => window.notchModels.state()); const row = state.models.find(row => row.key === model); assert.ok(row?.enabled, 'Real local model must be available');
  await page.getByRole('option').filter({ hasText: /Qwen3\.5.*4B/i }).first().click();
  await page.getByRole('button', { name: 'Access permissions', exact: true }).click(); await page.getByRole('menuitem', { name: /^Ask for approval/ }).click();
  const composer = page.getByRole('textbox', { name: 'New Task', exact: true });
  await composer.fill(`Use browser_read to read ${url} with wait_for "#ready" and max_length 1000. Report the verification heading and cite the returned documentation as [Official source](https://playwright.dev/docs/browsers). Do not use other tools.`); await composer.press('Enter');
  let result = await complete(1); assert.ok(result.events.some(event => event.message?.content?.some(part => part.type === 'tool_result' && !part.is_error && part.content.includes('IDE_BROWSER_REAL_OK'))));
  const link = page.locator('a[href="https://playwright.dev/docs/browsers"]').last(); await link.waitFor(); await link.click();
  await until(async () => (await inspect()).opened.includes('https://playwright.dev/docs/browsers') || page.frames().some(frame => frame.url().startsWith('https://playwright.dev/')) || app.context().pages().some(page => page.url().startsWith('https://playwright.dev/')) || !!await page.locator('[data-browser-url],iframe[src^="https://playwright.dev/"]').count(), 'source link opens', 15000);
  checks.push('Real local model renders a page with read tools and its source link opens');
  const continuation = page.locator('[contenteditable=true][role=textbox]').first();
  await continuation.fill('Use web_search once for "Playwright browser documentation". Cite a returned source URL as a Markdown link. Do not use other tools.'); await continuation.press('Enter');
  result = await complete(2); assert.ok(result.searches.some(row => row.provider === 'duckduckgo' && !row.authorization)); assert.ok(!result.searches.some(row => row.provider === 'tavily'));
  assert.ok(result.events.some(event => event.message?.content?.some(part => part.type === 'tool_result' && !part.is_error && part.content.includes('Web search results') && part.content.includes('https://playwright.dev/')))); checks.push('Real local model searches live DuckDuckGo without a key even with an unused saved Tavily key');
  await page.evaluate(() => window.notchModels.web({ searchProvider: 'tavily' }));
  await continuation.fill('Use web_search once for Playwright browsers. Include the result marker and cite its URL. Do not use other tools.'); await continuation.press('Enter');
  result = await complete(3); assert.ok(result.searches.some(row => row.provider === 'tavily')); assert.ok(result.events.some(event => event.message?.content?.some(part => part.type === 'tool_result' && !part.is_error && part.content.includes('IDE_SEARCH_FIXTURE_OK')))); checks.push('Real local model searches and cites through the packaged Tavily fixture');
  await page.getByRole('button', { name: 'Access permissions', exact: true }).click(); await page.getByRole('menuitem', { name: /^Ask for approval/ }).click();
  await continuation.fill(`Use browser_interact to open ${url}, fill #name with notch, then click #submit. Set wait_for to #submitted. Report the verification phrase. Do not use shell or other tools.`); await continuation.press('Enter');
  result = await complete(4, true); assert.ok(result.approvals.some(row => row.name === 'BrowserInteract' && row.allowed)); assert.ok(result.events.some(event => event.message?.content?.some(part => part.type === 'tool_result' && !part.is_error && part.content.includes('IDE_ACTION_REAL_OK notch')))); checks.push('Browser interactions wait for native approval and execute with the real local model');
  assert.ok(result.requests.length >= 6 && result.requests.every(row => row.context === 8192)); assert.deepEqual(errors, []);
  await page.screenshot({ path: reportFile.replace(/\.json$/, '-chat.png') }); trace = result;
} catch (error) { failure = error.stack || error.message; if (app) { trace = await inspect().catch(() => null); await page?.screenshot({ path: reportFile.replace(/\.json$/, '-failure.png') }).catch(() => {}); } }
finally {
  if (app) await app.close().catch(() => {}); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(reportFile, JSON.stringify({ passed: !failure, checks, failure, executable, profile, errors, trace, searchApi: 'Live DuckDuckGo; Tavily contract fixture, not a live Tavily account.', qaPlaywright: process.env.NOTCH_QA_PLAYWRIGHT || 'electron-qa (Playwright 1.64.0)' }, null, 2));
}
console.log(JSON.stringify({ passed: !failure, checks, failure, reportFile })); if (failure) process.exitCode = 1;
