import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-unsaved-quit-')),workspace=path.join(root,'project'),profile=path.join(root,'profile');await fs.mkdir(workspace);
const file=path.join(workspace,'file.txt'),original='Original file.\n',updated=original+'Unsaved edit.';await fs.writeFile(file,original);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));let app,page;
try{
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});page=await app.firstWindow();
  let setup;const deadline=Date.now()+30000;while(!setup&&Date.now()<deadline){setup=app.windows().find(w=>w.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(setup);
  await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},workspace);
  await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('unsaved quit');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Open sidebar',exact:true}).click();await page.getByRole('button',{name:'Files',exact:true}).click();await page.getByText('file.txt',{exact:true}).first().click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('Unsaved edit.');assert.equal(await fs.readFile(file,'utf8'),original);
  await app.evaluate(({dialog})=>{globalThis.__unsavedDialogs=[];dialog.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.__unsavedDialogs.push(options);return {response:options.cancelId??options.buttons.findIndex(text=>/cancel/i.test(text)),checkboxChecked:false};};});
  await app.evaluate(({app})=>{setImmediate(()=>app.quit())});
  const until=Date.now()+10000;let confirmation;
  while(Date.now()<until){assert.equal(app.process().exitCode,null,'The app must not discard an unsaved editor buffer');if((await app.evaluate(()=>globalThis.__unsavedDialogs.length))>0){confirmation='native';break;}
    const cancel=page.getByRole('button',{name:'Cancel',exact:true});if(await cancel.count()&&await cancel.first().isVisible()){await cancel.first().click();confirmation='workbench';break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(confirmation,'Quit must offer cancellation for an unsaved buffer');await new Promise(resolve=>setTimeout(resolve,500));assert.equal(app.process().exitCode,null);
  assert.equal(await app.evaluate(()=>globalThis.__notchDiscovery.signal.aborted),false);assert.equal(await fs.readFile(file,'utf8'),original);assert.ok((await page.locator('.cm-content').innerText()).includes('Unsaved edit.'));
  await page.locator('.cm-content').click();await page.keyboard.press('Control+s');const saveUntil=Date.now()+10000;while(await fs.readFile(file,'utf8')!==updated&&Date.now()<saveUntil)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await fs.readFile(file,'utf8'),updated);
  const child=app.process(),exit=new Promise(resolve=>child.once('exit',code=>resolve(code)));await app.evaluate(({app})=>{setImmediate(()=>app.quit())});let timer;assert.equal(await Promise.race([exit,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Saved app did not exit')),15000)})]).finally(()=>clearTimeout(timer)),0);app=null;
  const report={passed:true,executable,root,confirmation,unsavedVeto:true,bufferPreserved:true,savedBeforeCleanExit:true};await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await fs.writeFile(reportFile,JSON.stringify({passed:false,root,error:error.stack,body:page?await page.locator('body').innerText().catch(()=>null):null},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();await stopOwnedProcesses(child.pid,before);}}
