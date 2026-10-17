import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile, writeFile, rename, unlink, realpath, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { LocalHardware } from './local-models.js';
import { withLocalInference } from '../concurrency/local-inference.js';
import { acquireLease } from '../concurrency/lease.js';

const exec = promisify(execFile);
export const COLIBRI_VERSION = '2.0.0';
export const COLIBRI_URL = 'http://127.0.0.1:11437/v1';
const root = () => path.join(os.homedir(), '.notch', 'runtimes', 'colibri');
const runtime = () => path.join(root(), `v${COLIBRI_VERSION}`);
const setupFile = () => path.join(root(), 'state', 'setup.json');
const receiptFile = () => path.join(root(), 'verified-model.json');
const transactionFile = () => path.join(root(), 'pending-model.json');
const assets: Record<string, [string, string]> = {
  'win32-x64': ['windows-x86_64.zip', 'fdb8ea2fad7dcfe44d9d37bfb3e444f1299207f268ab499719f98bd772397d79'],
  'linux-x64': ['linux-x86_64.tar.gz', 'aef2c1e7d5cbad3d27cc90d8432775acdc315ec51f6d7a67a2f13a936f9978ce'],
  'darwin-arm64': ['macos-arm64.tar.gz', 'faa0841b20b7efe3b3bbd537360a42bb8beeaa5031bfff3813ecb01367edf851'],
};
export interface ColibriModel {
  id: string; name: string; family: string; repo: string; download_gb: number;
  ram_min_gb: number; ram_good_gb: number; dense_gb: number; kind: string;
  fits: boolean; reason: string; summary: string; recommended: boolean; license_note: string;
}
export function colibriAsset(platform = process.platform, arch = process.arch) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error('Experimental Colibri supports Windows x64, Linux x64 and Apple Silicon. Choose Ollama on this system.');
  return { name: `colibri-v${COLIBRI_VERSION}-${asset[0]}`, sha256: asset[1] };
}
function environment(token?: string) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api.?key|^COLI_|^HF_/i.test(key))),
    COLI_SETUP_HOME: path.join(root(), 'state'), HF_HOME: path.join(root(), 'hf'), PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
    COLI_COLOR: '0', ...(token ? { HF_TOKEN: token } : {}) };
}
async function python(signal?: AbortSignal) {
  for (const command of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      const { stdout } = await exec(command, ['-c', 'import sys,struct; print("ok" if sys.version_info>=(3,10) and struct.calcsize("P")==8 else "unsupported")'], { signal, windowsHide: true, timeout: 5000 });
      if (stdout.trim() === 'ok') return command;
    } catch { signal?.throwIfAborted(); }
  }
  throw new Error('Colibri needs 64-bit Python 3.10+. Install Python from https://www.python.org/downloads/ and retry. Ollama remains available.');
}
let cpuChecked=false;
async function checkCpu(signal?: AbortSignal) {
  if(cpuChecked || process.arch!=='x64')return;
  const {stdout}=await exec(await python(signal),['-c','import sys,json;sys.path.insert(0,sys.argv[1]);from setup_hw import detect_cpu;print(json.dumps(detect_cpu()))',runtime()],{signal,windowsHide:true,env:environment(),timeout:10000});
  if(!JSON.parse(stdout).features?.includes('avx2'))throw new Error('The official Colibri x64 runtime requires an AVX2-capable CPU. Choose Ollama on this computer.');
  cpuChecked=true;
}
async function json(file: string): Promise<any> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
async function restoreSelection(previous: any) {
  for(const [file,value] of [[setupFile(),previous.config],[receiptFile(),previous.verified]] as const) {
    if(value)await atomic(file,value);else await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await unlink(transactionFile()).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
async function invoke(args: string[], options: { signal?: AbortSignal; token?: string; output?: (text: string) => void; timeout?: number; vulkan?: boolean } = {}) {
  const command = await python(options.signal);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [path.join(runtime(), 'coli'), ...args], { windowsHide: true, env: { ...environment(options.token), ...(options.vulkan ? { COLI_VULKAN: '1' } : {}) }, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Colibri timed out. See the Colibri log or retry to resume the download.'); child.kill(); }, options.timeout ?? 60000);
    child.on('error', error => { failure = error; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; options.output?.(text); if (stdout.length > 8 * 2 ** 20) { failure = new Error('Colibri output exceeded its limit.'); child.kill(); } });
    child.stderr.on('data', text => { stderr = (stderr + text).slice(-32000); options.output?.(text); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code) reject(new Error((stderr || stdout).trim().slice(-1500) || `Colibri exited with status ${code}.`)); else resolve(stdout); });
  });
}

export async function prepareColibri(signal?: AbortSignal, output: (text: string) => void = console.log) {
  const asset = colibriAsset(); await python(signal);
  const release = await acquireLease('colibri-install', signal);
  try {
    let cached=false;try { await access(path.join(runtime(), 'version.py')); await access(path.join(runtime(), 'coli'));cached=true; } catch { /* Install the pinned, verified runtime. */ }
    if(cached){await checkCpu(signal);return;}
    await mkdir(root(), { recursive: true });
    const file = path.join(root(), asset.name);
    let bytes: Buffer | undefined;
    try { bytes = await readFile(file); } catch { /* First download. */ }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      output(`Downloading experimental Colibri ${COLIBRI_VERSION} (under 16 MB). Model weights are a separate download.\n`);
      const response = await fetch(`https://github.com/JustVugg/colibri/releases/download/v${COLIBRI_VERSION}/${asset.name}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Cannot download Colibri (HTTP ${response.status}).`);
      if (Number(response.headers.get('content-length')) > 16 * 2 ** 20) throw new Error('Colibri runtime download exceeds its expected size.');
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 16 * 2 ** 20 || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Colibri runtime checksum mismatch; it was not executed.');
      await writeFile(file, bytes, { mode: 0o600 });
    }
    const tar = process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const { stdout } = await exec(tar, ['-tf', file], { signal, windowsHide: true, timeout: 30000 });
    if (stdout.split(/\r?\n/).some(entry => entry && (path.win32.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')))) throw new Error('Unsafe Colibri archive path; extraction refused.');
    await mkdir(runtime(), { recursive: true });
    await exec(tar, ['-xf', file, '-C', runtime()], { signal, windowsHide: true, timeout: 60000 });
    await access(path.join(runtime(), 'coli'));
    await checkCpu(signal);
  } finally { await release(); }
}

export async function colibriCatalog(signal?: AbortSignal): Promise<ColibriModel[]> {
  colibriAsset();
  const rows = JSON.parse(await invoke(['setup', '--list', '--json', '--dir', path.join(root(), 'models')], { signal }));
  if (!Array.isArray(rows)) throw new Error('Invalid Colibri model catalog.');
  return rows.filter(row => row.kind === 'text' && ['qwen36', 'qwen38', 'glm', 'glm53', 'deepseek_v4', 'mimo', 'kimi'].includes(row.family));
}

export function colibriPlanFits(plan: any): boolean {
  const ram = plan?.tiers?.ram;
  // Colibri reserves 3.7 GB for every engine; small dense Qwen uses notch's 1.5 GiB loading headroom plus its reported tensor/KV sizes.
  const smallDense=plan?.model?.family_id==='qwen36' && ['qwen3_5','qwen3_5_text'].includes(plan.model.model_type) && plan.model.configured_experts===0 &&
    plan.model.dense_bytes>0 && plan.model.dense_bytes<=3*2**30 && ram?.dense_on_device_bytes===0 && ram?.shared_device_dense_bytes===0 && ram?.runtime_bytes>=3.7e9;
  const runtimeBytes=smallDense?ram.runtime_bytes-3.7e9+1.5*2**30:ram?.runtime_bytes;
  return Number.isSafeInteger(ram?.budget_bytes) && ram.budget_bytes > 0 && Number.isSafeInteger(ram.available_bytes) && ram.available_bytes >= ram.budget_bytes && Number.isSafeInteger(ram.dense_bytes) && ram.dense_bytes >= 0 &&
    Number.isSafeInteger(ram.runtime_bytes) && ram.runtime_bytes > 0 && Number.isSafeInteger(ram.cache_slots_per_layer) && (ram.cache_slots_per_layer > 0 || (ram.cache_slots_per_layer === 0 && plan.model?.configured_experts === 0)) &&
    ram.dense_bytes + runtimeBytes <= ram.budget_bytes && Array.isArray(plan.warnings) && !plan.warnings.some((line: string) => typeof line !== 'string' || (/cannot hold|do not fit|not enough|not detected/.test(line) && !(smallDense && line.startsWith('a dense model keeps every weight resident:'))));
}
export async function colibriPlan(contextWindow = 4096, signal?: AbortSignal) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048 || contextWindow > 262144) throw new Error('Choose a Colibri context from 2K through 256K.');
  const cfg = await json(setupFile());
  if (cfg?.status !== 'ready') throw new Error('Install a Colibri coding model first: notch models install --runner colibri.');
  const config = await json(path.join(cfg.model_dir, 'config.hf.json')) || await json(path.join(cfg.model_dir, 'config.json'));
  const native = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  if (!Number.isSafeInteger(native) || contextWindow > native) throw new Error('This context exceeds the verified native model limit.');
  const args=['plan', '--model', cfg.model_dir, '--ctx', String(contextWindow), '--json'];
  const plan = JSON.parse(await invoke(args, { signal, vulkan: cfg.backend === 'vulkan' }));
  if(!colibriPlanFits(plan) && cfg.backend==='vulkan') {
    const cpu=JSON.parse(await invoke(args,{signal}));
    if(colibriPlanFits(cpu))return {plan:cpu,fits:true,backend:'cpu'};
  }
  return { plan, fits: colibriPlanFits(plan), backend:cfg.backend };
}
export async function colibriStatus() {
  const interrupted=await json(transactionFile());
  if(interrupted && Number.isSafeInteger(interrupted.pid) && interrupted.pid>0) {
    let alive=true;try{process.kill(interrupted.pid,0);}catch(error:any){if(error.code==='ESRCH')alive=false;}
    if(!alive){await invoke(['stop'],{timeout:120000}).catch(()=>{});await restoreSelection(interrupted);}
  }
  let installed = false; try { await access(path.join(runtime(), 'coli')); installed = true; } catch { /* Optional runtime. */ }
  const cfg = await json(setupFile()), verified = await json(receiptFile());
  let running: any = null;
  if (cfg?.status === 'ready') {
    try {
      const response = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(600) });
      const body = await response.json(); const row = body.data?.find((row: any) => row.id === verified?.modelId);
      if (response.ok && row) running = row;
    } catch { /* A stopped optional engine does not block model discovery. */ }
  }
  const config = cfg?.status === 'ready' ? await json(path.join(cfg.model_dir, 'config.hf.json')) || await json(path.join(cfg.model_dir, 'config.json')) : null;
  const nativeContext = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  return { installed, version: COLIBRI_VERSION, configured: cfg?.status === 'ready', model: cfg?.model ?? null, nativeContext,
    verified: cfg?.status === 'ready' && !!verified && verified.modelDir === cfg?.model_dir && verified.version === COLIBRI_VERSION,
    modelId: verified?.modelId, contextWindow: verified?.contextWindow ?? 4096, running: !!running,
    modelDir: cfg?.model_dir, backend: cfg?.backend, log: path.join(root(), 'state', 'logs', 'serve.log') };
}

export async function installColibri(model: string, options: { signal?: AbortSignal; token?: string; output?: (text: string) => void; modelDir?: string } = {}) {
  await prepareColibri(options.signal, options.output);
  const release = await acquireLease('colibri-install', options.signal);
  try {
    let modelDir: string | undefined;
    if (options.modelDir) { modelDir=await realpath(options.modelDir);if(!(await stat(modelDir)).isDirectory())throw new Error('Choose a converted Colibri model directory.'); }
    else { const selected = (await colibriCatalog(options.signal)).find(row => row.id === model);
      if (!selected || !selected.fits) throw new Error(selected?.reason || 'Choose a supported Colibri coding model from the catalog.'); }
    const current = await colibriStatus();
    if (current.running) throw new Error('Unload Colibri before changing its installed model.');
    const previous={pid:process.pid,config:await json(setupFile()),verified:await json(receiptFile())};
    await atomic(transactionFile(),previous);
    let validating=false;
    try {
    await invoke(['setup', ...(modelDir ? ['--model-dir',modelDir] : ['--model',model]), '--dir', path.join(root(), 'models'), '--host', '127.0.0.1', '--port', '11437', '--yes', '--no-start'], { ...options, timeout: 24 * 3600000 });
    if(modelDir){const cfg=await json(setupFile());cfg.model={...cfg.model,name:path.basename(modelDir),id:`local-${createHash('sha256').update(modelDir).digest('hex').slice(0,12)}`};await atomic(setupFile(),cfg);}
    await unlink(receiptFile()).catch(error => { if (error.code !== 'ENOENT') throw error; });
    options.output?.('Checking current memory, loading, and validating coding tools…\n');
    validating=true;
    const ready=await validateColibri(4096,options.signal);
    await unlink(transactionFile());return ready;
    } catch(error) {if(validating)await stopInternal().catch(()=>{});await restoreSelection(previous);throw error;}
  } finally { await release(); }
}

async function stopInternal() {
  const state = await colibriStatus(); if (!state.configured) return;
  await invoke(['stop'], { timeout: 120000 });
  const response = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
  if (response?.ok) throw new Error('Colibri is still running; memory release could not be verified.');
}
export async function stopColibri() { return withLocalInference(stopInternal); }

export async function startColibri(modelId?: string, contextWindow = 4096, signal?: AbortSignal): Promise<string> {
  return withLocalInference(async () => {
    await checkCpu(signal);
    const state = await colibriStatus();
    if (modelId && (!state.verified || state.modelId !== modelId)) throw new Error('This Colibri model has not passed tool validation. Run notch models install --runner colibri to validate it.');
    if (state.running && state.contextWindow === contextWindow) return COLIBRI_URL;
    if (state.running) await stopInternal();
    const { plan, fits, backend } = await colibriPlan(contextWindow, signal);
    if (!fits) throw new Error('Colibri cannot safely load this context with current free memory. Close other applications or choose a smaller context. Downloaded weights are retained.');
    const cfg = await json(setupFile());
    if(backend==='cpu'){cfg.backend='cpu';cfg.env={};}
    cfg.args = ['web', '--model', cfg.model_dir, '--host', '127.0.0.1', '--port', '11437', '--ctx', String(contextWindow), '--cap', String(plan.tiers.ram.cache_slots_per_layer), '--kv-slots', '1', '--max-queue', '8', '--no-think'];
    if(cfg.model?.id?.startsWith('local-'))cfg.args.push('--model-id',`notch-${cfg.model.id}`);
    await atomic(setupFile(), cfg);
    try {
      await invoke(['start', '--background', '--no-browser', '--json'], { signal, timeout: 30000 });
      if ((await json(setupFile()))?.port !== 11437) throw new Error('Port 11437 is in use. Stop the conflicting program before loading Colibri.');
      for (let attempt = 0; attempt < 360; attempt++) {
        signal?.throwIfAborted();
        const response = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
        if (response?.ok) {
          const body = await response.json();
          if (!Array.isArray(body.data) || body.data.length !== 1 || typeof body.data[0].id !== 'string' || (modelId && body.data[0].id !== modelId)) throw new Error('The Colibri endpoint returned an unexpected model.');
          if (state.verified) await atomic(receiptFile(), { version: COLIBRI_VERSION, modelDir: cfg.model_dir, modelId: body.data[0].id, contextWindow });
          return COLIBRI_URL;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Colibri did not become ready. See ${state.log}.`);
    } catch (error) { await stopInternal().catch(() => {}); throw error; }
  }, signal);
}

export async function validateColibri(contextWindow = 4096, signal?: AbortSignal) {
  return withLocalInference(async () => {
    await startColibri(undefined, contextWindow, signal);
    const inventory = await (await fetch(`${COLIBRI_URL}/models`, {signal: AbortSignal.timeout(3000)})).json(); const modelId = inventory.data[0].id;
    const post = async (messages: any[], tools: any[]) => {
      const response = await fetch(`${COLIBRI_URL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000),
        body: JSON.stringify({ model: modelId, messages, tools, stream: false, max_tokens: 128, temperature: 0 }) });
      if (!response.ok) throw new Error(`Colibri tool validation failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
      return response.json();
    };
    try {
      const tools = [{ type: 'function', function: { name: 'notch_setup_probe', description: 'A harmless setup check.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }];
      const user = { role: 'user', content: 'Call notch_setup_probe with ok=true. Do not answer with text.' };
      const first = await post([user], tools); const message = first.choices?.[0]?.message;
      const call = message?.tool_calls?.find((row: any) => row.function?.name === 'notch_setup_probe');
      if (!call || JSON.parse(call.function.arguments)?.ok !== true) throw new Error('Colibri did not produce a valid tool call; previous model selection is unchanged.');
      const receipt = `NOTCH_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const second = await post([user, message, { role: 'tool', tool_call_id: call.id, content: receipt }, { role: 'user', content: 'Reply with only the receipt from the tool result. Do not call another tool.' }], tools);
      if (![receipt, JSON.stringify(receipt)].includes(second.choices?.[0]?.message?.content?.trim())) throw new Error('Colibri did not read the tool result correctly; previous selection is unchanged.');
      const cfg = await json(setupFile()); await atomic(receiptFile(), { version: COLIBRI_VERSION, modelDir: cfg.model_dir, modelId, contextWindow });
      return { modelId, contextWindow, baseUrl: COLIBRI_URL };
    } catch (error) { await stopInternal().catch(() => {}); throw error; }
  }, signal);
}

export async function colibriModels(_hardware?: LocalHardware) {
  const state = await colibriStatus(); if (!state.verified) return [];
  const config = await json(path.join(state.modelDir, 'config.hf.json')) || await json(path.join(state.modelDir, 'config.json'));
  const native = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  if (!Number.isSafeInteger(native) || native < 2048) return [];
  const fits = state.running || (await colibriPlan(state.contextWindow).catch(() => ({fits:false}))).fits;
  const files=(await readdir(state.modelDir,{withFileTypes:true})).filter(file=>file.isFile() && /\.(?:safetensors|qpack)$/.test(file.name));
  const bytes=(await Promise.all(files.map(file=>stat(path.join(state.modelDir,file.name))))).reduce((sum,file)=>sum+file.size,0);
  return [{ key: `colibri/${state.modelId}`, displayName: state.model?.name || state.modelId, provider: 'colibri', source: 'system',
    enabled: fits, description: state.running ? 'Colibri · experimental · loaded' : fits ? 'Colibri · experimental' : 'Close applications to free memory before loading Colibri',
    bytes, isDefault: false, isNew: false, priceFactor: 0, tags: ['local', 'experimental'], maxInputTokens: native, maxOutputTokens: 2048,
    availableContextWindows: [2048,4096,8192,16384,32768,65536,131072,262144].filter(n => n <= native), defaultContextWindow: state.contextWindow,
    recommendedContextWindow: 4096, efforts: [], defaultEffort: null, supportsDisabled: true }];
}
