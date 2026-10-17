import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {closeQaApp} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-colibri-ui-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors=[],checks=[];let app,page;
try {
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
  let setup;const until=Date.now()+30000;
  while(!setup&&Date.now()<until){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  for(const [width,height,dark] of [[900,600,true],[1000,700,false]]) {
    await app.evaluate(({BrowserWindow},{url,width,height})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);w.unmaximize();w.setBounds({x:40,y:40,width,height});},{url:page.url(),width,height});
    const theme=page.getByRole('switch',{name:'Dark appearance'});if((await theme.getAttribute('aria-checked')==='true')!==dark)await theme.click();
    await page.getByRole('button',{name:'Model',exact:true}).click();
    for(const name of ['Installed','Hugging Face','OpenRouter','Colibri']) {
      const tab=page.getByRole('tab',{name,exact:true});await tab.click();assert.equal(await tab.getAttribute('aria-selected'),'true');await tab.click({trial:true});
      const rect=await tab.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=width&&rect.y>=45&&rect.y+rect.height<=height);
    }
    await page.getByText('Colibri 2.0.0',{exact:false}).waitFor({timeout:15000});
    const row=page.getByRole('option').filter({hasText:'Qwen3-Coder-30B-A3B'});await row.click();
    const confirmation=page.getByRole('group',{name:'Confirm Colibri model download'});await confirmation.waitFor();
    await confirmation.getByText(/19.4 GB download/).waitFor();
    assert.equal(await confirmation.getByRole('button',{name:'Download and validate'}).isEnabled(),true);
    await confirmation.getByRole('button',{name:'Back to models'}).click();
    const tab=page.getByRole('tab',{name:'Colibri',exact:true});await tab.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab',{name:'Installed',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowLeft');assert.equal(await tab.getAttribute('aria-selected'),'true');
    await page.getByText('Colibri 2.0.0',{exact:false}).waitFor({timeout:15000});
    await page.screenshot({path:reportFile.replace('.json',dark?'-dark.png':'-light.png')});
    await page.keyboard.press('Escape');await page.locator('.notch-model-picker').waitFor({state:'hidden'});
    checks.push({width,height,theme:dark?'dark':'light',fourTabsClickable:true,keyboardWrap:true,realCatalog:true,downloadConfirmation:true});
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,profile,checks,errors,method:'Packaged renderer and native IPC; real installed engine/catalog, no download submitted.'},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch(error) {
  if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});
  await fs.writeFile(reportFile,JSON.stringify({passed:false,checks,errors,error:error.stack},null,2));throw error;
} finally {if(app)await closeQaApp(app);}
