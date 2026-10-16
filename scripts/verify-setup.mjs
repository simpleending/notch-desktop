import { _electron } from 'electron-qa';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || '../notch-setup-verification.json');
const profile = await mkdtemp(path.join(os.tmpdir(), 'notch-setup-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors = [], audioRequests = [];
let app;
async function launch() {
  app = await _electron.launch({ executablePath: executable, cwd: path.dirname(executable), args: ['--lang=en-US', `--user-data-dir=${profile}`], env, timeout: 45000 });
  app.on('window', page => {
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack, url: page.url() }));
    page.on('request', request => { if (/onboarding.*\.wav/i.test(request.url())) audioRequests.push(request.url()); });
  });
}
try {
  await launch();
  let setup;
  const deadline = Date.now() + 30000;
  while (!setup && Date.now() < deadline) {
    setup = app.windows().find(page => page.url().includes('first-launch-onboarding-overlay'));
    if (!setup) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(setup, 'Fresh profile must show setup automatically.');
  await setup.getByRole('heading', { name: 'Your code. Your machine.' }).waitFor();
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  const text = await setup.locator('.notch-setup').innerText();
  assert.doesNotMatch(text, /qoder|identity card|sign in|credits/i);
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), bounds: window.getBounds(), visible: window.isVisible() })));
  for (const theme of ['dark', 'light']) {
    await setup.getByRole('button', { name: theme, exact: true }).click();
    await setup.locator(`.notch-setup[data-appearance="${theme}"]`).waitFor();
    assert.equal(await setup.locator(`button[aria-pressed="true"]`).innerText(), theme);
    assert.equal(await setup.locator('.notch-setup-brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.equal(await setup.evaluate(() => document.querySelector('.notch-setup').scrollWidth <= innerWidth), true);
    await setup.screenshot({ path: reportFile.replace(/\.json$/, `-${theme}.png`) });
  }
  await setup.getByRole('button', { name: 'dark', exact: true }).click();
  await setup.getByRole('button', { name: 'Continue' }).focus();
  await setup.keyboard.press('Enter');
  await setup.getByRole('heading', { name: 'Start small. Build freely.' }).waitFor();
  assert.equal(await setup.getByRole('heading', { name: 'Start small. Build freely.' }).evaluate(node => document.activeElement === node), true);
  await setup.getByRole('button', { name: 'Back', exact: true }).click();
  await setup.getByRole('heading', { name: 'Your code. Your machine.' }).waitFor();
  await setup.getByRole('button', { name: 'Continue' }).click();
  const closed = setup.waitForEvent('close');
  await setup.getByRole('button', { name: 'Open notch' }).click();
  await closed;
  const workspace = await app.firstWindow();
  assert.equal(await workspace.evaluate(() => !!window.notchDesktop), true);
  assert.equal(audioRequests.length, 0);
  await app.close(); app = null;
  const files = await readdir(profile), stateFiles = files.filter(name => /onboard/i.test(name));
  const states = {};
  for (const name of stateFiles) { try { states[name] = JSON.parse(await readFile(path.join(profile, name), 'utf8')); } catch {} }
  assert.equal(Object.values(states).some(state => state.status === 'completed'), true);
  await launch();
  const reopened = await app.firstWindow();
  await reopened.waitForLoadState('domcontentloaded');
  await reopened.waitForFunction(() => !!window.notchDesktop);
  assert.equal(app.windows().some(page => page.url().includes('first-launch-onboarding-overlay')), false);
  // Give asynchronous first-launch dispatch a bounded chance to run again.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(app.windows().some(page => page.url().includes('first-launch-onboarding-overlay')), false);
  assert.equal(audioRequests.length, 0);
  assert.deepEqual(errors, []);
  await writeFile(reportFile, JSON.stringify({ executable, profile, passed: true, themes: ['dark', 'light'], audioRequests, errors, bounds, stateFiles }, null, 2));
  console.log(JSON.stringify({ reportFile, passed: true, profile }));
} catch (error) {
  await writeFile(reportFile, JSON.stringify({ executable, profile, passed: false, error: error.message, errors, audioRequests }, null, 2));
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
