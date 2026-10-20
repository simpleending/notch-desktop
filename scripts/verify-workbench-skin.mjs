import { _electron } from 'electron-qa';
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
await writeFile(path.join(workspacePath, 'configuration.ts'), 'export const configuration = true;\n');
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
  const initialModels=await page.evaluate(()=>window.notchModels.state());
  const initialModel=initialModels.models.find(row=>row.key===initialModels.defaultModel);
  await page.getByRole('button',{name:'Model',exact:true}).getByText(`${initialModel.defaultContextWindow/1024}K`,{exact:true}).waitFor();checks.startupContext=true;
  checks.darkColors = await page.evaluate(() => ({ main: getComputedStyle(document.querySelector('[data-layout-region=b]')).backgroundColor,
    text: getComputedStyle(document.querySelector('.notch-welcome h1')).color }));
  assert.equal(checks.darkColors.main, 'rgb(24, 24, 27)');
  await capture(page, 'home-dark');
  await appearance(page, false); await capture(page, 'home-light');
  checks.lightColors = await page.evaluate(() => ({ main: getComputedStyle(document.querySelector('[data-layout-region=b]')).backgroundColor,
    text: getComputedStyle(document.querySelector('.notch-welcome h1')).color }));
  assert.equal(checks.lightColors.main, 'rgb(245, 244, 246)');
  await appearance(page, true);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  checks.modelMenu = await page.locator('[role=menu], [role=listbox]').allTextContents();
  assert.ok(checks.modelMenu.length > 0);
  checks.menuRadius = await page.locator('.notch-model-picker').evaluate(menu=>getComputedStyle(menu).borderRadius);
  assert.equal(checks.menuRadius,'10px'); await capture(page,'model-menu-dark');
  await page.getByRole('searchbox',{name:'Search models'}).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'option');
  checks.modelArrowNavigation=true;
  const initialContext=await page.getByRole('combobox',{name:'Context limit'}).inputValue();
  const contextChoices=await page.getByRole('combobox',{name:'Context limit'}).locator('option').evaluateAll(options=>options.map(option=>option.value));
  assert.equal(initialContext,'auto');assert.ok(contextChoices.includes('16384'));checks.automaticContext=true;
  await page.getByRole('combobox',{name:'Context limit'}).selectOption('16384');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Context limit"]')?.value==='16384');
  await page.getByRole('combobox',{name:'Context limit'}).selectOption('8192');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Context limit"]')?.value==='8192');
  await page.getByRole('combobox',{name:'Context limit'}).selectOption('auto');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Context limit"]')?.value==='auto');
  checks.modelContextChoices=contextChoices;
  // Exercise the extended menu without allocating a 256K cache on this QA device.
  await app.evaluate(()=>{const host=globalThis.__notchHost;globalThis.__notchRealListModels=host.listModels;host.listModels=async(...args)=>(await globalThis.__notchRealListModels(...args)).map(row=>row.provider==='ollama'?{...row,availableContextWindows:[...new Set([...row.availableContextWindows,131072,262144])].sort((a,b)=>a-b)}:row);});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  const extendedContext=page.getByRole('checkbox',{name:'Show extended context (256K)',exact:true});
  await extendedContext.waitFor();assert.equal(await page.getByRole('combobox',{name:'Context limit'}).locator('option[value="262144"]').count(),0);
  await extendedContext.check();assert.equal(await page.getByRole('combobox',{name:'Context limit'}).locator('option[value="262144"]').count(),1);
  await extendedContext.uncheck();assert.equal(await page.getByRole('combobox',{name:'Context limit'}).locator('option[value="262144"]').count(),0);
  await app.evaluate(()=>{globalThis.__notchHost.listModels=globalThis.__notchRealListModels;delete globalThis.__notchRealListModels;});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();checks.extendedContext='256K visibility checked with a simulated larger-memory catalog; no 256K model load';
  await page.getByRole('tab',{name:'Hugging Face',exact:true}).click();
  await page.getByLabel('Hugging Face token (optional)',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Hugging Face token (optional)',{exact:true}).getAttribute('type'),'password');
  await page.getByRole('button',{name:'Not now',exact:true}).click();
  assert.equal(await page.getByLabel('Hugging Face token (optional)',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Add optional Hugging Face token',exact:true}).click();
  await page.getByLabel('Hugging Face token (optional)',{exact:true}).waitFor();
  await page.locator('[aria-label="Hugging Face models"] [role=option]').first().waitFor({timeout:25000});
  checks.hubModels=await page.locator('[aria-label="Hugging Face models"] [role=option]').allTextContents();
  const hubList=page.locator('[aria-label="Hugging Face models"]'),hubSearch=page.getByRole('searchbox',{name:'Search models'});
  await hubSearch.fill('gemm');
  await page.waitForFunction(()=>{
    const list=document.querySelector('[aria-label="Hugging Face models"]');
    return list?.getAttribute('aria-busy')==='false' && list.querySelectorAll('[role=option]').length>3 && /gemma/i.test(list.innerText);
  },undefined,{timeout:60000});
  const firstHubCount=await hubList.getByRole('option').count();
  checks.hubGemmaSearch=await hubList.getByRole('option').allTextContents();
  await hubSearch.focus();await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'option');
  await page.getByRole('button',{name:'Load more models',exact:true}).click();
  await page.waitForFunction(count=>{
    const list=document.querySelector('[aria-label="Hugging Face models"]');
    return list?.getAttribute('aria-busy')==='false' && list.querySelectorAll('[role=option]').length>count;
  },firstHubCount,{timeout:60000});
  checks.hubPagination={first:firstHubCount,total:await hubList.getByRole('option').count()};
  await hubSearch.fill('deepseek');await page.waitForTimeout(400);await hubSearch.fill('gemm');
  await page.waitForFunction(()=>{
    const list=document.querySelector('[aria-label="Hugging Face models"]');
    return list?.getAttribute('aria-busy')==='false' && list.querySelectorAll('[role=option]').length>3 && [...list.querySelectorAll('strong')].every(row=>/gemm/i.test(row.innerText));
  },undefined,{timeout:60000});
  checks.hubStaleSearch=true;
  const hubBounds=await page.locator('.notch-model-picker').evaluate(menu=>({top:menu.getBoundingClientRect().top,bottom:menu.getBoundingClientRect().bottom,height:innerHeight}));
  assert.ok(hubBounds.top>=0 && hubBounds.bottom<=hubBounds.height);checks.hubPopupFitsViewport=true;
  await capture(page,'hugging-face-dark');
  await page.getByRole('tab',{name:'OpenRouter',exact:true}).click();
  await page.getByLabel('OpenRouter API key',{exact:true}).waitFor();
  await page.waitForFunction(()=>{
    const list=document.querySelector('[aria-label="OpenRouter models"]');
    return list?.getAttribute('aria-busy')==='false' && list.querySelectorAll('[role=option]').length>100;
  },undefined,{timeout:60000});
  checks.publicCloudModels=await page.locator('[aria-label="OpenRouter models"] [role=option]').count();
  const cloudSearch=page.getByRole('searchbox',{name:'Search models'});
  for(const query of ['gemini','claude','deepseek']){
    await cloudSearch.fill(query);
    assert.ok(await page.locator('[aria-label="OpenRouter models"] [role=option]').count()>0);
    assert.equal(await page.locator('[aria-label="OpenRouter models"] [role=option]:not(:disabled)').count(),0);
  }
  await cloudSearch.fill('notch-no-such-model-fixture');assert.equal(await page.locator('[aria-label="OpenRouter models"] [role=option]').count(),0);await cloudSearch.fill('');
  checks.cloudSearch=true;
  const cloudBounds=await page.locator('.notch-model-picker').evaluate(menu=>({top:menu.getBoundingClientRect().top,bottom:menu.getBoundingClientRect().bottom,height:innerHeight}));
  assert.ok(cloudBounds.top>=0 && cloudBounds.bottom<=cloudBounds.height);checks.cloudPopupFitsViewport=true;
  assert.equal(await page.getByLabel('OpenRouter API key',{exact:true}).getAttribute('type'),'password');
  assert.equal(await page.getByRole('button',{name:'Connect',exact:true}).isDisabled(),true);
  await page.getByRole('tab',{name:'Hugging Face',exact:true}).click();
  await page.getByRole('tab',{name:'OpenRouter',exact:true}).click();
  await page.getByLabel('OpenRouter API key',{exact:true}).fill('sk-or-qa-only-inactive-key');
  assert.equal(await page.getByRole('button',{name:'Connect',exact:true}).isEnabled(),true);
  await page.getByLabel('OpenRouter API key',{exact:true}).fill('');checks.rapidTabSwitch=true;
  checks.providerMarks=await page.locator('.notch-model-tabs img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0));
  assert.equal(checks.providerMarks,true);await capture(page,'openrouter-dark');
  checks.keyForms=true;
  checks.osEncryption=await app.evaluate(async({safeStorage})=>{const available=await safeStorage.isAsyncEncryptionAvailable();if(!available)return {available};const encrypted=await safeStorage.encryptStringAsync('notch-qa-only-secret');const decrypted=await safeStorage.decryptStringAsync(encrypted);return {available,roundTrip:decrypted.result==='notch-qa-only-secret',opaque:!encrypted.includes(Buffer.from('notch-qa-only-secret'))};});
  assert.deepEqual(checks.osEncryption,{available:true,roundTrip:true,opaque:true});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Model',exact:true}).click();
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search models'}).fill('qwen3:4b');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Model',exact:true}).filter({hasText:'qwen3:4b'}).waitFor();checks.modelSelection=true;
  await page.waitForFunction(()=>document.activeElement?.isContentEditable);checks.modelRestoresComposerFocus=true;
  await page.getByRole('button',{name:'Model',exact:true}).click();
  await page.getByRole('switch',{name:'Dark appearance'}).click();
  await page.locator('html[data-notch-appearance=light]').waitFor();
  assert.equal(await page.getByRole('switch',{name:'Dark appearance'}).evaluate(control=>control===document.activeElement),true);checks.modelOutsideFocus=true;
  await appearance(page,true);
  await page.getByRole('button', { name: 'Access permissions', exact: true }).click();
  checks.accessMenu = await page.locator('[role=menu], [role=listbox]').allTextContents();
  assert.ok(checks.accessMenu.length > 0); await capture(page,'access-menu-dark'); await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'New Task', exact: true });
  await composer.fill('Explain the entry point without editing files.');
  assert.match(await composer.innerText(), /Explain the entry point/); await composer.fill(''); checks.typing = true;
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('dialog').waitFor(); checks.projectDialog = await page.getByRole('dialog').innerText();
  // Select a real fixture folder without automating the operating system's file picker.
  await app.evaluate(({dialog}, root) => {dialog.showOpenDialog = async () => ({canceled:false,filePaths:[root]});}, workspacePath);
  checks.filePicker = 'controlled fixture selection; OS dialog not tested';
  await page.getByText('Click to add a readable and editable folder', {exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role=dialog] input[placeholder="Defaults to the primary folder name"]')?.value==='project');
  await page.getByRole('dialog').getByRole('textbox').fill('notch reskin check');
  assert.equal(await page.getByRole('dialog').getByRole('textbox').inputValue(),'notch reskin check');
  await page.getByRole('button', {name:'Create',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('heading', {name:'notch reskin check',exact:true}).waitFor();
  await page.getByRole('button', {name:'Open sidebar',exact:true}).click();
  await page.getByRole('button', {name:'Files',exact:true}).click();
  await page.getByText('hello.ts', {exact:true}).first().waitFor();
  await page.getByText('hello.ts', {exact:true}).first().click();
  await page.locator('.cm-editor').waitFor();
  checks.editor = await page.locator('.cm-editor').innerText(); assert.match(checks.editor,/export function greet/);
  checks.codeFont = await page.locator('.cm-content').evaluate(editor=>getComputedStyle(editor).fontFamily);
  assert.doesNotMatch(checks.codeFont,/Manrope/);
  await capture(page, 'editor-dark');
  const fileSearch = page.getByRole('searchbox').last();
  await fileSearch.fill('configuraton');
  await page.getByText('configuration.ts',{exact:true}).first().waitFor();
  checks.searchEngine = await app.evaluate(()=>globalThis.__notchHost.workspaceSearch.engine);
  assert.equal(checks.searchEngine,'fff'); await capture(page,'file-search-dark'); await fileSearch.fill('');
  await page.getByRole('button', {name:'Open user menu',exact:true}).first().click();
  assert.doesNotMatch(await page.getByRole('menu').innerText(),/Show pet|Get the mobile app|Forest|Parchment|Bee/);
  await page.getByRole('menuitem', {name:'Settings',exact:true}).click();
  await page.locator('.notch-appearance').waitFor();
  assert.equal(await page.getByRole('radio').count(),3);
  checks.font = await page.locator('.notch-appearance h2').evaluate(async heading=>{await document.fonts.ready;return {family:getComputedStyle(heading).fontFamily,loaded:document.fonts.check('14px Manrope')};});
  assert.match(checks.font.family,/Manrope/); assert.equal(checks.font.loaded,true);
  await page.getByLabel('Content width', {exact:true}).selectOption('wide');
  assert.equal(await page.getByLabel('Content width', {exact:true}).inputValue(),'wide');
  await capture(page,'settings-dark');
  const size = page.getByLabel('Text size',{exact:true});
  assert.equal(await size.evaluate(select=>getComputedStyle(select).appearance),'base-select');
  await size.focus(); await page.keyboard.press('Space'); await capture(page,'settings-select-dark');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await size.inputValue(),'large'); checks.keyboardSelect = true;
  await size.selectOption('medium');
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
