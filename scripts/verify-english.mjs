import {_electron} from 'electron-qa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-english-')),profile=path.join(root,'profile'),workspace=path.join(root,'project');
await fs.mkdir(workspace);const checks=[],errors=[];let app,page,passed=false,failure,title,card;
try{
 app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),NOTCH_AUTO_DREAM:'0',NOTCH_AUTO_UPDATE:'0'},timeout:45000});
 app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
 await app.evaluate(()=>{
  const original=globalThis.fetch;globalThis.__englishQaRequests=0;
  globalThis.fetch=async(url,init)=>{
   if(!String(url).endsWith('/api/chat'))return original(url,init);
   const body=JSON.parse(init.body),messages=body.messages,tool=messages.some(message=>message.role==='tool');
   const fixture=messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('English approval verification'));
   globalThis.__englishQaRequests++;
   return new Response(JSON.stringify({model:body.model,message:{role:'assistant',content:fixture&&!tool?'':'The action was denied.',...(fixture&&!tool?{tool_calls:[{id:'english-permission',function:{name:'browser_interact',arguments:{url:'http://127.0.0.1:1',steps:[{action:'click',selector:'#submit'}]}}}]}:{})},done:true,done_reason:'stop',prompt_eval_count:100,eval_count:10})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  };
 });
 let setup;for(let i=0;i<300;i++){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(setup)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(setup);
 await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
 page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();await page.evaluate(()=>window.notchDesktop.updateChatSessionRecapPreferences({enabled:false}));
 assert.equal(await page.locator('html').getAttribute('lang'),'en');
 await page.evaluate(()=>window.notchModels.web({enabled:true}));
 await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},workspace)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});},workspace);
 await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('English interface verification');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.evaluate(()=>window.notchModels.state(true));
 await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('option').filter({hasText:/Qwen3\.5.*4B/i}).first().click();
 await page.getByRole('button',{name:'Access permissions',exact:true}).click();await page.getByRole('menuitem',{name:/^Ask for approval/}).click();
 const composer=page.locator('[contenteditable=true][role=textbox]').first();await composer.fill('English approval verification');await composer.press('Enter');
 const heading=page.getByText('Allow BrowserInteract?',{exact:true});await heading.waitFor({timeout:45000});title=await heading.innerText();
 card=await heading.locator('..').locator('..').innerText();assert.doesNotMatch(card,/\p{Script=Han}/u);await page.getByRole('button',{name:'Deny',exact:true}).waitFor();await page.getByRole('button',{name:'Allow once',exact:true}).waitFor();
 checks.push('real native BrowserInteract approval title, description, and controls are English');
 const png=await app.evaluate(async({BrowserWindow},url)=>(await BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url).webContents.capturePage()).toPNG().toString('base64'),page.url());
 await fs.writeFile(reportFile.replace(/\.json$/,'-permission.png'),Buffer.from(png,'base64'));
 await page.getByRole('button',{name:'Deny',exact:true}).click();await heading.waitFor({state:'hidden'});checks.push('Deny still resolves the native permission and prevents the browser action');
 assert.ok(await app.evaluate(()=>globalThis.__englishQaRequests)>0);assert.deepEqual(errors,[]);passed=true;
}catch(error){failure=error.stack;if(page){console.log('English QA state',await page.evaluate(async()=>({text:document.body.innerText.slice(-5500),models:await window.notchModels.state()})).catch(error=>error.message));}}finally{
 if(app)await app.close().catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed,executable,profile,checks,title,card,errors,failure,inference:'Provider response fixture; the permission UI, decision path, and packaged app are real.'},null,2));
}
console.log(JSON.stringify({passed,checks,reportFile,failure}));if(!passed)process.exitCode=1;
