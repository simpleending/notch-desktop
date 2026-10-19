import {modelPreload,patchModelPreload}from'../src/model-ipc.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSpeechModels,validateSpeechSelection,cactusWhistle} from '../src/speech-models.mjs';
import {pcmWave} from '../src/local-voice.mjs';
import {speechWavePcm} from '../src/speech-audio.mjs';
import {createHash} from 'node:crypto';
import {patchLocalServicesRenderer} from '../src/local-services-patch.mjs';
import {shouldCloseVoicePicker} from '../src/voice-model-picker.mjs';

async function fixture(options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notch-speech-test-')),requests=[];
 const catalog={stt:[{id:'test/transcribe',name:'Transcription',architecture:{output_modalities:['transcription']}},{id:'test/chat',architecture:{output_modalities:['text']}}],tts:[{id:'test/speak',name:'Speech',architecture:{output_modalities:['speech']},supported_voices:['first','second']}]};
 const models=createSpeechModels(directory,{platform:'win32',arch:'x64',legacyStatus:async()=>({ready:true,runtimeReady:true}),cactusStatus:async()=>({ready:true,runtimeReady:true,phase:'idle',bytes:0}),cactusTranscribe:async()=>'local transcript',run:async()=>JSON.stringify([{name:'Windows voice',language:'en-US'}]),legacyTranscribe:async()=> 'whisper transcript',systemSpeak:async()=>Buffer.alloc(480),pcmWave,availableMemory:()=>8*1024**3,getKey:async()=> 'test-private-key',fetcher:async(url,init)=>{requests.push({url,init});if(url.includes('/models?'))return Response.json({data:catalog[url.includes('transcription')?'stt':'tts']});if(url.endsWith('/transcriptions'))return Response.json({text:'cloud transcript'});if(url.endsWith('/speech'))return new Response(Buffer.alloc(480),{headers:{'Content-Type':'audio/pcm'}});throw Error('Unexpected URL '+url);},...options});
 return{models,directory,requests};
}
test('speech remains local by default; discovery filters audio tasks without transmitting speech',async()=>{
 const {models,requests}=await fixture();const state=await models.status();assert.equal(state.selection.stt.provider,'local');assert.equal(state.selection.stt.id,cactusWhistle.id);assert.equal(state.selection.tts.id,'windows');assert.equal((await models.catalog('stt','installed'))[0].id,cactusWhistle.id);assert.equal(await models.transcribe(Buffer.alloc(6400)),'local transcript');assert.equal((await models.synthesize('hello')).length,480);
 assert.deepEqual((await models.catalog('stt','openrouter')).map(row=>row.id),['test/transcribe']);assert.deepEqual((await models.catalog('tts','openrouter'))[0].voices,['first','second']);assert(requests.every(request=>request.url.includes('/models?')));await models.shutdown();
});
test('cloud selection requires explicit consent, matching task, supported voice and a connected key',async()=>{
 const {models}=await fixture();await assert.rejects(models.action('select',{role:'stt',selection:{provider:'openrouter',id:'test/transcribe'}}),/Confirm cloud/);await assert.rejects(models.select('stt',{provider:'openrouter',id:'test/speak'}),/not supported/);await assert.rejects(models.select('tts',{provider:'openrouter',id:'test/speak',voice:'wrong'}),/supported voice/);await models.shutdown();
 const disconnected=await fixture({getKey:async()=>undefined});await assert.rejects(disconnected.models.select('stt',{provider:'openrouter',id:'test/transcribe'}),/Connect/);await disconnected.models.shutdown();
});
test('OpenRouter adapters send WAV transcription and model-specific PCM speech requests; preferences survive restart',async()=>{
 const {models,directory,requests}=await fixture();await models.action('select',{role:'stt',selection:{provider:'openrouter',id:'test/transcribe'},cloudConfirmed:true});await models.action('select',{role:'tts',selection:{provider:'openrouter',id:'test/speak',voice:'second'},cloudConfirmed:true});assert.equal(await models.transcribe(Buffer.alloc(6400)),'cloud transcript');assert.equal((await models.synthesize('hello')).length,480);
 const audio=requests.find(request=>request.url.endsWith('/transcriptions'));assert.equal(audio.init.headers.Authorization,'Bearer test-private-key');const input=JSON.parse(audio.init.body);assert.equal(input.model,'test/transcribe');assert.equal(input.input_audio.format,'wav');assert.equal(Buffer.from(input.input_audio.data,'base64').subarray(0,4).toString(),'RIFF');
 const speech=JSON.parse(requests.find(request=>request.url.endsWith('/speech')).init.body);assert.deepEqual(speech,{model:'test/speak',input:'hello',voice:'second',response_format:'pcm'});await models.shutdown();
 const reloaded=createSpeechModels(directory,{legacyStatus:async()=>({ready:true}),getKey:async()=>undefined,fetcher:async()=>Response.json({data:[{id:'test/transcribe',architecture:{output_modalities:['transcription']}}]})});await assert.rejects(reloaded.ensureReady('stt'),/Reconnect/);assert.equal(reloaded.snapshot().tts.id,'test/speak');assert(!JSON.stringify(JSON.parse(await fs.readFile(path.join(directory,'local-voice/selection.json')))).includes('test-private-key'));await reloaded.shutdown();
});
test('speech selection rejects arbitrary local paths and unknown preference fields',()=>{
 for(const value of [{provider:'local',id:'../../file'},{provider:'other',id:'model'},{provider:'local',id:'windows',apiKey:'secret'}])assert.throws(()=>validateSpeechSelection(value));
});
test('speech WAV conversion resamples real PCM without accepting stereo, truncated or malformed audio',()=>{
 const pcm=Buffer.alloc(22050*2);for(let i=0;i<22050;i++)pcm.writeInt16LE(Math.round(Math.sin(i/10)*10000),i*2);const converted=speechWavePcm(pcmWave(pcm,22050));assert.equal(converted.length,24000*2);assert(converted.some(byte=>byte!==0));assert.deepEqual(speechWavePcm(pcmWave(pcm,24000)),pcm);assert.throws(()=>speechWavePcm(pcmWave(pcm).subarray(0,60)),/Truncated/);const stereo=pcmWave(pcm);stereo.writeUInt16LE(2,22);assert.throws(()=>speechWavePcm(stereo),/mono/);
});
test('active speech cannot change model mid-process and shutdown aborts cloud processing',async()=>{
 let entered,finish;const started=new Promise(resolve=>{entered=resolve});const {models}=await fixture({cactusTranscribe:async()=>{entered();await new Promise(resolve=>{finish=resolve});return 'done';}});const pending=models.transcribe(Buffer.alloc(6400));await started;await assert.rejects(models.select('tts',{provider:'local',id:'windows'}),/Finish speech/);finish();assert.equal(await pending,'done');await models.shutdown();
});

test('the native microphone opens model setup before capture and respects cancellation during readiness checks',async()=>{
 const fixture='let VoiceInputService=class{setConfiguration(){}async start(e1){const i1=++this.operation;try{if(await this.client.prepareVoiceInput(),i1!==this.operation)return;}catch{}}};';
 let state={ready:false},events=[],prepared=0;
 const Service=new Function('window','CustomEvent',patchLocalServicesRenderer(fixture)+';return VoiceInputService;')({notchModels:{voice:async()=>state},dispatchEvent:event=>events.push(event)},class{constructor(type,detail){this.type=type;this.detail=detail.detail;}});
 const voice=new Service();Object.assign(voice,{operation:0,client:{async prepareVoiceInput(){prepared++;}},async stop(){this.operation++;}});
 await voice.start('composer');assert.equal(prepared,0);assert.equal(events[0].type,'notch:choose-voice');assert.equal(events[0].detail.role,'stt');assert.equal(events[0].detail.autoInstall,true);
 state={ready:true};await voice.start('composer');assert.equal(prepared,1);
 let resolve;const Pending=new Function('window','CustomEvent',patchLocalServicesRenderer(fixture)+';return VoiceInputService;')({notchModels:{voice:()=>new Promise(done=>{resolve=done;})},dispatchEvent:event=>events.push(event)},class{});const pending=new Pending();Object.assign(pending,{operation:0,client:voice.client});const start=pending.start('composer');pending.operation++;resolve({ready:false});await start;assert.equal(events.length,1);assert.equal(prepared,1);
});

test('verified Hugging Face model installation selects only complete files; checksum failures preserve local defaults',async()=>{
 const bytes=Buffer.from('model fixture'),digest=createHash('sha256').update(bytes).digest('hex');
 for(const corrupt of [false,true]){
  const {models,directory}=await fixture({legacyInstall:async()=>{},fetcher:async url=>url.includes('/api/models/')?Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'ggml-tiny.bin',size:bytes.length,lfs:{sha256:corrupt?'0'.repeat(64):digest}}]}):new Response(bytes)});
  await models.install('stt','whisper/tiny');let state;for(let retry=0;retry<100;retry++){state=await models.status();if(state.job.phase!=='downloading')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(state.job.phase,corrupt?'error':'ready');assert.equal(state.selection.stt.id,corrupt?cactusWhistle.id:'whisper/tiny');if(corrupt)assert.match(state.job.error,/checksum/);else assert.equal(JSON.parse(await fs.readFile(path.join(directory,'local-voice/models.json')))[0].revision,'a'.repeat(40));await models.shutdown();
 }
});

test('shutdown cancels a pending OpenRouter preview without returning audio',async()=>{
 let entered;const started=new Promise(resolve=>{entered=resolve});
 const {models}=await fixture({fetcher:async(url,init)=>{if(url.includes('/models?'))return Response.json({data:[{id:'test/speak',architecture:{output_modalities:['speech']},supported_voices:['first']}]});entered();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
 await models.select('tts',{provider:'openrouter',id:'test/speak',voice:'first'});const pending=models.action('preview',{text:'hello'});await started;const rejected=assert.rejects(pending);await models.shutdown();await rejected;
});

test('speech output rejects empty, odd-length and mislabeled cloud audio before playback',async()=>{
 for(const [body,type] of [[Buffer.alloc(0),'audio/pcm'],[Buffer.alloc(3),'audio/pcm'],[Buffer.from('{}'),'application/json']]){
  const {models}=await fixture({fetcher:async url=>url.includes('/models?')?Response.json({data:[{id:'test/speak',architecture:{output_modalities:['speech']},supported_voices:['first']}]}):new Response(body,{headers:{'Content-Type':type}})});
  await models.select('tts',{provider:'openrouter',id:'test/speak',voice:'first'});await assert.rejects(models.synthesize('hello'),/audio format|PCM/);await models.shutdown();
 }
});

test('cancelled Hugging Face installation preserves the current model and removes partial files',async()=>{
 let entered;const started=new Promise(resolve=>{entered=resolve});
 const {models,directory}=await fixture({legacyInstall:async()=>{},fetcher:async(url,init)=>{if(url.includes('/api/models/'))return Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'ggml-tiny.bin',size:20,lfs:{sha256:'a'.repeat(64)}}]});entered();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
 await models.install('stt','whisper/tiny');await started;await models.action('cancel');await models.shutdown();const state=await models.status();assert.equal(state.job.phase,'error');assert.equal(state.selection.stt.id,cactusWhistle.id);assert(!(await fs.readdir(path.join(directory,'local-voice'))).some(name=>name.startsWith('model-')));
});

test('already installed local speech can be inspected and selected offline',async()=>{
 const {models,requests}=await fixture();const row=await models.details('stt','whisper/base');assert.equal(row.installed,true);await models.select('stt',{provider:'local',id:'whisper/base'});assert.equal(requests.length,0);await models.shutdown();
});

test('overlapping install requests cannot start independent downloads',async()=>{
 const {models}=await fixture({legacyInstall:async()=>{},fetcher:async(url,init)=>url.includes('/api/models/')?Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'ggml-tiny.bin',size:20,lfs:{sha256:'a'.repeat(64)}}]}):new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))});
 const results=await Promise.allSettled([models.install('stt','whisper/tiny'),models.install('stt','whisper/tiny')]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.match(results.find(row=>row.status==='rejected').reason.message,/already running/);await models.shutdown();
});


test('a pre-voice prototype receives the full speech bridge in one pass, and upgrades stay idempotent',async()=>{
 const models=",voiceModels:(action,input)=>ipcRenderer.invoke('notch-models:voiceModels',action,input)";
 const legacy=",voice:()=>ipcRenderer.invoke('notch-models:voice'),voiceInstall:()=>ipcRenderer.invoke('notch-models:voiceInstall'),voiceCancel:()=>ipcRenderer.invoke('notch-models:voiceCancel')";
 const previous=modelPreload.replace(models,'').replace(legacy,'');assert(!previous.includes('voiceInstall:()=>'));
 const patched=patchModelPreload(previous);assert.equal(patchModelPreload(patched),patched);let bridge;const calls=[];
 new Function('window','require',patched)({location:{protocol:'notch-app:',search:''}},()=>({contextBridge:{exposeInMainWorld(name,value){assert.equal(name,'notchModels');bridge=value;}},ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve('catalog');}}}));
 assert.equal(await bridge.voiceModels('catalog',{role:'stt',source:'installed'}),'catalog');assert.deepEqual(calls,[['notch-models:voiceModels','catalog',{role:'stt',source:'installed'}]]);
 assert(patchModelPreload(modelPreload.replace(models,'')).includes(models.slice(1)));
});

test('Cactus Whistle details stay offline, remain first in the catalog, and close the mic picker after mount',async()=>{
 const {models,requests}=await fixture();const row=await models.details('stt',cactusWhistle.id);
 assert.equal(row.engine,'cactus');assert.equal(row.file,'whistle.cact');assert.equal(row.bytes,16919407);
 assert(requests.every(request=>!String(request.url).includes('Cactus')));
 await models.select('stt',{provider:'local',id:'whisper/base'});assert.equal(await models.transcribe(Buffer.alloc(6400)),'whisper transcript');
 assert.equal(shouldCloseVoicePicker({origin:'mic',ready:true}),true);
 assert.equal(shouldCloseVoicePicker({origin:'settings',ready:true}),false);
 assert.equal(shouldCloseVoicePicker({origin:'mic',ready:false}),false);
 assert.deepEqual(validateSpeechSelection({provider:'local',id:cactusWhistle.id}),{provider:'local',id:cactusWhistle.id,voice:''});
 await models.shutdown();
});

test('first-use Cactus Whistle install waits for the engine and then selects the model',async()=>{
 let ready=false,phase='idle',bytes=0;
 const {models}=await fixture({cactusStatus:async()=>({ready,runtimeReady:ready,phase,bytes}),cactusInstall:async()=>{phase='downloading';bytes=1024;await new Promise(resolve=>setTimeout(resolve,15));ready=true;phase='ready';bytes=18490223;}});
 assert.equal((await models.status()).ready,false);
 await models.install('stt',cactusWhistle.id);
 let state;for(let retry=0;retry<100;retry++){state=await models.status();if(state.job?.phase!=='downloading')break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(state.job.phase,'ready');assert.equal(state.selection.stt.id,cactusWhistle.id);assert.equal(state.ready,true);await models.shutdown();
});

test('composer microphone becomes a download control until the speech model is ready',()=>{
 const patched=patchLocalServicesRenderer('function ComposerVoiceTool(){return null;}');
 assert.match(patched,/Download speech model/);assert.match(patched,/notch-composer-speech-download/);
 assert.equal(patchLocalServicesRenderer(patched),patched);
 const upgraded=patchLocalServicesRenderer('let VoiceInputService=class{setConfiguration(){}async start(e1){const i1=++this.operation;try{const notchSpeech=await window.notchModels.voice();if(i1!==this.operation)return;if(!notchSpeech.ready){await this.stop(e1,false);window.dispatchEvent(new CustomEvent("notch:choose-voice",{detail:{role:"stt"}}));return;}if(await this.client.prepareVoiceInput(),i1!==this.operation)return;}catch{}}};');
 assert.match(upgraded,/autoInstall:true/);
});
