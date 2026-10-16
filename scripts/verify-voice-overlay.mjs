import { _electron } from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pcmWave } from '../src/local-voice.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]),voiceReport=JSON.parse(await fs.readFile(process.argv[4],'utf8'));
const profile=path.join(voiceReport.root,'profile'),taskId=voiceReport.events.find(event=>event.type==='toolCall').chatSessionId,audio=path.join(voiceReport.root,'silence.wav');
await fs.writeFile(audio,pcmWave(Buffer.alloc(320000)));
const errors=[],checks=[],palettes=[];let app,passed=false,failure;
try{
 app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${audio}`],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),timeout:45000});
 app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.notchDesktop);await page.evaluate(()=>window.notchDesktop.updateChatSessionRecapPreferences({enabled:false}));await page.evaluate(id=>window.notchDesktop.openChatSession(id),taskId);
 await page.getByText('Say READY.',{exact:true}).first().click();await page.getByRole('button',{name:'Start Live voice',exact:true}).click();
 let overlay;for(let i=0;i<200;i++){overlay=app.windows().find(page=>page.url().includes('surface=live-voice-overlay'));if(overlay)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(overlay);
 await overlay.locator('.notch-voice-brand').waitFor();assert.equal(await overlay.locator('#qoduck-voice-frame,.qoduck-voice-glass').count(),0);
 for(const mode of ['light','dark']){
  const current=await page.evaluate(()=>document.documentElement.dataset.notchAppearance);
  if(current!==mode)await page.getByRole('switch',{name:'Dark appearance',exact:true}).click();
  console.log('theme',mode,await page.evaluate(()=>({html:document.documentElement.outerHTML.slice(0,700)})),await overlay.evaluate(()=>({html:document.documentElement.outerHTML.slice(0,700),text:document.body.innerText.slice(0,300)})));
  await overlay.waitForFunction(mode=>document.documentElement.getAttribute('data-theme')?.endsWith(mode),mode);
  const palette=await overlay.locator('#orb-core').evaluate(element=>({background:getComputedStyle(element).backgroundColor,text:getComputedStyle(element.querySelector('.notch-voice-brand')).color}));
  const channel=value=>Number(value.match(/\d+/)?.[0]);assert.notEqual(palette.background,palette.text);assert.ok(mode==='dark'?channel(palette.background)<80&&channel(palette.text)>200:channel(palette.background)>200&&channel(palette.text)<80,JSON.stringify({mode,palette}));palettes.push({mode,...palette});
  await overlay.locator('#orb-button').hover();
  const png=await app.evaluate(async({BrowserWindow},url)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);return(await window.webContents.capturePage()).toPNG().toString('base64');},overlay.url());
  await fs.writeFile(reportFile.replace('.json','-'+mode+'.png'),Buffer.from(png,'base64'));
 }
 console.log('overlay controls',await overlay.getByRole('button').evaluateAll(buttons=>buttons.map(button=>({id:button.id,label:button.getAttribute('aria-label')}))));
 const toggle=async(id,value)=>{await overlay.locator('#'+id).click();await overlay.waitForFunction(({id,value})=>document.getElementById(id)?.getAttribute('aria-pressed')===String(value),{id,value});};
 await toggle('microphone-button',true);await toggle('microphone-button',false);await toggle('mute-button',true);await toggle('mute-button',false);
 checks.push('light/dark static Notch brand and status; no duck/sprite DOM; real speaker and microphone toggles');
 await overlay.locator('#close-button').click();await overlay.waitForEvent('close');await page.getByRole('button',{name:'Start Live voice',exact:true}).waitFor();assert.deepEqual(errors,[]);checks.push('close ends local voice and restores the composer');passed=true;
}catch(error){failure=error.stack;throw error;}finally{if(app)await app.close().catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed,executable,profile,checks,palettes,errors,failure},null,2));console.log(JSON.stringify({passed,reportFile,checks,palettes,failure}));}
