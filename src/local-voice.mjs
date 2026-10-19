import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createSpeechModels } from './speech-models.mjs';

const release = 'b5454'; // whisper.cpp v1.9.5 official CPU build
const runtimeHash = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
const modelHash = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin';
const cactusRuntimeHash = '0d4bc1da8c51f5600f5c4f4bb4a92e0abe142fae7b69e695ccab93e6745c883d';
const cactusRuntimeSize = 1570816;
const cactusRuntimeUrl = 'https://huggingface.co/Cactus-Compute/needle3/resolve/d6c7d6a2e9655505e0f8e23339356dd1705900eb/windows-x86_64/needle.exe';
const cactusModelHash = 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb';
const cactusModelSize = 16919407;
const cactusModelUrl = 'https://huggingface.co/Cactus-Compute/whistle/resolve/741118687e1f008f06d1351a402a731274789790/whistle.cact';
const cactusEnv = env => ({ ...env, NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' });
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

export function parseNeedleTranscript(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return '';
  const start = text.lastIndexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const body = JSON.parse(text.slice(start, end + 1));
      const value = typeof body.text === 'string' ? body.text : typeof body.audio_text === 'string' ? body.audio_text : null;
      if (value !== null) {
        if (value.length > 200000) throw new Error('Invalid transcription response.');
        return value.trim();
      }
    } catch (error) {
      if (error.message === 'Invalid transcription response.') throw error;
    }
  }
  if (text.length > 200000) throw new Error('Invalid transcription response.');
  return text;
}

function run(executable, args, { signal, input, timeout = 180000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', stdout = ''; child.stdout.on('data', value => { stdout = (stdout + value).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Local speech processing timed out.')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(code===3221225781?'Local speech needs the Microsoft Visual C++ x64 runtime. Install it from https://aka.ms/vc14/vc_redist.x64.exe, then retry setup.':`Local speech process failed (${code}): ${stderr}`)); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export function pcmWave(pcm, sampleRate = 16000) {
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
  return wave;
}

export function wavePcm(wave) {
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid local speech audio.');
  let valid = false;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const size = wave.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wave.length) throw new Error('Truncated local speech audio.');
    const kind = wave.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') valid = size >= 16 && wave.readUInt16LE(start) === 1 && wave.readUInt16LE(start + 2) === 1 && wave.readUInt32LE(start + 4) === 24000 && wave.readUInt16LE(start + 14) === 16;
    if (kind === 'data') { if (!valid || size % 2) throw new Error('Local speech must be mono PCM16 at 24 kHz.'); return wave.subarray(start, start + size); }
    offset = start + size + (size % 2);
  }
  throw new Error('Local speech audio has no PCM data.');
}

async function download(url, destination, expected, limit, signal, progress) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Local voice download failed: HTTP ${response.status}.`);
  const file = await fs.open(destination, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const value of response.body) {
      signal.throwIfAborted(); bytes += value.length;
      if (bytes > limit) throw new Error('Local voice download exceeds its expected size.');
      hash.update(value); await file.writeFile(value); progress(bytes);
    }
  } finally { await file.close(); }
  if (hash.digest('hex') !== expected) throw new Error('Local voice download checksum mismatch.');
}

export function createLocalVoice(directory, { transcriber, synthesizer, getKey, fetcher, availableMemory } = {}) {
  const runtime = path.join(directory, 'local-voice', release), executable = path.join(runtime, 'whisper-cli.exe'), model = path.join(runtime, 'ggml-base.bin');
  const cactusRoot = path.join(directory, 'local-voice', 'cactus-needle'), cactusExecutable = path.join(cactusRoot, 'needle.exe'), cactusModel = path.join(cactusRoot, 'whistle.cact');
  const sessions = new Map(); let installing, installController, installState = { phase: 'idle', bytes: 0, error: null };
  let cactusInstalling, cactusController, cactusState = { phase: 'idle', bytes: 0, error: null };
  const controller = new AbortController();
  async function legacyStatus() {
    let ready = false, runtimeReady = false;
    try { runtimeReady = (await fs.stat(executable)).isFile(); } catch {}
    try { ready = (await fs.stat(executable)).isFile() && (await fs.stat(model)).size === 147951465; } catch {}
    return { ...installState, ready, runtimeReady, supported: process.platform === 'win32' && process.arch === 'x64', engine: 'Whisper base (multilingual, CPU)', downloadBytes: 156880105, playback: 'Windows installed voice' };
  }
  async function cactusStatus() {
    let ready = false, runtimeReady = false;
    try { runtimeReady = (await fs.stat(cactusExecutable)).isFile() && (await fs.stat(cactusExecutable)).size === cactusRuntimeSize; } catch {}
    try { ready = runtimeReady && (await fs.stat(cactusModel)).size === cactusModelSize; } catch {}
    return { ...cactusState, ready, runtimeReady, supported: process.platform === 'win32' && process.arch === 'x64', engine: 'Cactus Whistle (CPU)', downloadBytes: cactusRuntimeSize + cactusModelSize };
  }
  async function cactusInstall(runtimeOnly = false) {
    if (typeof runtimeOnly !== 'boolean') throw Error('Invalid speech setup request.');
    if (cactusInstalling) return cactusStatus();
    const existing = await cactusStatus();
    if (existing.ready || runtimeOnly && existing.runtimeReady) return cactusStatus();
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Automatic local voice setup currently supports Windows x64.');
    cactusController = new AbortController(); const signal = AbortSignal.any([controller.signal, cactusController.signal]);
    cactusState = { phase: 'downloading', bytes: 0, error: null };
    cactusInstalling = (async () => {
      const parent = path.dirname(cactusRoot); await fs.mkdir(parent, { recursive: true });
      const temporary = await fs.mkdtemp(path.join(parent, 'cactus-'));
      try {
        const pendingRuntime = path.join(temporary, 'needle.exe'), pendingModel = path.join(temporary, 'whistle.cact');
        if (!existing.runtimeReady) {
          await download(cactusRuntimeUrl, pendingRuntime, cactusRuntimeHash, cactusRuntimeSize, signal, bytes => { cactusState.bytes = bytes; });
          try {
            await run(pendingRuntime, ['--help'], { signal, timeout: 15000, env: cactusEnv(process.env) });
          } catch (error) {
            if (/3221225781|Visual C\+\+/.test(error.message)) throw error;
            if (!/model|audio|whistle|usage|help/i.test(error.message)) throw error;
          }
        }
        if (!runtimeOnly) await download(cactusModelUrl, pendingModel, cactusModelHash, cactusModelSize, signal, bytes => { cactusState.bytes = (existing.runtimeReady ? 0 : cactusRuntimeSize) + bytes; });
        await fs.mkdir(cactusRoot, { recursive: true });
        signal.throwIfAborted();
        if (!existing.runtimeReady) await fs.rename(pendingRuntime, cactusExecutable);
        if (!runtimeOnly) await fs.rename(pendingModel, cactusModel);
        await fs.copyFile(fileURLToPath(new URL('./local-voice-LICENSES.txt', import.meta.url)), path.join(cactusRoot, 'LICENSES.txt'));
        await fs.writeFile(path.join(cactusRoot, 'notch-runtime.json'), JSON.stringify({ engine: 'cactus-needle', cactusRuntimeHash, cactusModelHash, cactusRuntimeUrl, cactusModelUrl }));
        cactusState = { phase: 'ready', bytes: (existing.runtimeReady ? 0 : cactusRuntimeSize) + (runtimeOnly ? 0 : cactusModelSize), error: null };
      } catch (error) { cactusState = { ...cactusState, phase: 'error', error: signal.aborted ? 'Local voice setup cancelled.' : error.message }; }
      finally { if (!path.resolve(temporary).startsWith(path.resolve(parent) + path.sep)) throw Error('Invalid speech setup directory.'); await fs.rm(temporary, { recursive: true, force: true }); cactusInstalling = undefined; }
    })();
    return cactusStatus();
  }
  async function cactusTranscribe(pcm, { signal } = {}) {
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    signal.throwIfAborted();
    if (pcm.length < 6400) return '';
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-whistle-'));
    try {
      const input = path.join(temporary, 'input.wav');
      await fs.writeFile(input, pcmWave(pcm), { mode: 0o600 });
      const stdout = await run(cactusExecutable, ['--model', cactusModel, '--audio', input], { signal, env: cactusEnv(process.env) });
      return parseNeedleTranscript(stdout);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async function install(runtimeOnly = false) {
    if (typeof runtimeOnly !== 'boolean') throw Error('Invalid speech setup request.');
    if (installing) return legacyStatus();
    const existing = await legacyStatus();
    if (existing.ready || runtimeOnly && existing.runtimeReady) return legacyStatus();
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Automatic local voice setup currently supports Windows x64.');
    installController = new AbortController(); const signal = AbortSignal.any([controller.signal, installController.signal]);
    installState = { phase: 'downloading', bytes: 0, error: null };
    installing = (async () => {
      const parent = path.dirname(runtime); await fs.mkdir(parent, { recursive: true });
      const temporary = await fs.mkdtemp(path.join(parent, 'install-'));
      try {
        const archive = path.join(temporary, 'runtime.zip'), unpacked = path.join(temporary, 'files');
        let binaries = runtime;
        if (!existing.runtimeReady) {
          await download(`https://github.com/ggml-org/whisper.cpp/releases/download/${release}/whisper-bin-x64.zip`, archive, runtimeHash, 10000000, signal, bytes => { installState.bytes = bytes; });
          await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:NOTCH_VOICE_ARCHIVE -DestinationPath $env:NOTCH_VOICE_DESTINATION'], { signal, env: { ...process.env, NOTCH_VOICE_ARCHIVE: archive, NOTCH_VOICE_DESTINATION: unpacked } });
          const entries = await fs.readdir(unpacked, { recursive: true });
          const cli = entries.filter(name => path.basename(name) === 'whisper-cli.exe');
          if (cli.length !== 1) throw new Error('The official speech runtime has an unexpected layout.');
          binaries = path.dirname(path.join(unpacked, cli[0]));
        }
        await run(path.join(binaries,'whisper-cli.exe'),['--help'],{signal,timeout:15000});
        if (!runtimeOnly) {
          const pendingModel = path.join(temporary, 'ggml-base.bin');
          await download(modelUrl, pendingModel, modelHash, 147951465, signal, bytes => { installState.bytes = (existing.runtimeReady ? 0 : 8928640) + bytes; });
          await fs.rename(pendingModel,path.join(binaries,'ggml-base.bin'));
        }
        await fs.writeFile(path.join(binaries, 'notch-runtime.json'), JSON.stringify({ release, runtimeHash, modelHash }));
        await fs.copyFile(fileURLToPath(new URL('./local-voice-LICENSES.txt',import.meta.url)),path.join(binaries,'LICENSES.txt'));
        signal.throwIfAborted();
        // Failed downloads never replace the last usable runtime.
        if (!existing.runtimeReady) await fs.rename(binaries, runtime);
        installState = { phase: 'ready', bytes: (existing.runtimeReady ? 0 : 8928640) + (runtimeOnly ? 0 : 147951465), error: null };
      } catch (error) { installState = { ...installState, phase: 'error', error: signal.aborted ? 'Local voice setup cancelled.' : error.message }; }
      finally { if(!path.resolve(temporary).startsWith(path.resolve(parent)+path.sep))throw Error('Invalid speech setup directory.');await fs.rm(temporary, { recursive: true, force: true }); installing = undefined; }
    })();
    return legacyStatus();
  }
  async function ensureReady() {
    controller.signal.throwIfAborted();
    if (transcriber) return;
    await models.ensureReady('stt');
  }
  async function localTranscribe(pcm, { signal, hotwords = [], model: selectedModel } = {}) {
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    signal?.throwIfAborted();
    if (pcm.length < 6400) return '';
    if (transcriber) return transcriber(pcm, { signal });
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-speech-'));
    try {
      const input = path.join(temporary, 'input.wav'), output = path.join(temporary, 'transcript');
      await fs.writeFile(input, pcmWave(pcm), { mode: 0o600 });
      await run(executable, ['-m', selectedModel || model, '-f', input, '-l', 'auto', '-t', String(Math.min(4, os.availableParallelism())), '-ng', '-nt', '-np', '-otxt', '-of', output,
        ...(hotwords.length ? ['--prompt', hotwords.filter(value => typeof value === 'string').join(', ').slice(0, 1000)] : [])], { signal });
      return (await fs.readFile(output + '.txt', 'utf8')).trim();
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async function systemSpeak(text, { signal, rate = 'normal', voice = '' } = {}) {
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (synthesizer) return synthesizer(text, { signal, rate });
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-speech-'));
    try {
      const file = path.join(temporary, 'speech.wav');
      const script = await fs.readFile(fileURLToPath(new URL('./local-speech.ps1', import.meta.url)), 'utf8');
      await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        signal, input: JSON.stringify({ file, text: text.slice(0, 6000), voice, rate: rate === 'fast' ? 2 : rate === 'slow' ? -2 : 0 }),
      });
      return wavePcm(await fs.readFile(file));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const models=createSpeechModels(directory,{run,legacyStatus,legacyInstall:install,legacyTranscribe:localTranscribe,cactusStatus,cactusInstall,cactusTranscribe,cactusCancel:()=>cactusController?.abort(),systemSpeak,pcmWave,legacyCancel:()=>{installController?.abort();cactusController?.abort();},getKey,fetcher,availableMemory});
  const status=async()=>({...await legacyStatus(),...await models.status()});
  async function transcribe(pcm, options={}) {
    const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]);
    if(transcriber)return transcriber(pcm,{...options,signal});
    if(pcm.length<6400)return '';
    return models.transcribe(pcm,{...options,signal});
  }
  async function synthesize(text,options={}) {
    const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]);
    if(synthesizer)return synthesizer(text,{...options,signal});
    return models.synthesize(text,{...options,signal});
  }
  function audioBytes(audio) {
    if (!(audio instanceof Uint8Array) || audio.byteLength > 64000 || audio.byteLength % 2) return null;
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  function startRecognition(emit, options = {}) {
    const id = randomUUID(), abort = new AbortController();
    for (const current of sessions.values()) { current.abort.abort(); current.emit({type:'status',sessionId:current.id,status:'closed'}); }
    sessions.clear();
    const session = { id, abort, chunks: [], bytes: 0, pending: 0, queue: Promise.resolve(), emit, hotwords: options.hotwords || [], chosen:models.snapshot().stt, closed: false };
    sessions.set(id, session); return id;
  }
  function flushRecognition(session) {
    const pcm = Buffer.concat(session.chunks); session.chunks = []; session.bytes = 0;
    if (++session.pending > 4) return Promise.reject(new Error('Local transcription is falling behind. Stop recording and try a shorter recording.'));
    session.queue = session.queue.then(async () => {
      const text = await transcribe(pcm, { signal: session.abort.signal, hotwords: session.hotwords, chosen:session.chosen });
      if (text && !session.abort.signal.aborted) session.emit({ type: 'result', sessionId: session.id, text: text + ' ', isFinal: true });
    }).finally(() => { session.pending--; });
    session.queue.catch(() => {}); return session.queue;
  }
  return {
    status, install, ensureReady, transcribe, synthesize, models: (action,input)=>models.action(action,input),
    cancelInstall() { installController?.abort(); cactusController?.abort(); return status(); },
    async startRecognition(emit, options) { await ensureReady(); return startRecognition(emit, options); },
    sendRecognition(id, audio) {
      const session = sessions.get(id), bytes = audioBytes(audio);
      if (!session || session.closed || !bytes) return false;
      session.chunks.push(Buffer.from(bytes)); session.bytes += bytes.length;
      if (session.bytes >= 16000 * 2 * 15) flushRecognition(session).catch(error => { if(session.closed||session.abort.signal.aborted)return; session.closed=true;session.abort.abort(); session.emit({ type: 'error', sessionId: id, code: 'recognitionFailed', message: error.message }); sessions.delete(id); });
      return true;
    },
    async stopRecognition(id, complete) {
      const session = sessions.get(id); if (!session) return;
      session.closed = true;
      try { if (complete) await flushRecognition(session); else { session.abort.abort(); await session.queue.catch(() => {}); } }
      finally { sessions.delete(id); session.abort.abort(); session.emit({ type: 'status', sessionId: id, status: 'closed' }); }
    },
    async shutdown() { controller.abort(); await models.shutdown(); const pending=[...sessions.values()]; for (const session of pending) session.abort.abort(); sessions.clear(); await Promise.allSettled([...pending.map(session=>session.queue),installing,cactusInstalling]); },
  };
}
