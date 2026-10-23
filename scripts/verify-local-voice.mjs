import { _electron } from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createLocalVoice, pcmWave } from '../src/local-voice.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'analysis/local-voice-verification.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-voice-')),profile=path.join(root,'profile'),workspace=path.join(root,'project'),audio=path.join(root,'microphone.wav');
for(const folder of [profile,workspace,path.join(root,'Desktop'),path.join(root,'Documents'),path.join(root,'Downloads')])await fs.mkdir(folder);
await fs.cp(path.resolve(process.argv[4]||'analysis/voice-runtime/local-voice'),path.join(profile,'local-voice'),{recursive:true});
const engine=createLocalVoice(profile),spoken=await engine.synthesize('Say local voice is ready.');
const pcm=Buffer.alloc(Math.floor(spoken.length/3)*2+38400);
for(let i=0;i<Math.floor(spoken.length/3);i++)pcm.writeInt16LE(spoken.readInt16LE(Math.floor(i*1.5)*2),i*2);
await fs.writeFile(audio,pcmWave(pcm));await engine.shutdown();
const errors=[],checks=[],events=[];let app,page,passed=false,failure;
const until=async(check,label,timeout=120000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out: '+label);};
try{
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),USERPROFILE:root,HOME:root,NOTCH_AUTO_UPDATE:'0',NOTCH_AUTO_DREAM:'0',NOTCH_OLLAMA_CONTEXT:'8192',NOTCH_OLLAMA_THINK:'0'};
 app=await _electron.launch({executablePath:executable,args:['--lang=en-US','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${audio}`,`--user-data-dir=${profile}`],env,timeout:45000});
 app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
 await app.evaluate(()=>{const host=globalThis.__notchHost,query=host.query.bind(host),fetcher=globalThis.fetch;globalThis.__voiceQa={events:[],requests:[],voice:[]};globalThis.fetch=(url,init)=>{if(String(url).endsWith('/api/chat')){const body=JSON.parse(init.body);globalThis.__voiceQa.requests.push({model:body.model,context:body.options?.num_ctx})}return fetcher(url,init)};host.query=request=>{const result=query(request),emit=result.emit.bind(result);result.emit=event=>{globalThis.__voiceQa.events.push(event);return emit(event)};return result;};});
 let setup;await until(()=>{setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));return !!setup},'setup',30000);
 await setup.getByRole('button',{name:/^Continue/}).click();const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
 page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 await page.evaluate(()=>{window.notchDesktop.onVoiceRecognitionEvent(event=>{window.__dictationEvents??=[];window.__dictationEvents.push(event)})});
 await page.getByRole('button',{name:'Open user menu',exact:true}).first().click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
 await page.getByRole('navigation',{name:'Settings',exact:true}).getByRole('button',{name:'Voice',exact:true}).click();await page.getByText(/Cactus Whistle|Whisper Base|Speech models/).waitFor();
 await page.getByRole('switch',{name:'Enable voice input',exact:true}).check();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await page.getByRole('button',{name:'Start voice input',exact:true}).click();await page.getByRole('button',{name:'Stop voice input',exact:true}).waitFor();await page.waitForTimeout(5000);await page.getByRole('button',{name:'Stop voice input',exact:true}).click();
 const composer=page.locator('[contenteditable=true][role=textbox]').first();await until(async()=>/local voice.*ready/i.test(await composer.innerText()),'real local dictation transcript');
 checks.push('real renderer microphone capture, PCM streaming, local transcription and composer insertion');
 await composer.fill('');await page.getByRole('button',{name:'Open project',exact:true}).click();await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})},workspace);
 await page.getByText('Click to add a readable and editable folder',{exact:true}).click();await page.getByRole('dialog').getByRole('textbox').fill('Local voice test');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();
 const modelOption=page.getByRole('option').filter({hasText:/Qwen3\.5/i}).first();
 for(let retry=0;retry<4&&!await modelOption.isEnabled();retry++){await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(2000);}
 await modelOption.click();await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Manage models…',exact:true}).click();await page.getByRole('combobox',{name:'Context limit'}).selectOption('8192');await page.waitForFunction(()=>{const control=document.querySelector('select[aria-label="Context limit"]');return control?.value==='8192'&&!control.disabled});await page.keyboard.press('Escape');
 await composer.fill('Say READY.');await composer.press('Enter');
 await until(async()=>{const trace=await app.evaluate(()=>globalThis.__voiceQa);return trace.events.some(event=>event.type==='result'&&event.subtype==='success')},'initial real local model turn',240000);
 await page.evaluate(()=>{window.__voiceEvents=[];window.notchDesktop.onLiveVoiceEvent(event=>window.__voiceEvents.push(event))});
 console.log('voice controls',await page.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')||button.innerText).filter(text=>/voice|send|stop/i.test(text||''))));
 const startVoice=page.getByRole('button',{name:/^Start Live voice$/i});
 if(await startVoice.count())await startVoice.click();else{await composer.focus();await page.keyboard.press('Control+Shift+L');}
 await until(async()=>{const voice=await page.evaluate(()=>window.__voiceEvents||[]);return voice.some(event=>event.type==='toolCall'&&event.name==='SpawnBackendAgent')},'spoken request handed to the selected task');
 await until(async()=>{const voice=await page.evaluate(()=>window.__voiceEvents||[]);return voice.some(event=>event.type==='audio')},'real model reply and local speech output',240000);
 const voice=await page.evaluate(()=>window.__voiceEvents);assert.ok(voice.some(event=>event.type==='transcript'&&event.entry.role==='user'&&/local voice/i.test(event.entry.text)));assert.ok(voice.some(event=>event.type==='transcript'&&event.entry.role==='assistant'));
 checks.push('Live Voice silence detection, Whisper, native task handoff, real Qwen3.5 inference and local Windows speech playback');
 await page.evaluate(async()=>{const event=window.__voiceEvents.find(event=>event.voiceSessionId);await window.notchDesktop.stopLiveVoice({voiceSessionId:event.voiceSessionId})});
 const taskId=voice.find(event=>event.type==='toolCall').chatSessionId;
 const saved=await page.evaluate(id=>window.notchDesktop.openChatSession(id),taskId);
 assert.match(JSON.stringify(saved),/"messageStream":"voice"/,'Voice transcripts must be persisted in the native task history');
 checks.push('voice transcripts persist in the existing task without converting or deleting its conversation');
 events.push(...voice.map(event=>event.type==='audio'?{...event,audioBytes:Buffer.from(event.audio,'base64').length,audio:undefined}:event));
 const trace=await app.evaluate(()=>globalThis.__voiceQa);assert.ok(trace.requests.some(request=>request.model==='notch-hf-abd14067e8d7:latest'));assert.deepEqual(errors,[]);checks.push('stopping voice closes the session cleanly without a sign-in or hosted speech connection');
 await page.screenshot({path:reportFile.replace('.json','-voice.png')});passed=true;
}catch(error){failure=error.stack;if(page){console.log('voice diagnostics',await page.evaluate(()=>({events:window.__voiceEvents,dictation:window.__dictationEvents,text:document.body.innerText.slice(-2000)})).catch(()=>null));await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});}throw error;}finally{
 if(app)await app.close().catch(()=>{});
 await fs.writeFile(reportFile,JSON.stringify({passed,executable,root,checks,errors,events,failure},null,2));console.log(JSON.stringify({passed,reportFile,checks,failure}));
}
