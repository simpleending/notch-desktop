import {_electron} from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {closeQaApp} from './process-tree.mjs';
import {pcmWave} from '../src/local-voice.mjs';
const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const source=JSON.parse(await fs.readFile(process.argv[4],'utf8'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-brand-qa-')),profile=path.join(root,'profile'),audio=path.join(root,'silence.wav');
await fs.cp(source.profile,profile,{recursive:true});await fs.writeFile(audio,pcmWave(Buffer.alloc(320000)));
const report={passed:false,executable,profile,checks:[],themes:[]},errors=[];let app,page,overlay;
try{
 app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${audio}`],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),timeout:45000});
 app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
 await app.evaluate(()=>{const fetcher=globalThis.fetch;globalThis.fetch=(url,init)=>{if(/\/(?:api\/chat|v1\/chat\/completions)$/.test(String(url)))throw new Error('Inference must not run in an artwork-only check');return fetcher(url,init);};});
 page=await app.firstWindow();await page.waitForFunction(()=>!!window.notchDesktop);
 await page.evaluate(id=>window.notchDesktop.openChatSession(id),source.after.session_id);
 const title=page.getByText('Say READY.',{exact:true}).first();if(await title.count())await title.click();
 await page.locator('.notch-recap-mark').waitFor({timeout:30000});
 assert.equal(await page.locator('.notch-recap-mark').locator('path').count(),2);
 const card=page.getByRole('region',{name:'Recap'});assert(await card.count()>0);assert((await card.innerText()).includes(source.after.text));
 await page.getByRole('button',{name:'Start Live voice',exact:true}).click();
 for(let i=0;i<200;i++){overlay=app.windows().find(p=>p.url().includes('surface=live-voice-overlay'));if(overlay)break;await new Promise(r=>setTimeout(r,100));}assert(overlay);
 await overlay.locator('.notch-voice-brand').waitFor();assert.equal((await overlay.locator('.notch-voice-brand').innerText()).trim(),'');
 assert.equal(await overlay.locator('.notch-voice-brand svg').count(),1);assert.equal(await overlay.locator('#qoduck-voice-frame,.qoduck-voice-glass').count(),0);
 for(const mode of ['dark','light']){
  const current=await page.evaluate(()=>document.documentElement.dataset.notchAppearance);
  report.themes.push({requested:mode,current,overlay:await overlay.evaluate(()=>document.documentElement.getAttribute('data-theme'))});
  if(current!==mode)await page.getByRole('switch',{name:'Dark appearance',exact:true}).click();
  await overlay.waitForFunction(mode=>document.documentElement.getAttribute('data-theme')?.endsWith(mode),mode);
  await page.screenshot({path:reportFile.replace('.json',`-recap-${mode}.png`)});
  await overlay.locator('#orb-button').hover();
  await new Promise(resolve=>setTimeout(resolve,250));
  const image=await app.evaluate(async({BrowserWindow},url)=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).webContents.capturePage()).toPNG().toString('base64'),overlay.url());
  await fs.writeFile(reportFile.replace('.json',`-voice-${mode}.png`),Buffer.from(image,'base64'));
 }
 for(const id of ['microphone-button','mute-button'])for(const value of [true,false]){await overlay.locator('#'+id).click();await overlay.waitForFunction(({id,value})=>document.getElementById(id)?.getAttribute('aria-pressed')===String(value),{id,value});}
 const closed=overlay.waitForEvent('close');await overlay.locator('#close-button').click();await closed;
 assert.deepEqual(errors,[]);report.checks=['canonical n replaces recap pen; original recap text intact','n-only floating widget in dark/light; no old sprites','microphone and speaker toggles work; close ends voice'];report.passed=true;
}catch(error){report.error=error.stack;if(page){report.mainTheme=await page.evaluate(()=>({html:document.documentElement.outerHTML.slice(0,700),switch:document.querySelector('[aria-label="Dark appearance"]')?.outerHTML})).catch(()=>null);await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});}if(overlay)report.overlayTheme=await overlay.evaluate(()=>({html:document.documentElement.outerHTML.slice(0,700),body:document.body.innerText.slice(0,400)})).catch(()=>null);process.exitCode=1;}
finally{if(app)await closeQaApp(app);report.errors=errors;await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
