import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || 'analysis/local-features-verification.json');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-local-features-'));
const exported = path.join(profile, 'exported.html');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors = [], requests = [], checks = [];
let app, page;
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--lang=en-US', `--user-data-dir=${profile}`], env, timeout: 45000 });
  app.on('window', value => value.on('pageerror', error => errors.push(error.message)));
  await app.evaluate(({ session }, exported) => {
    globalThis.__notchLocalExport = null;
    session.defaultSession.on('will-download', (_event, item) => { item.setSavePath(exported); item.once('done', (_event, state) => { globalThis.__notchLocalExport = state; }); });
  }, exported);
}
async function view(name) {
  await page.getByRole('link', { name, exact: true }).click();
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    for (const frame of page.frames()) if (await frame.getByRole('heading', { name, exact: true }).count()) return frame;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local ${name} view did not open.`);
}
try {
  await launch();
  let setup; const until = Date.now() + 30000;
  while (!setup && Date.now() < until) { setup = app.windows().find(value => value.url().includes('first-launch-onboarding-overlay')); if (!setup) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(setup);
  await setup.getByRole('button', { name: /^Continue(?: →)?$/ }).click();
  const closed = setup.waitForEvent('close'); await setup.getByRole('button', { name: /^Open notch(?: →)?$/ }).click(); await closed;
  page = await app.firstWindow(); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  let frame = await view('Knowledge Center');
  await frame.getByRole('button', { name: 'New note', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Title', exact: true }).fill('Local reference');
  await frame.getByRole('textbox', { name: 'Note text', exact: true }).fill('Qwen and Gemma use their own templates. <script>window.bad=1</script>');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: 'Saved on this device.' }).waitFor();
  await frame.getByRole('searchbox').fill('gemma'); await frame.getByRole('button', { name: 'Search', exact: true }).click();
  await frame.locator('.local-list button').filter({ hasText: 'Local reference' }).waitFor();
  assert.equal(await frame.evaluate(() => globalThis.bad), undefined);
  await frame.getByRole('searchbox').fill('unmatched fixture'); await frame.getByRole('button', { name: 'Search', exact: true }).click();
  await frame.getByText('No matches.', { exact: true }).waitFor();
  await frame.getByRole('searchbox').fill(''); await frame.getByRole('button', { name: 'Search', exact: true }).click();
  checks.push('notes save/search and source text never executes');
  await frame.getByRole('textbox', { name: 'Note text', exact: true }).fill('Uncommitted local draft');
  frame = await view('Sites');
  await frame.getByRole('button', { name: 'New site', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Title', exact: true }).fill('Local site');
  const html = '<!doctype html><html><meta http-equiv="refresh" content="0;url=https://preview-probe.invalid"><h1>Local preview proof</h1><script>fetch("https://preview-probe.invalid");parent.bad=1</script><img src="https://preview-probe.invalid/a"><a href="https://preview-probe.invalid">Outside</a></html>';
  await frame.getByRole('textbox', { name: 'HTML', exact: true }).fill(html);
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: 'Saved on this device.' }).waitFor();
  await frame.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = frame.frameLocator('iframe');
  await preview.getByRole('heading', { name: 'Local preview proof', exact: true }).waitFor();
  assert.equal(await preview.locator('script,meta[http-equiv=refresh],img[src],a[href]').count(), 0);
  assert.equal(await frame.locator('iframe').getAttribute('sandbox'), '');
  await frame.getByRole('button', { name: 'Export HTML', exact: true }).click();
  await page.waitForFunction(() => true);
  const exportDeadline = Date.now() + 10000;
  while (await app.evaluate(() => globalThis.__notchLocalExport) !== 'completed' && Date.now() < exportDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await fs.readFile(exported, 'utf8'), html);
  checks.push('sites save, offline sandboxed preview, and exact HTML export');
  await page.screenshot({ path: reportFile.replace('.json', '-sites.png') });
  frame = await view('Knowledge Center');
  await frame.getByRole('status').filter({ hasText: 'Recovered your local draft.' }).waitFor();
  assert.equal(await frame.getByRole('textbox', { name: 'Note text', exact: true }).inputValue(), 'Uncommitted local draft');
  checks.push('draft survives route changes');
  await app.close(); app = null;
  await launch(); page = await app.firstWindow();
  frame = await view('Knowledge Center');
  await frame.getByRole('status').filter({ hasText: 'Recovered your local draft.' }).waitFor();
  assert.equal(await frame.getByRole('textbox', { name: 'Note text', exact: true }).inputValue(), 'Uncommitted local draft');
  await frame.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await frame.locator('.local-list button').filter({ hasText: 'Local reference' }).click();
  assert.match(await frame.getByRole('textbox', { name: 'Note text', exact: true }).inputValue(), /Qwen and Gemma/);
  const fileInput = frame.locator('input[type=file]');
  await fileInput.setInputFiles({ name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('Imported private reference') });
  await frame.getByRole('status').filter({ hasText: 'Imported and saved on this device.' }).waitFor();
  assert.equal(await frame.getByRole('textbox', { name: 'Note text', exact: true }).inputValue(), 'Imported private reference');
  await frame.getByRole('button', { name: 'Delete saved document', exact: true }).click();
  await frame.getByRole('button', { name: 'Keep document', exact: true }).click();
  assert.equal(await frame.locator('.local-list button').filter({ hasText: 'imported.md' }).count(), 1);
  await frame.getByRole('button', { name: 'Delete saved document', exact: true }).click();
  await frame.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await frame.getByText('New draft. Save to keep it on this device.', { exact: true }).waitFor();
  assert.equal(await frame.locator('.local-list button').filter({ hasText: 'imported.md' }).count(), 0);
  checks.push('saved notes and unsaved drafts survive restart; real file import and explicit delete confirmation');
  await page.screenshot({ path: reportFile.replace('.json', '-knowledge.png') });
  for (const name of ['Knowledge Center', 'Sites']) { frame = await view(name); assert.doesNotMatch(await frame.locator('.local-feature').innerText(), /sign.?in|log.?in|subscribe|credits|pricing/i); }
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.waitForTimeout(500);
  assert.doesNotMatch(await page.locator('body').innerText(), /sign.?in|log.?in/i);
  assert.equal(await page.getByRole('button', { name: 'Marketplace', exact: true }).count(), 0);
  checks.push('extensions opens the local manager');
  await page.getByRole('button', { name: 'Open user menu', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Settings', exact: true });
  const names = await navigation.getByRole('button').allTextContents();
  for (const name of names) {
    await navigation.getByRole('button', { name: name.trim(), exact: true }).click();
    await page.waitForTimeout(150);
    assert.doesNotMatch(await page.locator('body').innerText(), /sign.?in|log.?in/i, `Account gate in ${name}`);
    if (/workspace index/i.test(name)) { await page.getByRole('button', { name: 'Refresh projects', exact: true }).waitFor(); await page.getByText('Open a project to search its files locally.', { exact: true }).waitFor(); }
  }
  assert.ok(names.some(name => /workspace index/i.test(name)), 'Local Workspace Index setting is present.');
  checks.push(`all ${names.length} settings pages open without sign-in`);
  assert.equal(requests.some(url => url.includes('preview-probe.invalid')), false);
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  await fs.writeFile(reportFile, JSON.stringify({ passed: true, executable, profile, checks, errors, requests, method: 'Actual packaged Electron; temporary profile, no accounts or model inference. Export path chosen by test.' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, profile }));
} catch (error) {
  await page?.screenshot({ path: reportFile.replace('.json', '-failure.png') }).catch(() => {});
  await fs.writeFile(reportFile, JSON.stringify({ passed: false, executable, profile, checks, error: error.stack, errors, requests }, null, 2)); throw error;
} finally { if (app) await app.close().catch(() => {}); }
