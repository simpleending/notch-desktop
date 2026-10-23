import {
  quietPython
} from "./chunk-S2VC66HG.js";
import {
  acquireLease,
  withLocalInference
} from "./chunk-LUGHZTHG.js";

// vendor/notch-cli/src/providers/colibri.ts
import os from "os";
import path from "path";
import { access, mkdir, readFile, writeFile, rename, unlink, realpath, stat, readdir, mkdtemp, cp, rm } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

// vendor/notch-cli/src/providers/colibri-selection.ts
function colibriBackendReady(backend, log) {
  if (backend === "cpu") return true;
  if (backend === "vulkan") return /\[VK\] (?:ready:|.*device ready, dense matrices)/i.test(log);
  if (backend === "cuda") return /\[CUDA\] device \d+: .*(?:VRAM|sm_)/i.test(log);
  return /\[(?:K3-)?METAL\] (?:ready|mode: .*GPU|init OK)/i.test(log);
}
function colibriContexts(native, requested, minimum = 8192) {
  if (!Number.isSafeInteger(native) || native < 2048) throw new Error("This model has no verified native context limit.");
  if (requested !== void 0) {
    if (!Number.isSafeInteger(requested) || requested < 2048 || requested > Math.min(native, 262144)) throw new Error("Choose a Colibri context within the verified native model limit (2K\u2013256K).");
    return [requested];
  }
  return [262144, 131072, 65536, 32768, 16384, 12288, 8192].filter((value) => value <= native && value <= Math.max(16384, minimum) && value >= minimum);
}
function colibriRank(candidates, measurements, recommended = "cpu") {
  const score = (backend) => measurements.find((row) => row.backend === backend && Number.isFinite(row.millisecondsPerToken) && row.millisecondsPerToken > 0)?.millisecondsPerToken ?? Infinity;
  return [...candidates].sort((a, b) => {
    const difference = score(a.backend) - score(b.backend);
    return Number.isNaN(difference) || difference === 0 ? Number(b.backend === recommended) - Number(a.backend === recommended) : difference;
  });
}
var COLIBRI_PLANNER = String.raw`
import sys,json,os,platform
sys.path.insert(0,sys.argv[1])
import setup_hw,setup_flow
from family_registry import resolve_model
from resource_plan import build_plan,discover_gpus
model=sys.argv[2]; contexts=json.loads(sys.argv[3])
family=resolve_model(model).descriptor if model else None
engine=setup_flow.engine_path(sys.argv[1],family) if family else None
hw=setup_hw.detect(model or None)
cpu_env={'COLI_VULKAN':'0','COLI_CUDA':'0','COLI_METAL':'0','K3_METAL':'0','K3_CUDA':'0'}
cpu_ok=platform.machine().lower() in ('arm64','aarch64') or 'avx2' in hw['cpu'].get('features',[])
options=[{'backend':'cpu','label':'CPU','available':cpu_ok,'reason':'Supported CPU; memory is checked before loading.' if cpu_ok else 'Colibri x64 requires an AVX2-capable CPU.'}]
backends=[('cpu',cpu_env)] if cpu_ok else []
vk=(hw.get('gpu') or {}).get('vulkan')
vk_ok=bool(cpu_ok and vk and family and setup_flow.prebuilt_runs(family,'vulkan',sys.argv[1]))
options.append({'backend':'vulkan','label':'Vulkan · AMD / Intel / NVIDIA','available':vk_ok,'reason':
    ('A compatible Vulkan GPU and model engine were detected. Acceleration is confirmed when loading.' if vk_ok else
     'The CPU does not meet Colibri requirements.' if not cpu_ok else
     'No compatible Vulkan 1.2+ GPU driver answered. CPU inference remains available.' if not vk else
     'Choose a Colibri model to check its GPU engine.' if not family else
     'This model engine has no installed Vulkan build or matching shaders.')})
if vk_ok:
    backends.append(('vulkan',dict(cpu_env,**setup_flow.run_environment('vulkan',engine,family,hw))))
cards=(hw.get('gpu') or {}).get('nvidia') or []
floor=setup_flow.WINDOWS_CUDA_FLOOR if sys.platform=='win32' else 0
cuda_cards=[card for card in cards if (setup_hw.compute_cap_sm(card.get('compute_cap')) or 0)>=floor]
cuda_family=bool(family and family.id in (setup_flow.WINDOWS_CUDA_ENGINES if sys.platform=='win32' else setup_flow.CUDA_ENGINES))
cuda_ok=bool(cpu_ok and cuda_cards and cuda_family and setup_flow.prebuilt_runs(family,'cuda',sys.argv[1]))
options.append({'backend':'cuda','label':'CUDA · NVIDIA','available':cuda_ok,'reason':
    ('Compatible NVIDIA GPU and CUDA model engine detected.' if cuda_ok else
     'The CPU does not meet Colibri requirements.' if not cpu_ok else
     'No NVIDIA CUDA GPU was detected. AMD GPUs use Vulkan.' if not cards else
     'The official Windows CUDA package requires compute capability 8.0+ (RTX 30 series or newer); use Vulkan on older cards.' if not cuda_cards else
     'Choose a Colibri model to check CUDA support.' if not family else
     'Colibri 2.0.0 has no supported CUDA engine for this model on this platform.' if not cuda_family else
     'The CUDA engine package is not installed. Update engine support; Vulkan or CPU remains available.')})
if cuda_ok:
    indices=','.join(str(card['index']) for card in cuda_cards)
    backends.append(('cuda',dict(cpu_env,COLI_CUDA='1',K3_CUDA='1',COLI_GPUS=indices)))
metal_ok=bool(cpu_ok and sys.platform=='darwin' and family and family.id in ('glm','inkling','kimi') and setup_flow.binary_links(engine,(b'Metal.framework',)))
options.append({'backend':'metal','label':'Metal · Apple','available':metal_ok,'reason':
    ('The selected model has an Apple Metal engine.' if metal_ok else
     'Metal is available only on Apple Silicon.' if sys.platform!='darwin' else
     'Choose a Colibri model to check Metal support.' if not family else
     'This model has no supported Metal engine in the installed release.')})
if metal_ok:
    backends.append(('metal',dict(cpu_env,COLI_METAL='1',K3_METAL='1')))
recommended='cpu'
if family:
    decision=setup_flow.choose_backend(hw,family,setup_flow.toolchain())
    recommended=decision['backend'] if any(b==decision['backend'] for b,e in backends) else 'cpu'
gpu_identity=[{key:d.get(key) for key in ('name','type','vendor_id','device_id','api_version','device_local_bytes')} for d in hw['vulkan']['devices']]
identity={'cpu':hw['cpu'],'os':platform.platform(),'memory':hw['memory']['total'],'vulkan':gpu_identity,'nvidia':cards,'engine':(os.stat(engine).st_size,os.stat(engine).st_mtime_ns) if engine else None,'model':model,'config':resolve_model(model).config if family else None,'backends':[b for b,e in backends]}
identity['weights']=sorted((entry.name,entry.stat().st_size,entry.stat().st_mtime_ns) for entry in os.scandir(model) if entry.is_file() and entry.name.endswith(('.safetensors','.qpack'))) if model else []
# Free memory changes between launches; it must never be part of a cached speed result.
identity['nvidia']=[{k:c.get(k) for k in ('name','compute_cap','driver','total_bytes')} for c in cards]
if sys.platform=='win32':
    identity['drivers']=setup_hw._run(['powershell.exe','-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'],timeout=10)
base=dict(os.environ); plans=[]
for context in contexts:
    for backend,env in backends:
        os.environ.clear();os.environ.update(base);os.environ.update(env)
        try:
            gpus=[gpu for gpu in discover_gpus() if str(gpu['index']) in env.get('COLI_GPUS','').split(',')] if backend=='cuda' else []
            plan=build_plan(model,context=context,gpus=gpus,env=dict(os.environ),physical_cpus=hw['cpu'].get('physical_cores'))
            # Tensor names are unnecessary to admit a launch and can exceed the process-output limit.
            plan.get('model',{}).pop('dense_tensors',None)
            plans.append({'backend':backend,'env':env,'plan':plan,'contextWindow':context})
        except (OSError,ValueError,KeyError) as error:
            plans.append({'backend':backend,'env':env,'plan':{'error':str(error)},'contextWindow':context})
os.environ.clear();os.environ.update(base)
detected_gpu=vk.get('name') if vk else cards[0].get('name') if cards else next((d.get('name') for d in hw['vulkan']['devices'] if d.get('type') in ('discrete','integrated')),None)
print(json.dumps({'identity':identity,'gpu':detected_gpu,'plans':plans,'backends':options,'recommendedBackend':recommended},default=str))
`;

// vendor/notch-cli/src/providers/colibri.ts
var exec = promisify(execFile);
var COLIBRI_DEFAULT_CONTEXT = 16384;
var COLIBRI_VERSION = "2.0.0";
var COLIBRI_URL = "http://127.0.0.1:11437/v1";
var root = () => path.join(os.homedir(), ".notch", "runtimes", "colibri");
var runtime = () => path.join(root(), `v${COLIBRI_VERSION}`);
var setupFile = () => path.join(root(), "state", "setup.json");
var receiptFile = () => path.join(root(), "verified-model.json");
var transactionFile = () => path.join(root(), "pending-model.json");
var tuningFile = () => path.join(root(), "backend-profiles.json");
var preferencesFile = () => path.join(root(), "preferences.json");
var assets = {
  "win32-x64": ["windows-x86_64.zip", "fdb8ea2fad7dcfe44d9d37bfb3e444f1299207f268ab499719f98bd772397d79"],
  "linux-x64": ["linux-x86_64.tar.gz", "aef2c1e7d5cbad3d27cc90d8432775acdc315ec51f6d7a67a2f13a936f9978ce"],
  "darwin-arm64": ["macos-arm64.tar.gz", "faa0841b20b7efe3b3bbd537360a42bb8beeaa5031bfff3813ecb01367edf851"]
};
function colibriCatalogFit(row, hardware) {
  const availableBytes = Math.min(hardware.availableMemory, hardware.totalMemory), reserveBytes = 1.5 * 2 ** 30;
  const requiredBytes = row.ram_min_gb * 1e9;
  const known = Number.isSafeInteger(hardware.availableMemory) && hardware.availableMemory >= 0 && Number.isSafeInteger(hardware.totalMemory) && hardware.totalMemory > 0 && Number.isFinite(requiredBytes) && requiredBytes > 0;
  const memoryFits = known && requiredBytes + reserveBytes <= availableBytes;
  const fits = row.fits && memoryFits;
  return {
    ...row,
    fits,
    recommended: row.recommended && fits,
    fitLabel: !row.fits ? "Unavailable" : !known ? "Memory unknown" : memoryFits ? "Meets RAM precheck" : "Not enough free RAM",
    reason: !row.fits ? row.reason : !known ? "Cannot verify available RAM. Refresh memory before downloading." : `${(availableBytes / 1e9).toFixed(1)} GB available; published estimate ${row.ram_min_gb} GB plus ${(reserveBytes / 1e9).toFixed(1)} GB headroom. ${memoryFits ? "Exact context fit is unverified until the downloaded checkpoint is checked; Automatic targets 16K and can use 8K." : "Close applications and refresh memory before downloading."}`,
    ...known ? { memory: { availableBytes, totalBytes: hardware.totalMemory, reserveBytes, requiredBytes } } : {}
  };
}
function colibriAsset(platform = process.platform, arch = process.arch) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error("Experimental Colibri supports Windows x64, Linux x64 and Apple Silicon. Choose Ollama on this system.");
  return { name: `colibri-v${COLIBRI_VERSION}-${asset[0]}`, sha256: asset[1] };
}
function colibriModelEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:TOK|TOKENS|SNAP(?:_MIRROR)?|MODEL|CHAT_TEMPLATE|THINK|Q(?:36|38)_EOS|K3_THINK|CLEF_(?:TOKENIZE|RECORDS|IDS)|K3_VALIDATE_TOKEN)$/i.test(key) && (!/^COLI_/i.test(key) || /^COLI_(?:VULKAN|VK_SHADERS|NO_OMP_TUNE|CUDA|METAL)$/i.test(key))));
}
function environment(token) {
  return {
    ...colibriModelEnvironment(Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api.?key|^COLI_|^HF_|^K3_(?:CUDA|METAL)$|^CUDA_(?:DENSE|EXPERT_GB)$|^RAM_GB$/i.test(key)))),
    COLI_SETUP_HOME: path.join(root(), "state"),
    HF_HOME: path.join(root(), "hf"),
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    COLI_COLOR: "0",
    ...process.platform === "win32" ? { PYTHONPATH: path.join(root(), "python-hooks") } : {},
    ...token ? { HF_TOKEN: token } : {}
  };
}
async function python(signal) {
  if (process.platform === "win32") await quietPython(root());
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try {
      const { stdout } = await exec(command, ["-c", 'import sys,struct; print("ok" if sys.version_info>=(3,10) and struct.calcsize("P")==8 else "unsupported")'], { signal, windowsHide: true, timeout: 5e3 });
      if (stdout.trim() === "ok") return command;
    } catch {
      signal?.throwIfAborted();
    }
  }
  throw new Error("Colibri needs 64-bit Python 3.10+. Install Python from https://www.python.org/downloads/ and retry. Ollama remains available.");
}
var cpuChecked = false;
async function checkCpu(signal) {
  if (cpuChecked || process.arch !== "x64") return;
  const { stdout } = await exec(await python(signal), ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from setup_hw import detect_cpu;print(json.dumps(detect_cpu()))", runtime()], { signal, windowsHide: true, env: environment(), timeout: 1e4 });
  if (!JSON.parse(stdout).features?.includes("avx2")) throw new Error("The official Colibri x64 runtime requires an AVX2-capable CPU. Choose Ollama on this computer.");
  cpuChecked = true;
}
async function json(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 384, flag: "wx", flush: true });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {
    });
  }
}
async function restoreSelection(previous) {
  for (const [file, value] of [[setupFile(), previous.config], [receiptFile(), previous.verified]]) {
    if (value) await atomic(file, value);
    else await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await unlink(transactionFile()).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
async function invoke(args, options = {}) {
  const command = await python(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path.join(runtime(), "coli"), ...args], { windowsHide: true, env: { ...environment(options.token), ...options.vulkan ? { COLI_VULKAN: "1" } : {} }, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const timer = setTimeout(() => {
      failure = new Error("Colibri timed out. See the Colibri log or retry to resume the download.");
      child.kill();
    }, options.timeout ?? 6e4);
    child.on("error", (error) => {
      failure = error;
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      stdout += text;
      options.output?.(text);
      if (stdout.length > 8 * 2 ** 20) {
        failure = new Error("Colibri output exceeded its limit.");
        child.kill();
      }
    });
    child.stderr.on("data", (text) => {
      stderr = (stderr + text).slice(-32e3);
      options.output?.(text);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code) reject(new Error((stderr || stdout).trim().slice(-1500) || `Colibri exited with status ${code}.`));
      else resolve(stdout);
    });
  });
}
async function installRuntimeAsset(asset, signal, output) {
  await mkdir(root(), { recursive: true });
  const file = path.join(root(), asset.name);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
  }
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    output(`Downloading experimental Colibri ${COLIBRI_VERSION} (under 16 MB). Model weights are a separate download.
`);
    const response = await fetch(`https://github.com/JustVugg/colibri/releases/download/v${COLIBRI_VERSION}/${asset.name}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18e4)]) : AbortSignal.timeout(18e4) });
    if (!response.ok) throw new Error(`Cannot download Colibri (HTTP ${response.status}).`);
    if (Number(response.headers.get("content-length")) > 16 * 2 ** 20) throw new Error("Colibri runtime download exceeds its expected size.");
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 16 * 2 ** 20 || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Colibri runtime checksum mismatch; it was not executed.");
    await writeFile(file, bytes, { mode: 384 });
  }
  const tar = process.platform === "win32" ? path.join(process.env.WINDIR || "C:/Windows", "System32", "tar.exe") : "tar";
  const { stdout } = await exec(tar, ["-tf", file], { signal, windowsHide: true, timeout: 3e4 });
  if (stdout.split(/\r?\n/).some((entry) => entry && (path.win32.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")))) throw new Error("Unsafe Colibri archive path; extraction refused.");
  const stage = await mkdtemp(path.join(root(), "extract-"));
  try {
    await exec(tar, ["-xf", file, "-C", stage], { signal, windowsHide: true, timeout: 6e4 });
    await mkdir(runtime(), { recursive: true });
    for (const name of await readdir(stage)) await cp(path.join(stage, name), path.join(runtime(), name), { recursive: true });
  } finally {
    if (path.dirname(stage) !== root()) throw new Error("Invalid Colibri extraction directory.");
    await rm(stage, { recursive: true, force: true });
  }
  await access(path.join(runtime(), "coli"));
}
async function prepareColibri(signal, output = console.log) {
  const asset = colibriAsset();
  await python(signal);
  const release = await acquireLease("colibri-install", signal);
  try {
    let cached = false;
    try {
      await access(path.join(runtime(), "version.py"));
      await access(path.join(runtime(), "coli"));
      cached = true;
    } catch {
    }
    if (!cached) await installRuntimeAsset(asset, signal, output);
    await checkCpu(signal);
    if (process.platform === "win32") {
      let cuda = false;
      try {
        await access(path.join(runtime(), "coli_cuda.dll"));
        cuda = true;
      } catch {
      }
      if (!cuda) {
        const { stdout } = await exec(await python(signal), ["-c", 'import sys,json;sys.path.insert(0,sys.argv[1]);from setup_hw import detect_nvidia,compute_cap_sm;print(json.dumps(any((compute_cap_sm(g.get("compute_cap")) or 0)>=80 for g in detect_nvidia())))', runtime()], { signal, windowsHide: true, env: environment(), timeout: 3e4 });
        if (JSON.parse(stdout)) {
          const active = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(1e3) }).catch(() => null);
          if (!active?.ok) try {
            output("Preparing the optional NVIDIA CUDA backend (under 4 MB)\u2026\n");
            await installRuntimeAsset({ name: `colibri-v${COLIBRI_VERSION}-windows-x86_64-cuda.zip`, sha256: "e0f7f4ad339909a9ef5dfc3bda6afe46757d3358d8a2d446e460ce14a1f7dc3a" }, signal, output);
          } catch (error) {
            signal?.throwIfAborted();
            output("CUDA setup is unavailable; CPU and Vulkan remain available for automatic selection.\n");
          }
        }
      }
    }
  } finally {
    await release();
  }
}
async function colibriCatalog(signal) {
  colibriAsset();
  const rows = JSON.parse(await invoke(["setup", "--list", "--json", "--dir", path.join(root(), "models")], { signal }));
  if (!Array.isArray(rows)) throw new Error("Invalid Colibri model catalog.");
  const hardware = { totalMemory: os.totalmem(), availableMemory: Math.min(os.freemem(), process.availableMemory()) };
  return rows.filter((row) => row.kind === "text" && ["qwen36", "qwen38", "glm", "glm53", "deepseek_v4", "mimo", "kimi"].includes(row.family)).map((row) => colibriCatalogFit(row, hardware)).sort((a, b) => Number(b.fits) - Number(a.fits));
}
function colibriPlanFits(plan) {
  const ram = plan?.tiers?.ram;
  const smallDense = plan?.model?.family_id === "qwen36" && ["qwen3_5", "qwen3_5_text"].includes(plan.model.model_type) && plan.model.configured_experts === 0 && plan.model.dense_bytes > 0 && plan.model.dense_bytes <= 3 * 2 ** 30 && ram?.dense_on_device_bytes === 0 && ram?.shared_device_dense_bytes === 0 && ram?.runtime_bytes >= 37e8;
  const runtimeBytes = smallDense ? ram.runtime_bytes - 37e8 + 1.5 * 2 ** 30 : ram?.runtime_bytes;
  return Number.isSafeInteger(ram?.budget_bytes) && ram.budget_bytes > 0 && Number.isSafeInteger(ram.available_bytes) && ram.available_bytes >= ram.budget_bytes && Number.isSafeInteger(ram.dense_bytes) && ram.dense_bytes >= 0 && Number.isSafeInteger(ram.runtime_bytes) && ram.runtime_bytes > 0 && Number.isSafeInteger(ram.cache_slots_per_layer) && (ram.cache_slots_per_layer > 0 || ram.cache_slots_per_layer === 0 && plan.model?.configured_experts === 0) && ram.dense_bytes + runtimeBytes <= ram.budget_bytes && Array.isArray(plan.warnings) && !plan.warnings.some((line) => typeof line !== "string" || /cannot hold|do not fit|not enough|not detected/.test(line) && !(smallDense && line.startsWith("a dense model keeps every weight resident:")));
}
async function probeColibri(modelDir, contexts, signal) {
  const { stdout } = await exec(await python(signal), ["-c", COLIBRI_PLANNER, runtime(), modelDir, JSON.stringify(contexts)], { signal, windowsHide: true, env: environment(), timeout: 6e4, maxBuffer: 8 * 2 ** 20 });
  const report = JSON.parse(stdout);
  if (!Array.isArray(report.plans) || !Array.isArray(report.backends)) throw new Error("Invalid Colibri hardware plan.");
  return report;
}
async function colibriCompatibility(signal) {
  const cfg = await json(setupFile());
  const report = await probeColibri(cfg?.status === "ready" ? cfg.model_dir : "", [], signal);
  return { backends: report.backends, gpu: report.gpu, recommendedBackend: report.recommendedBackend };
}
async function setColibriPreference(key, value) {
  if (key !== "backend" && key !== "benchmarkEnabled") throw new Error("Choose a supported Colibri preference.");
  if (key === "benchmarkEnabled" && typeof value !== "boolean") throw new Error("Choose whether to compare backend speeds.");
  if (key === "backend" && !["auto", "cpu", "vulkan", "cuda", "metal"].includes(String(value))) throw new Error("Choose a supported Colibri backend.");
  return withLocalInference(async () => {
    if (key === "backend") {
      if ((await colibriStatus()).running) throw new Error("Unload Colibri before changing its backend.");
      if (value !== "auto") {
        const { backends } = await colibriCompatibility();
        const row = backends.find((row2) => row2.backend === value);
        if (!row?.available) throw new Error(row?.reason || "This Colibri backend is unavailable on this device.");
      }
    }
    const previous = await json(preferencesFile()) || {};
    await atomic(preferencesFile(), { ...previous, [key]: value });
  });
}
async function colibriPlan(contextWindow, signal, minimumContext = 8192) {
  const cfg = await json(setupFile());
  if (cfg?.status !== "ready") throw new Error("Install a Colibri coding model first: notch models install --runner colibri.");
  const config = await json(path.join(cfg.model_dir, "config.hf.json")) || await json(path.join(cfg.model_dir, "config.json"));
  const native = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  const contexts = colibriContexts(native, contextWindow, minimumContext);
  const report = await probeColibri(cfg.model_dir, contexts, signal);
  const preferences = await json(preferencesFile()) || {};
  const backendPreference = preferences.backend || cfg.requested_backend || "auto";
  const allowed = backendPreference === "auto" ? report.plans : report.plans.filter((row) => row.backend === backendPreference);
  const selectedContext = contexts.find((value) => allowed.some((row) => row.contextWindow === value && colibriPlanFits(row.plan)));
  const candidates = allowed.filter((row) => row.contextWindow === selectedContext && colibriPlanFits(row.plan));
  const fingerprint = createHash("sha256").update(JSON.stringify([COLIBRI_VERSION, report.identity, selectedContext])).digest("hex");
  const saved = await json(tuningFile()).catch(() => null);
  const profile = saved?.[fingerprint];
  const measurements = profile?.schema === 1 && Date.now() - profile.at >= 0 && Date.now() - profile.at < 7 * 864e5 && Array.isArray(profile.measurements) ? profile.measurements.filter((row) => row && ["cpu", "cuda", "vulkan", "metal"].includes(row.backend) && Number.isFinite(row.millisecondsPerToken) && row.millisecondsPerToken > 0) : [];
  const checkedBackends = measurements.length && Date.now() - profile.at < 36e5 && Array.isArray(profile.checkedBackends) ? profile.checkedBackends : measurements.map((row) => row.backend);
  const ranked = colibriRank(candidates, measurements, report.recommendedBackend);
  return {
    plan: ranked[0]?.plan,
    fits: !!ranked.length,
    backend: ranked[0]?.backend,
    contextWindow: selectedContext,
    candidates: ranked,
    fingerprint,
    measurements,
    checkedBackends,
    gpu: report.gpu,
    recommendedBackend: report.recommendedBackend,
    backendPreference,
    benchmarkEnabled: preferences.benchmarkEnabled !== false
  };
}
async function colibriStatus() {
  const interrupted = await json(transactionFile());
  if (interrupted && Number.isSafeInteger(interrupted.pid) && interrupted.pid > 0) {
    let alive = true;
    try {
      process.kill(interrupted.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
    }
    if (!alive) {
      await invoke(["stop"], { timeout: 12e4 }).catch(() => {
      });
      await restoreSelection(interrupted);
    }
  }
  let installed = false;
  try {
    await access(path.join(runtime(), "coli"));
    installed = true;
  } catch {
  }
  const cfg = await json(setupFile()), verified = await json(receiptFile()), preferences = await json(preferencesFile()) || {};
  let running = null;
  if (cfg?.status === "ready") {
    try {
      const response = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(600) });
      const body = await response.json();
      const row = body.data?.find((row2) => row2.id === verified?.modelId);
      if (response.ok && row) running = row;
    } catch {
    }
  }
  const config = cfg?.status === "ready" ? await json(path.join(cfg.model_dir, "config.hf.json")) || await json(path.join(cfg.model_dir, "config.json")) : null;
  const nativeContext = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  return {
    installed,
    version: COLIBRI_VERSION,
    configured: cfg?.status === "ready",
    model: cfg?.model ?? null,
    nativeContext,
    verified: cfg?.status === "ready" && !!verified && verified.modelDir === cfg?.model_dir && verified.version === COLIBRI_VERSION,
    modelId: verified?.modelId,
    contextWindow: verified?.contextWindow ?? COLIBRI_DEFAULT_CONTEXT,
    running: !!running,
    modelDir: cfg?.model_dir,
    backend: cfg?.backend,
    backendPreference: preferences.backend || cfg?.requested_backend || "auto",
    gpu: cfg?.gpu,
    benchmarkEnabled: preferences.benchmarkEnabled !== false,
    selectionReason: cfg?.notch_selection_reason,
    calibration: cfg?.notch_calibration,
    log: path.join(root(), "state", "logs", "serve.log")
  };
}
async function installColibri(model, options = {}) {
  await prepareColibri(options.signal, options.output);
  const release = await acquireLease("colibri-install", options.signal);
  try {
    let modelDir;
    if (options.modelDir) {
      modelDir = await realpath(options.modelDir);
      if (!(await stat(modelDir)).isDirectory()) throw new Error("Choose a converted Colibri model directory.");
    } else {
      const selected = (await colibriCatalog(options.signal)).find((row) => row.id === model);
      if (!selected || !selected.fits) throw new Error(selected?.reason || "Choose a supported Colibri coding model from the catalog.");
    }
    const current = await colibriStatus();
    if (current.running) throw new Error("Unload Colibri before changing its installed model.");
    const previous = { pid: process.pid, config: await json(setupFile()), verified: await json(receiptFile()) };
    await atomic(transactionFile(), previous);
    let validating = false;
    try {
      await invoke(["setup", ...modelDir ? ["--model-dir", modelDir] : ["--model", model], "--dir", path.join(root(), "models"), "--host", "127.0.0.1", "--port", "11437", "--yes", "--no-start"], { ...options, timeout: 24 * 36e5 });
      if (modelDir) {
        const cfg = await json(setupFile());
        cfg.model = { ...cfg.model, name: path.basename(modelDir), id: `local-${createHash("sha256").update(modelDir).digest("hex").slice(0, 12)}` };
        await atomic(setupFile(), cfg);
      }
      await unlink(receiptFile()).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      options.output?.("Checking current memory, loading, and validating coding tools\u2026\n");
      validating = true;
      const ready = await validateColibri(void 0, options.signal, options.output);
      await unlink(transactionFile());
      return ready;
    } catch (error) {
      if (validating) await stopInternal().catch(() => {
      });
      await restoreSelection(previous);
      throw error;
    }
  } finally {
    await release();
  }
}
async function stopInternal() {
  const state = await colibriStatus();
  if (!state.configured) return;
  await invoke(["stop"], { timeout: 12e4 });
  const response = await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(1e3) }).catch(() => null);
  if (response?.ok) throw new Error("Colibri is still running; memory release could not be verified.");
}
async function stopColibri() {
  return withLocalInference(stopInternal);
}
async function launchColibri(candidate, cfg, modelId, signal) {
  const logFile = path.join(root(), "state", "logs", "serve.log");
  const before = await stat(logFile).catch(() => null);
  cfg.backend = candidate.backend;
  cfg.env = candidate.env;
  cfg.args = ["web", "--model", cfg.model_dir, "--host", "127.0.0.1", "--port", "11437", "--ctx", String(candidate.contextWindow), "--cap", String(candidate.plan.tiers.ram.cache_slots_per_layer), "--kv-slots", "1", "--max-queue", "8", "--no-think"];
  if (candidate.backend === "cuda") cfg.args.push("--gpu", candidate.env.COLI_GPUS || "auto", "--auto-tier");
  else cfg.args.push("--gpu", "none");
  if (cfg.model?.id?.startsWith("local-")) cfg.args.push("--model-id", `notch-${cfg.model.id}`);
  await atomic(setupFile(), cfg);
  await invoke(["start", "--background", "--no-browser", "--json"], { signal, timeout: 3e4 });
  if ((await json(setupFile()))?.port !== 11437) throw new Error("Port 11437 is in use. Stop the conflicting program before loading Colibri.");
  for (let attempt = 0; attempt < 360; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`${COLIBRI_URL}/models`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1e3)]) : AbortSignal.timeout(1e3) }).catch((error) => {
      signal?.throwIfAborted();
      return null;
    });
    if (response?.ok) {
      const body = await response.json();
      if (!Array.isArray(body.data) || body.data.length !== 1 || typeof body.data[0].id !== "string" || modelId && body.data[0].id !== modelId) throw new Error("The Colibri endpoint returned an unexpected model.");
      if (candidate.backend !== "cpu") {
        const after = await stat(logFile);
        const offset = before && before.ino === after.ino && before.size <= after.size ? before.size : 0;
        const log = (await readFile(logFile)).subarray(offset).toString("utf8");
        if (!colibriBackendReady(candidate.backend, log)) throw new Error(`The Colibri engine did not confirm ${candidate.backend.toUpperCase()} acceleration. Trying another backend.`);
      }
      return body.data[0].id;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Colibri did not become ready. See ${path.join(root(), "state", "logs", "serve.log")}.`);
}
async function measureColibri(model, signal) {
  let elapsed = 0, tokens = 0;
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    const response = await fetch(`${COLIBRI_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6e4)]) : AbortSignal.timeout(6e4),
      body: JSON.stringify({ model, messages: [{ role: "user", content: `Write the integers from 1 to 100, separated by spaces. Start immediately with 1. Calibration sample ${round}.` }], stream: false, max_tokens: 32, temperature: 0 })
    });
    if (!response.ok) throw new Error(`Colibri speed check failed (HTTP ${response.status}).`);
    const body = await response.json(), count = body.usage?.completion_tokens;
    if (!Number.isSafeInteger(count) || count < 8 || !body.choices?.[0]?.message?.content?.trim()) throw new Error("Colibri returned an incomplete speed check.");
    if (round) {
      elapsed += performance.now() - started;
      tokens += count;
    }
  }
  return elapsed / tokens;
}
async function startColibri(modelId, contextWindow, signal, output = () => {
}, minimumContext = 8192) {
  return withLocalInference(async () => {
    signal?.throwIfAborted();
    await checkCpu(signal);
    const state = await colibriStatus();
    if (modelId && (!state.verified || state.modelId !== modelId)) throw new Error("This Colibri model has not passed tool validation. Run notch models install --runner colibri to validate it.");
    if (state.running && (contextWindow === void 0 ? state.contextWindow >= minimumContext : state.contextWindow === contextWindow)) return COLIBRI_URL;
    if (state.running) await stopInternal();
    await prepareColibri(signal, output);
    const selection = await colibriPlan(contextWindow, signal, minimumContext);
    if (!selection.fits) throw new Error("Colibri cannot safely load a useful coding context with current free memory. Close other applications or choose a smaller explicit context. Downloaded weights are retained.");
    const cfg = await json(setupFile());
    cfg.requested_backend = selection.backendPreference;
    cfg.gpu = selection.gpu;
    const measurements = [...selection.measurements];
    const calibrate = selection.benchmarkEnabled && selection.candidates.length > 1 && selection.candidates.some((candidate) => !selection.checkedBackends.includes(candidate.backend));
    let loaded, id;
    try {
      if (calibrate) {
        output(`Comparing Colibri backends at ${selection.contextWindow.toLocaleString()} tokens. Saving the result for later launches.
`);
        for (const candidate of selection.candidates) {
          if (measurements.some((row) => row.backend === candidate.backend)) continue;
          output(`Checking ${candidate.backend.toUpperCase()}${selection.gpu ? ` on ${selection.gpu}` : ""}\u2026
`);
          try {
            const fresh = await colibriPlan(candidate.contextWindow, signal);
            const current = fresh.candidates.find((row) => row.backend === candidate.backend);
            if (!current) continue;
            id = await launchColibri(current, cfg, modelId, signal);
            loaded = current;
            const millisecondsPerToken = await measureColibri(id, signal);
            measurements.push({ backend: current.backend, millisecondsPerToken });
            output(`${current.backend.toUpperCase()}: ${(1e3 / millisecondsPerToken).toFixed(1)} tokens/sec including prompt processing.
`);
          } catch (error) {
            signal?.throwIfAborted();
            output(`${candidate.backend.toUpperCase()} speed check unavailable; trying another safe backend.
`);
          } finally {
            await stopInternal();
            loaded = void 0;
          }
        }
        const profiles = await json(tuningFile()).catch(() => ({})) || {};
        profiles[selection.fingerprint] = { schema: 1, at: Date.now(), measurements, checkedBackends: selection.candidates.map((row) => row.backend) };
        await atomic(tuningFile(), Object.fromEntries(Object.entries(profiles).slice(-32)));
      }
      const ranked = colibriRank(selection.candidates, measurements, selection.recommendedBackend);
      let lastError;
      for (const candidate of ranked) {
        signal?.throwIfAborted();
        try {
          const fresh = await colibriPlan(candidate.contextWindow, signal);
          const current = fresh.candidates.find((row) => row.backend === candidate.backend);
          if (!current) continue;
          id = await launchColibri(current, cfg, modelId, signal);
          loaded = current;
          break;
        } catch (error) {
          lastError = error;
          await stopInternal();
          signal?.throwIfAborted();
        }
      }
      if (!loaded || !id) throw lastError || new Error("Available memory changed while preparing Colibri. Close applications and retry.");
      const measured = measurements.find((row) => row.backend === loaded.backend);
      const reason = cfg.requested_backend !== "auto" ? "explicit backend preference" : measured ? "fastest measured working backend that currently fits" : selection.candidates.length === 1 ? "only safe available backend" : !selection.benchmarkEnabled ? "official hardware/model default; speed comparison paused" : "safe available backend; speed comparison unavailable";
      cfg.notch_selection_reason = `${loaded.backend.toUpperCase()} \xB7 ${loaded.contextWindow.toLocaleString()} tokens \xB7 ${reason}${selection.gpu ? ` \xB7 ${selection.gpu}` : ""}`;
      cfg.notch_calibration = measurements;
      await atomic(setupFile(), cfg);
      output(cfg.notch_selection_reason + "\n");
      if (state.verified) await atomic(receiptFile(), { version: COLIBRI_VERSION, modelDir: cfg.model_dir, modelId: id, contextWindow: loaded.contextWindow });
      return COLIBRI_URL;
    } catch (error) {
      await stopInternal().catch(() => {
      });
      throw error;
    }
  }, signal);
}
async function validateColibri(contextWindow, signal, output) {
  return withLocalInference(async () => {
    await startColibri(void 0, contextWindow, signal, output);
    const launchConfig = await json(setupFile());
    const effectiveContext = Number(launchConfig.args[launchConfig.args.indexOf("--ctx") + 1]);
    const inventory = await (await fetch(`${COLIBRI_URL}/models`, { signal: AbortSignal.timeout(3e3) })).json();
    const modelId = inventory.data[0].id;
    const post = async (messages, tools) => {
      const response = await fetch(`${COLIBRI_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6e5)]) : AbortSignal.timeout(6e5),
        body: JSON.stringify({ model: modelId, messages, tools, stream: false, max_tokens: 128, temperature: 0 })
      });
      if (!response.ok) throw new Error(`Colibri tool validation failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
      return response.json();
    };
    try {
      const tools = [{ type: "function", function: { name: "notch_setup_probe", description: "A harmless setup check.", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } }];
      const user = { role: "user", content: "Call notch_setup_probe with ok=true. Do not answer with text." };
      const first = await post([user], tools);
      const message = first.choices?.[0]?.message;
      const call = message?.tool_calls?.find((row) => row.function?.name === "notch_setup_probe");
      if (!call || JSON.parse(call.function.arguments)?.ok !== true) throw new Error("Colibri did not produce a valid tool call; previous model selection is unchanged.");
      const receipt = `NOTCH_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const second = await post([user, message, { role: "tool", tool_call_id: call.id, content: receipt }, { role: "user", content: "Reply with only the receipt from the tool result. Do not call another tool." }], tools);
      if (![receipt, JSON.stringify(receipt)].includes(second.choices?.[0]?.message?.content?.trim())) throw new Error("Colibri did not read the tool result correctly; previous selection is unchanged.");
      const cfg = await json(setupFile());
      await atomic(receiptFile(), { version: COLIBRI_VERSION, modelDir: cfg.model_dir, modelId, contextWindow: effectiveContext });
      return { modelId, contextWindow: effectiveContext, baseUrl: COLIBRI_URL };
    } catch (error) {
      await stopInternal().catch(() => {
      });
      throw error;
    }
  }, signal);
}
async function colibriModels(_hardware) {
  const state = await colibriStatus();
  if (!state.verified) return [];
  const config = await json(path.join(state.modelDir, "config.hf.json")) || await json(path.join(state.modelDir, "config.json"));
  const native = config?.text_config?.max_position_embeddings ?? config?.max_position_embeddings;
  if (!Number.isSafeInteger(native) || native < 2048) return [];
  const automatic = state.running ? { fits: true, contextWindow: state.contextWindow } : await colibriPlan().catch(() => ({ fits: false, contextWindow: state.contextWindow }));
  const fits = automatic.fits;
  const files = (await readdir(state.modelDir, { withFileTypes: true })).filter((file) => file.isFile() && /\.(?:safetensors|qpack)$/.test(file.name));
  const bytes = (await Promise.all(files.map((file) => stat(path.join(state.modelDir, file.name))))).reduce((sum, file) => sum + file.size, 0);
  return [{
    key: `colibri/${state.modelId}`,
    displayName: state.model?.name || state.modelId,
    provider: "colibri",
    source: "system",
    enabled: fits,
    description: state.running ? "Colibri \xB7 experimental \xB7 loaded" : fits ? "Colibri \xB7 experimental" : "Close applications to free memory before loading Colibri",
    bytes,
    isDefault: false,
    isNew: false,
    priceFactor: 0,
    tags: ["local", "experimental"],
    maxInputTokens: native,
    maxOutputTokens: 2048,
    availableContextWindows: [2048, 4096, 8192, 12288, 16384, 32768, 65536, 131072, 262144].filter((n) => n <= native),
    defaultContextWindow: automatic.contextWindow || state.contextWindow,
    recommendedContextWindow: automatic.contextWindow || state.contextWindow,
    efforts: [],
    defaultEffort: null,
    supportsDisabled: true
  }];
}

export {
  COLIBRI_DEFAULT_CONTEXT,
  COLIBRI_VERSION,
  COLIBRI_URL,
  colibriCatalogFit,
  colibriAsset,
  colibriModelEnvironment,
  prepareColibri,
  colibriCatalog,
  colibriPlanFits,
  colibriCompatibility,
  setColibriPreference,
  colibriPlan,
  colibriStatus,
  installColibri,
  stopColibri,
  startColibri,
  validateColibri,
  colibriModels
};
