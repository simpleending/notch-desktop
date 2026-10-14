import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || '../notch-workbench-skin-verification.json');
const directory = await mkdtemp(path.join(os.tmpdir(), 'notch-skin-')), profile = path.join(directory, 'profile'), workspacePath = path.join(directory, 'project');
await mkdir(profile); await mkdir(workspacePath);
await writeFile(path.join(workspacePath, 'hello.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n');
await writeFile(path.join(workspacePath, 'README.md'), '# notch reskin check\n\nTemporary files for UI verification.\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors = [], audioRequests = [], checks = {};
let app;
async function launch() {
  app = await _electron.launch({ executablePath: executable, args: ['--lang=en-US', `--user-data-dir=${profile}`], env, timeout: 45000 });
  app.on('window', page => {
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack, url: page.url() }));
    page.on('request', request => { if (/onboarding.*\.wav/i.test(request.url())) audioRequests.push(request.url()); });
  });
}
async function appearance(page, dark) {
  const control = page.getByRole('switch', { name: 'Dark appearance' });
  if ((await control.getAttribute('aria-checked') === 'true') !== dark) await control.click();
  await page.locator(`html[data-notch-appearance=${dark ? 'dark' : 'light'}]`).waitFor();
}
async function capture(page, label) {
  await page.screenshot({ path: reportFile.replace(/\.json$/, `-${label}.png`), timeout: 15000 });
}
try {
  await launch();
  let setup;
  const deadline = Date.now() + 30000;
  while (!setup && Date.now() < deadline) {
    setup = app.windows().find(page => page.url().includes('first-launch-onboarding-overlay'));
    if (!setup) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(setup, 'First launch should show setup.');
  await setup.getByRole('button', { name: 'dark', exact: true }).click();
  await setup.getByRole('button', { name: 'Continue' }).click();
  const closed = setup.waitForEvent('close');
  await setup.getByRole('button', { name: 'Open notch' }).click(); await closed;
  const page = await app.firstWindow();
  await page.locator('.notch-welcome').waitFor();
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  await page.getByRole('button',{name:'Chat',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Chat',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Code',exact:true}).click(); checks.modeSwitch = true;
  await appearance(page, true);
  assert.doesNotMatch(await page.locator('body').innerText(), /The Apple|Gravity|Beyond Coding|Credits|Get the mobile app/);
  assert.equal(await page.locator('.notch-quick-start, .notch-theme-sample, .notch-welcome article').count(), 0);
  assert.equal(await page.locator('.notch-window-brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
  await page.waitForFunction(() => {
    const model = document.querySelector('button[aria-label="Model"]');
    return model && !/loading/i.test(model.innerText);
  });
  checks.darkColors = await page.evaluate(() => ({ main: getComputedStyle(document.querySelector('[data-layout-region=b]')).backgroundColor,
    text: getComputedStyle(document.querySelector('.notch-welcome h1')).color }));
  assert.equal(checks.darkColors.main, 'rgb(17, 24, 32)');
  await capture(page, 'home-dark');
  await appearance(page, false); await capture(page, 'home-light');
  checks.lightColors = await page.evaluate(() => ({ main: getComputedStyle(document.querySelector('[data-layout-region=b]')).backgroundColor,
    text: getComputedStyle(document.querySelector('.notch-welcome h1')).color }));
  assert.equal(checks.lightColors.main, 'rgb(245, 244, 240)');
  await appearance(page, true);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  checks.modelMenu = await page.locator('[role=menu], [role=listbox]').allTextContents();
  assert.ok(checks.modelMenu.length > 0); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Access permissions', exact: true }).click();
  checks.accessMenu = await page.locator('[role=menu], [role=listbox]').allTextContents();
  assert.ok(checks.accessMenu.length > 0); await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'New Task', exact: true });
  await composer.fill('Explain the entry point without editing files.');
  assert.match(await composer.innerText(), /Explain the entry point/); await composer.fill(''); checks.typing = true;
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('dialog').waitFor(); checks.projectDialog = await page.getByRole('dialog').innerText();
  // Select a real fixture folder without automating the operating system's file picker.
  await app.evaluate(({dialog}, root) => {dialog.showOpenDialog = async () => ({canceled:false,filePaths:[root]});}, workspacePath);
  checks.filePicker = 'controlled fixture selection; OS dialog not tested';
  await page.getByText('Click to add a readable and editable folder', {exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox').fill('notch reskin check');
  await page.getByRole('button', {name:'Create',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('heading', {name:'notch reskin check',exact:true}).waitFor();
  await page.getByRole('button', {name:'Open sidebar',exact:true}).click();
  await page.getByRole('button', {name:'Files',exact:true}).click();
  await page.getByText('hello.ts', {exact:true}).first().waitFor();
  await page.getByText('hello.ts', {exact:true}).first().click();
  await page.locator('.cm-editor').waitFor();
  checks.editor = await page.locator('.cm-editor').innerText(); assert.match(checks.editor,/export function greet/);
  await capture(page, 'editor-dark');
  await page.getByRole('button', {name:'Open user menu',exact:true}).first().click();
  assert.doesNotMatch(await page.getByRole('menu').innerText(),/Show pet|Get the mobile app|Forest|Parchment|Bee/);
  await page.getByRole('menuitem', {name:'Settings',exact:true}).click();
  await page.locator('.notch-appearance').waitFor();
  assert.equal(await page.getByRole('radio').count(),3);
  await page.getByLabel('Content width', {exact:true}).selectOption('wide');
  assert.equal(await page.getByLabel('Content width', {exact:true}).inputValue(),'wide');
  await capture(page,'settings-dark');
  await page.getByRole('radio',{name:'Light',exact:true}).check();
  await page.locator('html[data-notch-appearance=light]').waitFor(); await capture(page,'settings-light');
  await page.getByText('Back to app',{exact:true}).click();
  await page.locator('.notch-welcome').waitFor();
  const hidePanel = page.getByRole('button',{name:'Hide sidebar',exact:true});
  if(await hidePanel.isVisible())await hidePanel.click();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().forEach(window => window.setSize(840,640)));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page,'compact-light'); checks.compact = true;
  await app.close(); app = null;
  await launch();
  const reopened = await app.firstWindow();
  await reopened.locator('html[data-notch-appearance=light]').waitFor(); checks.persisted = true;
  assert.equal(audioRequests.length,0); assert.deepEqual(errors,[]);
  await writeFile(reportFile,JSON.stringify({passed:true,executable,profile,workspacePath,checks,errors,audioRequests},null,2));
  console.log(JSON.stringify({passed:true,reportFile,profile}));
} catch(error) {
  await writeFile(reportFile,JSON.stringify({passed:false,executable,profile,workspacePath,error:error.message,checks,errors,audioRequests},null,2)); throw error;
} finally {if(app)await app.close().catch(()=>{});}
