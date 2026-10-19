import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { speechWavePcm } from './speech-audio.mjs';
const whisperRepo = 'ggerganov/whisper.cpp', sherpaVersion = '1.13.8';
const runtimeName = `sherpa-onnx-v${sherpaVersion}-win-x64-shared-MD-Release`;
const runtimeHash = '3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22';
export const cactusWhistle = {
    id: 'cactus/whistle', name: 'Cactus Whistle · Recommended', engine: 'cactus', repo: 'Cactus-Compute/whistle',
    file: 'whistle.cact', bytes: 16919407, runtimeBytes: 1570816, revision: '741118687e1f008f06d1351a402a731274789790',
    engineRevision: 'd6c7d6a2e9655505e0f8e23339356dd1705900eb', description: 'Local speech · 17 MB · English, German, French, Spanish, Italian, Dutch, Polish'
};
const defaults = { stt: { provider: 'local', id: cactusWhistle.id }, tts: { provider: 'local', id: 'windows', voice: '' } };
const roleCheck = role => { if (!['stt', 'tts'].includes(role))
    throw Error('Choose speech recognition or speech output.'); };
const safeFile = name => typeof name === 'string' && name.length < 400 && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..');
const modelId = id => typeof id === 'string' && /^(?:cactus\/whistle|whisper\/[a-z0-9.-]+|piper\/vits-piper-[\w.-]+)$/.test(id);
const cactusRow = (role = 'stt') => ({ id: cactusWhistle.id, name: cactusWhistle.name, role, provider: 'local', engine: 'cactus', repo: cactusWhistle.repo, file: cactusWhistle.file, bytes: cactusWhistle.bytes, description: cactusWhistle.description });
export function validateSpeechSelection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'id', 'voice'].includes(key)) || !['local', 'openrouter'].includes(value.provider) || typeof value.id !== 'string' || value.id.length > 200 || !value.id.trim() || typeof (value.voice ?? '') !== 'string' || (value.voice ?? '').length > 200)
        throw Error('Invalid speech model selection.');
    if (value.provider === 'local' && value.id !== 'windows' && !modelId(value.id))
        throw Error('Unsupported local speech model.');
    return { provider: value.provider, id: value.id, voice: value.voice ?? '' };
}
export function speechMemoryRequired(bytes) { return Math.ceil(bytes * 2 + 256 * 1024 ** 2); }
export function createSpeechModels(directory, { run, legacyStatus, legacyInstall, legacyTranscribe, cactusStatus = async () => ({ ready: false, runtimeReady: false, phase: 'idle', bytes: 0, error: null }), cactusInstall, cactusTranscribe, cactusCancel = () => { }, systemSpeak, pcmWave, legacyCancel = () => { }, getKey = async () => process.env.OPENROUTER_API_KEY, fetcher = fetch, availableMemory = () => Math.min(os.freemem(), process.availableMemory?.() ?? Infinity), platform = process.platform, arch = process.arch } = {}) {
    const root = path.join(directory, 'local-voice'), settingsFile = path.join(root, 'selection.json'), registryFile = path.join(root, 'models.json'), runtime = path.join(root, 'sherpa-' + sherpaVersion);
    let selection = structuredClone(defaults), installed = [], job, preview, active = 0, saveQueue = Promise.resolve();
    const caches = new Map(), lifetime = new AbortController();
    const ready = (async () => {
        try {
            const value = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
            selection = { stt: validateSpeechSelection(value.stt), tts: validateSpeechSelection(value.tts) };
            if (selection.stt.id === 'windows')
                throw Error('Windows speech is output only.');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw Error('Speech preferences could not be loaded. The saved file was preserved.');
        }
        try {
            const rows = JSON.parse(await fs.readFile(registryFile, 'utf8'));
            if (!Array.isArray(rows) || rows.some(row => !modelId(row.id) || !['stt', 'tts'].includes(row.role) || row.engine !== (row.role === 'stt' ? 'whisper' : 'piper') || !safeFile(row.file) || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{40}$/.test(row.revision) || !/^\w[\w.-]*\/[\w.-]+$/.test(row.repo)))
                throw Error('Invalid speech model registry.');
            installed = rows;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw Error('Installed speech model metadata could not be loaded. Files were preserved.');
        }
    })();
    void ready.catch(() => { });
    const modelDirectory = id => path.join(root, 'models', createHash('sha256').update(id).digest('hex'));
    async function atomic(file, value) { await fs.mkdir(root, { recursive: true }); const temp = file + '.' + randomUUID() + '.tmp'; try {
        await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await fs.rename(temp, file);
    }
    finally {
        await fs.unlink(temp).catch(() => { });
    } }
    async function removeTemp(temp) { if (!path.resolve(temp).startsWith(path.resolve(root) + path.sep))
        throw Error('Speech temporary path escaped its directory.'); await fs.rm(temp, { recursive: true, force: true }); }
    async function json(url) { const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]) }); if (!response.ok)
        throw Error(`Speech catalog request failed (HTTP ${response.status}).`); return response.json(); }
    async function cached(key, load) { const old = caches.get(key); if (old && Date.now() - old.at < 300000)
        return old.value; const value = Promise.resolve().then(load); caches.set(key, { at: Date.now(), value }); try {
        return await value;
    }
    catch (error) {
        caches.delete(key);
        throw error;
    } }
    async function hf(repo) { return cached('hf:' + repo, () => json('https://huggingface.co/api/models/' + repo + '?blobs=true')); }
    async function isInstalled(row) { if (row.id === 'windows')
        return platform === 'win32'; if (row.id === cactusWhistle.id)
        return (await cactusStatus()).ready; if (row.id === 'whisper/base')
        return (await legacyStatus()).ready; const stored = installed.find(item => item.id === row.id); if (!stored)
        return false; try {
        return (await fs.stat(path.join(modelDirectory(row.id), stored.file))).size === stored.bytes;
    }
    catch {
        return false;
    } }
    async function systemVoices() { if (platform !== 'win32')
        return []; return cached('windows-voices', async () => { const script = await fs.readFile(new URL('./local-speech-voices.ps1', import.meta.url), 'utf8'); const output = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {signal:lifetime.signal}); const voices = JSON.parse(output || '[]'); return (Array.isArray(voices) ? voices : [voices]).filter(row => typeof row.name === 'string' && row.name.length < 200); }); }
    async function catalog(role, source) {
        roleCheck(role);
        await ready;
        if (!['installed', 'huggingface', 'openrouter'].includes(source))
            throw Error('Choose a speech model source.');
        let rows;
        if (source === 'installed')
            rows = role === 'stt' ? [cactusRow(role), { id: 'whisper/base', name: 'Whisper Base · Multilingual', role, provider: 'local', engine: 'whisper', bytes: 147951465 }, ...installed.filter(row => row.role === role && row.id !== 'whisper/base' && row.id !== cactusWhistle.id)] : [{ id: 'windows', name: 'Windows installed voices', role, provider: 'local', engine: 'windows', bytes: 0, voices: (await systemVoices()).map(row => row.name) }, ...installed.filter(row => row.role === role)];
        else if (source === 'openrouter')
            rows = await cached('or:' + role, async () => {
                const body = await json('https://openrouter.ai/api/v1/models?output_modalities=' + (role === 'stt' ? 'transcription' : 'speech'));
                if (!Array.isArray(body.data))
                    throw Error('Unexpected OpenRouter speech catalog.');
                return body.data.filter(row => typeof row.id === 'string' && row.id.length <= 200 && row.architecture?.output_modalities?.includes(role === 'stt' ? 'transcription' : 'speech')).map(row => ({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id, role, provider: 'openrouter', voices: Array.isArray(row.supported_voices) ? row.supported_voices.filter(value => typeof value === 'string' && value.length < 200) : [], description: 'Cloud service · provider charges apply', url: 'https://openrouter.ai/' + row.id }));
            });
        else if (role === 'stt') {
            const info = await hf(whisperRepo);
            rows = [cactusRow(role), ...(info.siblings ?? []).filter(file => /^ggml-(?:tiny|base|small|medium|large-v[123](?:-turbo)?)(?:\.en)?(?:-q[458]_[01])?\.bin$/.test(file.rfilename) && file.lfs?.sha256 && Number.isSafeInteger(file.size)).map(file => ({ id: 'whisper/' + file.rfilename.slice(5, -4), name: 'Whisper ' + file.rfilename.slice(5, -4), role, provider: 'local', engine: 'whisper', repo: whisperRepo, file: file.rfilename, bytes: file.size, description: file.rfilename.includes('.en') ? 'English only' : 'Multilingual' }))];
        }
        else {
            const list = await cached('piper-list', () => json('https://huggingface.co/api/models?author=csukuangfj&search=vits-piper-&limit=1000'));
            if (!Array.isArray(list))
                throw Error('Unexpected Hugging Face speech catalog.');
            rows = list.filter(row => /^csukuangfj\/vits-piper-[\w.-]+$/.test(row.id)).map(row => ({ id: 'piper/' + row.id.split('/')[1], name: row.id.split('/')[1].replace('vits-piper-', 'Piper '), role, provider: 'local', engine: 'piper', repo: row.id, description: 'Local speech · converted for sherpa-onnx' }));
        }
        return Promise.all(rows.map(async (row) => ({ ...row, installed: await isInstalled(row), supported: row.provider === 'openrouter' || (platform === 'win32' && arch === 'x64'), requiredMemory: row.bytes ? speechMemoryRequired(row.bytes) : undefined })));
    }
    async function resolve(role, id, provider = 'local') {
        if (typeof id !== 'string' || id.length > 200)
            throw Error('Choose a speech model from the catalog.');
        const row = (await catalog(role, provider === 'openrouter' ? 'openrouter' : 'installed')).find(row => row.id === id) ?? (provider === 'local' ? (await catalog(role, 'huggingface')).find(row => row.id === id) : undefined);
        if (!row)
            throw Error('This model is not supported for the selected speech task.');
        return row;
    }
    async function details(role, id, provider = 'local') {
        const row = await resolve(role, id, provider);
        if (row.id === cactusWhistle.id) {
            const cactus = await cactusStatus(), runtimeBytes = cactus.runtimeReady ? 0 : cactusWhistle.runtimeBytes;
            return { ...row, ...cactusWhistle, installed: cactus.ready, runtimeBytes, downloadBytes: runtimeBytes + cactusWhistle.bytes, requiredMemory: speechMemoryRequired(cactusWhistle.bytes), url: 'https://huggingface.co/' + cactusWhistle.repo };
        }
        if (row.provider === 'openrouter' || row.id === 'windows' || row.installed)
            return row;
        const repo = row.repo ?? (row.engine === 'whisper' ? whisperRepo : 'csukuangfj/' + id.slice(6)), info = await hf(repo);
        if (!/^[a-f0-9]{40}$/.test(info.sha) || !Array.isArray(info.siblings))
            throw Error('Speech model revision is unavailable.');
        const files = info.siblings.filter(file => row.engine === 'whisper' ? file.rfilename === ('ggml-' + id.slice(8) + '.bin') : /^(?:[^/]+\.onnx(?:\.json)?|tokens\.txt|espeak-ng-data\/.+|MODEL_CARD|LICENSE|README\.md)$/.test(file.rfilename));
        const modelFiles = files.filter(file => /\.(?:onnx|bin)$/.test(file.rfilename) && !file.rfilename.includes('/'));
        if (modelFiles.length !== 1 || !modelFiles[0].lfs?.sha256 || files.some(file => !safeFile(file.rfilename) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 4 * 1024 ** 3 || (!/^[a-f0-9]{64}$/.test(file.lfs?.sha256 ?? '') && !/^[a-f0-9]{40}$/.test(file.blobId ?? ''))))
            throw Error('This repository lacks verified compatible speech files.');
        if (row.engine === 'piper' && (!files.some(file => file.rfilename === 'tokens.txt') || !files.some(file => file.rfilename.startsWith('espeak-ng-data/'))))
            throw Error('This voice needs converted tokens and phonemizer data.');
        const runtimeBytes = row.engine === 'whisper' ? (await legacyStatus()).runtimeReady ? 0 : 8928640 : await fs.access(path.join(runtime, 'bin/sherpa-onnx-offline-tts.exe')).then(() => 0, () => 20494724);
        return { ...row, repo, revision: info.sha, file: modelFiles[0].rfilename, bytes: modelFiles[0].size, runtimeBytes, downloadBytes: runtimeBytes + files.reduce((sum, file) => sum + file.size, 0), files, requiredMemory: speechMemoryRequired(modelFiles[0].size), url: 'https://huggingface.co/' + repo + '/tree/' + info.sha };
    }
    function memoryCheck(row) { const free = availableMemory(); if (!Number.isFinite(free) || free < speechMemoryRequired(row.bytes))
        throw Error('Not enough free RAM for this speech model. Close another model or choose a smaller speech model.'); }
    async function fileDownload(url, file, spec, signal, onProgress = () => { }) {
        const response = await fetcher(url, { signal });
        if (!response.ok || !response.body)
            throw Error(`Speech download failed (HTTP ${response.status}).`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const handle = await fs.open(file, 'wx', 0o600), large = !!spec.sha256, hash = createHash(large ? 'sha256' : 'sha1');
        if (!large)
            hash.update(`blob ${spec.size}\0`);
        let count = 0;
        try {
            for await (const chunk of response.body) {
                signal.throwIfAborted();
                count += chunk.length;
                if (count > spec.size)
                    throw Error('Speech download is larger than expected.');
                hash.update(chunk);
                await handle.writeFile(chunk);
                onProgress(chunk.length);
            }
        }
        finally {
            await handle.close();
        }
        if (count !== spec.size || hash.digest('hex') !== (large ? spec.sha256 : spec.blobId))
            throw Error('Speech download checksum mismatch.');
    }
    async function ensureRuntime(signal, onProgress) {
        const executable = path.join(runtime, 'bin/sherpa-onnx-offline-tts.exe');
        try {
            await fs.access(executable);
            return executable;
        }
        catch { }
        const temp = await fs.mkdtemp(path.join(root, 'runtime-'));
        try {
            const archive = path.join(temp, 'runtime.tar.bz2');
            await fileDownload(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${sherpaVersion}/${runtimeName}.tar.bz2`, archive, { sha256: runtimeHash, size: 20494724 }, signal, onProgress);
            const entries = (await run('tar.exe', ['-tf', archive], { signal })).trim().split(/\r?\n/);
            if (entries.some(name => !safeFile(name.replace(/\/$/, '')) || !name.startsWith(runtimeName + '/')))
                throw Error('Unexpected speech runtime archive paths.');
            await run('tar.exe', ['-xf', archive, '-C', temp], { signal });
            await fs.copyFile(new URL('./sherpa-onnx-LICENSE.txt', import.meta.url), path.join(temp, runtimeName, 'LICENSE'));
            await fs.rename(path.join(temp, runtimeName), runtime);
            await run(executable, ['--help'], { signal });
            return executable;
        }
        finally {
            await removeTemp(temp);
        }
    }
    async function install(role, id) {
        await ready;
        roleCheck(role);
        if (job?.phase === 'downloading')
            throw Error('A speech download is already running.');
        if (platform !== 'win32' || arch !== 'x64')
            throw Error('Local speech model downloads currently support Windows x64.');
        const row = await details(role, id);
        if (await isInstalled(row)) {
            await select(role, { provider: 'local', id });
            return status();
        }
        await fs.mkdir(root, { recursive: true });
        if (job?.phase === 'downloading')
            throw Error('A speech download is already running.');
        const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal]), current = { phase: 'downloading', bytes: 0, total: row.downloadBytes, id, controller, error: null };
        job = current;
        current.promise = (async () => {
            const temp = await fs.mkdtemp(path.join(root, 'model-'));
            try {
                if (id === cactusWhistle.id) {
                    if (typeof cactusInstall !== 'function')
                        throw Error('Cactus speech setup is unavailable.');
                    await cactusInstall(false);
                    let state = await cactusStatus();
                    while (state.phase === 'downloading') {
                        signal.throwIfAborted();
                        await new Promise(resolve => setTimeout(resolve, 200));
                        state = await cactusStatus();
                        current.bytes = state.bytes;
                    }
                    if (!state.ready)
                        throw Error(state.error || 'Whistle setup did not finish.');
                    await select(role, { provider: 'local', id });
                    current.phase = 'ready';
                    return;
                }
                if (id === 'whisper/base') {
                    await legacyInstall(false);
                    let state = await legacyStatus();
                    while (state.phase === 'downloading') {
                        signal.throwIfAborted();
                        await new Promise(resolve => setTimeout(resolve, 200));
                        state = await legacyStatus();
                        current.bytes = state.bytes;
                    }
                    if (!state.ready)
                        throw Error(state.error || 'Whisper setup did not finish.');
                    await select(role, { provider: 'local', id });
                    current.phase = 'ready';
                    return;
                }
                if (row.engine === 'whisper')
                    await legacyInstall(true);
                else
                    await ensureRuntime(signal, bytes => { current.bytes += bytes; });
                // The legacy engine setup finishes before alternate Whisper files are used.
                if (row.engine === 'whisper') {
                    let state = await legacyStatus();
                    while (state.phase === 'downloading') {
                        signal.throwIfAborted();
                        await new Promise(resolve => setTimeout(resolve, 200));
                        state = await legacyStatus();
                    }
                    if (!state.runtimeReady)
                        throw Error(state.error || 'Whisper runtime setup did not finish.');
                }
                current.bytes = row.runtimeBytes;
                let next = 0;
                const workers = Array.from({ length: 6 }, async () => { try {
                    while (next < row.files.length) {
                        const file = row.files[next++];
                        signal.throwIfAborted();
                        const url = 'https://huggingface.co/' + row.repo + '/resolve/' + row.revision + '/' + file.rfilename.split('/').map(encodeURIComponent).join('/');
                        await fileDownload(url, path.join(temp, file.rfilename), { size: file.size, sha256: file.lfs?.sha256, blobId: file.blobId }, signal, bytes => { current.bytes += bytes; });
                    }
                }
                catch (error) {
                    controller.abort(error);
                    throw error;
                } });
                const results = await Promise.allSettled(workers), failed = results.find(result => result.status === 'rejected');
                if (failed)
                    throw failed.reason;
                memoryCheck(row);
                const target = modelDirectory(id);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.rename(temp, target);
                const record = { id, role, provider: 'local', engine: row.engine, name: row.name, repo: row.repo, revision: row.revision, file: row.file, bytes: row.bytes };
                const updated = [...installed.filter(item => item.id !== id), record];
                await atomic(registryFile, updated);
                installed = updated;
                await select(role, { provider: 'local', id });
                current.phase = 'ready';
            }
            catch (error) {
                current.phase = 'error';
                current.error = signal.aborted ? 'Speech download cancelled or failed. ' + (controller.signal.reason?.message ?? '') : error.message;
            }
            finally {
                await removeTemp(temp).catch(error => { current.phase = 'error'; current.error = error.message; });
            }
        })();
        return status();
    }
    async function status() { await ready; const legacy = await legacyStatus(), cactus = await cactusStatus(), stt = await resolve('stt', selection.stt.id, selection.stt.provider).catch(() => null), tts = await resolve('tts', selection.tts.id, selection.tts.provider).catch(() => null); return { selection: structuredClone(selection), stt: stt ? { ...stt, ready: stt.provider === 'openrouter' ? !!await getKey('openrouter') : await isInstalled(stt) } : null, tts: tts ? { ...tts, ready: tts.provider === 'openrouter' ? !!await getKey('openrouter') : await isInstalled(tts) } : null, connected: !!await getKey('openrouter'), job: job ? { phase: job.phase, bytes: job.bytes, total: job.total, id: job.id, error: job.error } : null, ready: selection.stt.provider === 'local' && selection.stt.id === cactusWhistle.id ? cactus.ready : selection.stt.provider === 'local' && selection.stt.id === 'whisper/base' ? legacy.ready : !!stt && (stt.provider === 'openrouter' ? !!await getKey('openrouter') : await isInstalled(stt)) }; }
    async function select(role, value) { roleCheck(role); await ready; const chosen = validateSpeechSelection(value); if (active)
        throw Error('Finish speech processing before switching speech models.'); const row = await resolve(role, chosen.id, chosen.provider); if (row.provider === 'openrouter') {
        if (!await getKey('openrouter'))
            throw Error('Connect OpenRouter in Models settings first.');
        if (role === 'tts' && (!chosen.voice || row.voices?.length && !row.voices.includes(chosen.voice)))
            throw Error('Choose a supported voice for this speech model.');
    }
    else {
        if (!await isInstalled(row))
            throw Error('Download this speech model first.');
        if (row.bytes)
            memoryCheck(row);
        if (row.id === 'windows' && chosen.voice && !(await systemVoices()).some(item => item.name === chosen.voice))
            throw Error('Choose an installed Windows voice.');
    } saveQueue = saveQueue.catch(() => { }).then(async () => { const next = { ...selection, [role]: chosen }; await atomic(settingsFile, next); selection = next; }); await saveQueue; return status(); }
    async function ensureReady(role = 'stt', chosen) { await ready; chosen ??= selection[role]; const row = await resolve(role, chosen.id, chosen.provider); if (row.provider === 'openrouter') {
        if (!await getKey('openrouter'))
            throw Error('Reconnect OpenRouter or choose local speech in Voice settings.');
    }
    else if (!await isInstalled(row))
        throw Error('Choose and download a speech model in Settings → Voice.'); return row; }
    async function remote(role, body, signal) { const key = await getKey('openrouter'); if (!key)
        throw Error('Connect OpenRouter or choose local speech.'); const response = await fetcher('https://openrouter.ai/api/v1/audio/' + (role === 'stt' ? 'transcriptions' : 'speech'), { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), lifetime.signal, AbortSignal.timeout(120000)]), body: JSON.stringify(body) }); if (!response.ok)
        throw Error(`OpenRouter ${role === 'stt' ? 'transcription' : 'speech'} failed (HTTP ${response.status}). Check the model, voice and provider credit balance.`); return response; }
    async function transcribe(pcm, { signal, hotwords = [], chosen } = {}) { await ready; chosen ??= structuredClone(selection.stt); const row = await ensureReady('stt', chosen); active++; try {
        if (row.provider === 'openrouter') {
            const response = await remote('stt', { model: row.id, input_audio: { data: pcmWave(pcm).toString('base64'), format: 'wav' } }, signal);
            const body = await response.json();
            if (typeof body.text !== 'string' || body.text.length > 200000)
                throw Error('Invalid transcription response.');
            return body.text;
        }
        memoryCheck(row);
        if (row.engine === 'cactus') {
            if (typeof cactusTranscribe !== 'function')
                throw Error('Cactus speech is unavailable.');
            return await cactusTranscribe(pcm, { signal, hotwords });
        }
        return await legacyTranscribe(pcm, { signal, hotwords, model: row.id === 'whisper/base' ? undefined : path.join(modelDirectory(row.id), (installed.find(item => item.id === row.id)).file) });
    }
    finally {
        active--;
    } }
    async function synthesize(text, { signal, rate = 'normal' } = {}) {
        await ready;
        if (typeof text !== 'string' || text.length > 6000)
            throw Error('Speech text must be at most 6000 characters.');
        const chosen = structuredClone(selection.tts), row = await ensureReady('tts', chosen);
        active++;
        try {
            if (row.provider === 'openrouter') {
                const response = await remote('tts', { model: row.id, input: text, voice: chosen.voice, response_format: 'pcm' }, signal), chunks = [];
                if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/pcm')
                    throw Error('The speech provider returned an unsupported audio format.');
                let size = 0;
                for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > 32 * 1024 ** 2)
                        throw Error('Speech response is too large.');
                    chunks.push(chunk);
                }
                const pcm = Buffer.concat(chunks);
                if (!pcm.length || pcm.length % 2)
                    throw Error('Invalid PCM speech response.');
                return pcm;
            }
            if (row.id === 'windows')
                return await systemSpeak(text, { signal, rate, voice: chosen.voice });
            memoryCheck(row);
            const record = installed.find(item => item.id === row.id), folder = modelDirectory(row.id), temp = await fs.mkdtemp(path.join(root, 'speech-'));
            try {
                const output = path.join(temp, 'output.wav');
                await run(path.join(runtime, 'bin/sherpa-onnx-offline-tts.exe'), ['--vits-model=' + path.join(folder, record.file), '--vits-tokens=' + path.join(folder, 'tokens.txt'), '--vits-data-dir=' + path.join(folder, 'espeak-ng-data'), '--num-threads=2', '--speed=' + (rate === 'fast' ? '1.2' : rate === 'slow' ? '0.8' : '1'), '--output-filename=' + output, '--print-args=false', text], { signal, timeout: 120000 });
                return speechWavePcm(await fs.readFile(output));
            }
            finally {
                await removeTemp(temp);
            }
        }
        finally {
            active--;
        }
    }
    return { status, catalog, details, install, select, ensureReady, transcribe, synthesize, snapshot: () => structuredClone(selection), async action(action, input = {}) { if (!input || typeof input !== 'object' || Array.isArray(input))
            throw Error('Invalid speech request.'); if (action === 'catalog')
            return catalog(input.role, input.source); if (action === 'details') {
            const row = await details(input.role, input.id, input.provider);
            const { files, ...publicRow } = row;
            return publicRow;
        } if (action === 'install')
            return install(input.role, input.id); if (action === 'select') {
            if (input.selection?.provider === 'openrouter' && input.cloudConfirmed !== true)
                throw Error('Confirm cloud speech before selecting an OpenRouter model.');
            return select(input.role, input.selection);
        } if (action === 'cancel') {
            job?.controller.abort();
            legacyCancel();
            cactusCancel();
            return status();
        } if (action === 'cancelPreview') {
            preview?.abort();
            return true;
        } if (action === 'preview') {
            if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 240)
                throw Error('Preview text must be 1–240 characters.');
            preview?.abort();
            const current = new AbortController();
            preview = current;
            try {
                current.promise = synthesize(input.text, { signal: current.signal });
                return { audio: (await current.promise).toString('base64'), sampleRate: 24000 };
            }
            finally {
                if (preview === current)
                    preview = undefined;
            }
        } throw Error('Unsupported speech action.'); }, async shutdown() { lifetime.abort(); preview?.abort(); job?.controller.abort(); await Promise.allSettled([job?.promise, preview?.promise]); } };
}
