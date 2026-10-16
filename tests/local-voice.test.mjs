import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalVoice, pcmWave, wavePcm } from '../src/local-voice.mjs';
import { createLocalLiveVoice } from '../src/local-live-voice.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Windows speech reads Unicode task replies as UTF-8 from its real stdin boundary',{skip:process.platform!=='win32'},async()=>{
  const script=await fs.readFile(new URL('../src/local-speech.ps1',import.meta.url),'utf8');
  const read=script.slice(0,script.indexOf('$speaker ='))+'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n[Console]::Write($request.text)';
  const text='café — 日本語 ไทย 中文';
  const actual=await new Promise((resolve,reject)=>{
    const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',read],{windowsHide:true});let output='',error='';
    child.stdout.setEncoding('utf8').on('data',value=>{output+=value});child.stderr.on('data',value=>{error+=value});child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(Error(error)));child.stdin.end(JSON.stringify({text}));
  });
  assert.equal(actual,text);
});

test('local dictation flushes once, rejects malformed frames and cancels without committing speech', async () => {
  const events = [], calls = [];
  const voice = createLocalVoice('unused', { transcriber: async pcm => { calls.push(pcm.length); return 'local transcript'; } });
  const id = await voice.startRecognition(event => events.push(event), {});
  assert.equal(voice.sendRecognition(id, new Uint8Array(3)), false);
  assert.equal(voice.sendRecognition(id, new Uint8Array(64002)), false);
  assert.equal(voice.sendRecognition(id, Buffer.alloc(6400)), true);
  await voice.stopRecognition(id, true);
  assert.deepEqual(calls, [6400]); assert.equal(events[0].text, 'local transcript ');
  assert.equal(events[1].status, 'closed'); assert.equal(voice.sendRecognition(id, Buffer.alloc(6400)), false);
  const cancelled = await voice.startRecognition(event => events.push(event), {});
  voice.sendRecognition(cancelled, Buffer.alloc(6400)); await voice.stopRecognition(cancelled, false);
  assert.deepEqual(calls, [6400]); await voice.shutdown();
});

test('PCM parser checks format and bounds, including extra RIFF metadata', () => {
  const pcm = Buffer.alloc(24000), wave = pcmWave(pcm, 24000);
  assert.deepEqual(wavePcm(wave), pcm);
  assert.throws(() => wavePcm(pcmWave(pcm, 16000)), /24 kHz/);
  assert.throws(() => wavePcm(wave.subarray(0, 60)), /Truncated/);
  const metadata = Buffer.alloc(12); metadata.write('JUNK'); metadata.writeUInt32LE(4, 4);
  const extra = Buffer.concat([wave.subarray(0, 12), metadata, wave.subarray(12)]);
  assert.deepEqual(wavePcm(extra), pcm);
});

test('quitting aborts in-flight local transcription and drains queued work',async()=>{
  let started;const entered=new Promise(resolve=>{started=resolve});const events=[];
  const voice=createLocalVoice('unused',{transcriber:async(_pcm,{signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return 'must not commit';}});
  const id=await voice.startRecognition(event=>events.push(event),{});
  for(let i=0;i<15;i++)voice.sendRecognition(id,Buffer.alloc(32000));
  await entered;await voice.shutdown();assert.equal(events.some(event=>event.type==='result'),false);await assert.rejects(voice.startRecognition(()=>{},{}),/aborted/);
});

test('Live Voice uses local transcription, existing task handoffs and local speech; stop cancels pending work', async () => {
  const events = [], spoken = []; let turns = 0;
  const voice = { transcribe: async () => { turns++; return 'Read my project'; }, synthesize: async text => { spoken.push(text); return Buffer.alloc(2400); } };
  const live = createLocalLiveVoice(voice, { voiceSessionId: 'local-voice', chatSessionId: 'task' }, event => events.push(event));
  const frame = Buffer.alloc(3200); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(2000, i);
  for (let i = 0; i < 5; i++) live.sendAudio(frame);
  for (let i = 0; i < 9; i++) live.sendAudio(Buffer.alloc(3200));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turns, 1); const handoff = events.find(event => event.type === 'toolCall');
  assert.equal(handoff.name, 'SpawnBackendAgent'); assert.equal(JSON.parse(handoff.arguments).request, 'Read my project');
  assert.equal(live.completeToolCall({ callId: handoff.callId, output: JSON.stringify({ accepted: true }) }), true);
  assert.equal(live.sendContext({ text: '[COMPLETE]\nResult\n' + JSON.stringify({ handoffId: handoff.callId, status: 'completed', result: 'Read the project locally.' }) }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spoken, ['Read the project locally.']); assert.ok(events.some(event => event.type === 'audio'));
  live.stop(); assert.equal(live.sendAudio(frame), false); assert.equal(live.sendContext({ text: '[COMPLETE]\n{}' }), false);
  assert.equal(events.at(-1).phase, 'idle');
});

test('muting during synthesis prevents late audio and keeps a pending turn from being replaced',async()=>{
  let finishSpeech;const events=[];let transcriptions=0;
  const voice={transcribe:async()=>{transcriptions++;return 'hello'},synthesize:()=>new Promise(resolve=>{finishSpeech=resolve})};
  const live=createLocalLiveVoice(voice,{voiceSessionId:'mute-test',chatSessionId:'task'},event=>events.push(event));
  const speech=Buffer.alloc(3200);for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(2000,i);
  const utterance=()=>{for(let i=0;i<5;i++)live.sendAudio(speech);for(let i=0;i<9;i++)live.sendAudio(Buffer.alloc(3200));};
  utterance();await new Promise(resolve=>setImmediate(resolve));const call=events.find(event=>event.type==='toolCall');
  live.sendContext({text:'[COMPLETE]\n'+JSON.stringify({handoffId:call.callId,result:'response'})});await new Promise(resolve=>setImmediate(resolve));
  live.setPlaybackEnabled(false);utterance();assert.equal(transcriptions,1);finishSpeech(Buffer.alloc(2400));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.some(event=>event.type==='audio'),false);assert.equal(events.at(-1).phase,'listening');live.stop();
});
