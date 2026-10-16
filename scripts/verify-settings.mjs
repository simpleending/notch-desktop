import { _electron } from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const executable=path.resolve(process.argv[2]||'release/Notch-prototype/Notch.exe');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-settings-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
const errors=[],screens=[];app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
try {
  let setup;const deadline=Date.now()+30000;
  while(!setup&&Date.now()<deadline){setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(setup,'Fresh setup opens');await setup.getByRole('button',{name:/^Continue(?: →)?$/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch(?: →)?$/}).click();await closed;
  const page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  await page.getByRole('button',{name:'Open user menu',exact:true}).first().click();
  await page.getByRole('menuitem',{name:'Settings',exact:true}).click();await page.locator('.notch-appearance').waitFor();
  const workspace=page.getByRole('combobox',{name:'Task workspace',exact:true});
  await workspace.waitFor();await page.waitForFunction(()=>!document.querySelector('select[aria-label="Task workspace"]').disabled);
  assert.equal(await workspace.inputValue(),'shared');
  await workspace.selectOption('isolated');await page.waitForFunction(async()=>await window.notchModels.workspace()==='isolated');
  assert.equal(JSON.parse(await fs.readFile(path.join(profile,'task-workspace.json'),'utf8')).mode,'isolated');
  await workspace.selectOption('shared');await page.waitForFunction(async()=>await window.notchModels.workspace()==='shared');
  assert.equal(JSON.parse(await fs.readFile(path.join(profile,'task-workspace.json'),'utf8')).mode,'shared');
  const navigation=page.getByRole('navigation',{name:'Settings',exact:true}),names=await navigation.getByRole('button').allTextContents();
  for(const name of names){
    const button=navigation.getByRole('button',{name:name.trim(),exact:true});await button.click();
    await page.waitForTimeout(200);
    assert.equal(await button.getAttribute('aria-current'),'page');
    assert.doesNotMatch(await page.locator('body').innerText(),/qoder|qoduck|Q\s?达鸭/i);
    assert.equal(await page.locator('.notch-setup,.profile-sticker-canvas').count(),0);
    screens.push(name.trim());
  }
  assert.ok(screens.length>=10,'Audit secondary settings, not only appearance');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.resolve('../notch-settings-verification.json'),JSON.stringify({passed:true,executable,profile,screens,errors},null,2));
  console.log(JSON.stringify({passed:true,screens,profile}));
} finally {await app.close();}
