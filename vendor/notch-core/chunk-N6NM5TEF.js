import {
  quietPython
} from "./chunk-S2VC66HG.js";
import {
  withLocalInference
} from "./chunk-M6FOGWEU.js";
import {
  acquireLease
} from "./chunk-SWZ3JTKY.js";

// vendor/notch-cli/src/providers/strata.ts
import os from "os";
import path from "path";
import { access, mkdir, readFile, writeFile, rename, unlink, mkdtemp, readdir, rm, statfs } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
var STRATA_VERSION = "0.2.2";
var STRATA_CONTROL = "0.1.47";
var STRATA_URL = "http://127.0.0.1:11438/v1";
var root = () => path.join(os.homedir(), ".notch/runtimes/strata");
var runtime = () => path.join(root(), `control-${STRATA_CONTROL}`);
var selection = () => path.join(root(), "selected.json");
var exec = promisify(execFile);
var assets = {
  "win32-x64": ["windows-x86_64.zip", "91dc0a8adda3d4b5ce6307dd0f7b9d64ee26d093f544e822f764b97506f601d3"],
  "linux-x64": ["linux-x86_64.tar.gz", "7ac52e3d4ef8f50466fa0cc662be218975373309214519aa0b68fafd39e66fe8"],
  "darwin-arm64": ["macos-arm64.tar.gz", "bb25eb49e29407621ceaebd7d1381360f8eac3f35b92bb0b351c8ff0755cc2fd"]
};
function strataAsset(platform = process.platform, arch = process.arch) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error("Experimental Strata supports Windows x64, Linux x64 and Apple Silicon.");
  return { name: `strata-control-${STRATA_CONTROL}-${asset[0]}`, sha256: asset[1] };
}
var json = async (file) => JSON.parse(await readFile(file, "utf8").catch((e) => {
  if (e.code === "ENOENT") return "null";
  throw e;
}));
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 384 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {
    });
  }
}
async function environment() {
  const hooks = await quietPython(root());
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^STRATA_|^PYTHON|token|secret|password|api.?key/i.test(key))),
    PYTHONPATH: [hooks, runtime()].join(path.delimiter),
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    STRATA_INSTALL_DIR: path.join(root(), "install"),
    STRATA_SETTINGS_FILE: path.join(root(), "settings.json"),
    STRATA_COMPONENTS_DIR: path.join(root(), "components"),
    STRATA_PROFILE_DIR: path.join(root(), "profiles"),
    STRATA_RUNTIME_DIR: path.join(root(), "instances"),
    STRATA_PRESET_DIR: path.join(root(), "tuning-presets"),
    STRATA_LAUNCH_DIR: path.join(root(), "launch"),
    STRATA_UPDATE_FEED: `https://github.com/Niko1221/Strata/releases/download/v${STRATA_VERSION}`
  };
}
var STRATA_BRIDGE = String.raw`
import sys,json,os
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from dataclasses import asdict
from strata_cli.launch.catalog import Catalog
op=sys.argv[2]; request=json.loads(sys.argv[3]); root=Path(sys.argv[4])
c=Catalog(root=root/'install')
if request.get('dataDirectory'): c.strata.data_dir=lambda: Path(request['dataDirectory'])
if op=='catalog':
    hw=c.hardware(fresh=True); rows=[]
    for row in c.rows(hw):
        item=asdict(row)
        item['contextWindow']=c.max_context(row.family,row.model,hw) or 8192
        item['contexts']=c.contexts()
        item['kvBytesPerToken']=c.kv_gb(1000000)*1000
        rows.append(item)
    print(json.dumps({'hardware':hw,'models':rows}))
else:
    from strata_cli.launch.settings import LaunchSettings
    from strata_cli.launch.runner import Runner
    from strata_control import runtime
    if op=='stop':
        result=runtime.stop(request['profile'],timeout=120,expected_instance_id=request.get('instanceId'))
        if not result.get('ok') or result.get('state')!='stopped': raise ValueError('Strata could not release the previous model: '+str(result))
        print(json.dumps(result))
    elif op=='status':
        print(json.dumps(runtime.status(request['profile'])))
    else:
        row=next((r for r in c.rows() if r.id==request['id']),None)
        if row is None: raise ValueError('Choose a model offered by this Strata Control release.')
        s=LaunchSettings(name='notch-'+row.id,family=row.family,model=row.model,data_dir=request.get('dataDirectory') or str(root/'models'),
            context=request['contextWindow'],vision='off',parallel=1,tune='skip',access='local',port=11438)
        runner=Runner(s,catalog=c,components_dir=str(root/'components'),assume_yes=True,
            feed='https://github.com/Niko1221/Strata/releases/download/v0.2.2',
            emit=lambda e: print(e.text,file=sys.stderr,flush=True))
        if op=='install':
            runner.ensure_engine()
            if runner.engine_problem: raise ValueError(runner.engine_problem)
            base=runner.ensure_model()
            cfg=runner.build_config(base); runner.ensure_profile(cfg)
            print(json.dumps({'id':row.id,'title':row.title,'profile':runner.profile,'config':str(cfg),'contextWindow':s.context}))
        elif op=='start':
            cfg=runner.build_config(Path(request['config'])); runner.ensure_profile(cfg)
            result=runtime.start(runner.profile,wait=600,die_with_pid=request['ownerPid'])
            if not result.get('ok') or result.get('state')!='ready': raise ValueError(str(result))
            print(json.dumps({'contextWindow':s.context,'profile':runner.profile,'runtime':result}))
        else: raise ValueError('Unsupported Strata operation.')
`;
async function bridge(op, request = {}, signal, output = () => {
}) {
  signal?.throwIfAborted();
  const command = process.platform === "win32" ? path.join(runtime(), "python/python.exe") : path.join(runtime(), "python/bin/python3");
  const env = await environment();
  await mkdir(path.join(root(), "install"), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-c", STRATA_BRIDGE, runtime(), op, JSON.stringify(request), root()], { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const terminate = () => {
      if (process.platform === "win32" && child.pid) void exec(path.join(process.env.WINDIR || "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => child.kill());
      else try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    };
    const abort = () => {
      failure = signal?.reason instanceof Error ? signal.reason : new Error("Strata cancelled.");
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new Error("Strata timed out. Downloaded model files are retained.");
      terminate();
    }, op === "install" ? 24 * 36e5 : op === "start" ? 66e4 : op === "stop" ? 15e4 : 6e4);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      stdout += text;
      if (stdout.length > 4 * 2 ** 20) {
        failure = new Error("Strata output exceeded its limit.");
        child.kill();
      }
    });
    child.stderr.on("data", (text) => {
      stderr = (stderr + text).slice(-16e3);
      output(text);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code) reject(new Error(stderr.trim().slice(-1500) || `Strata exited ${code}.`));
      else try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error("Strata returned an invalid response."));
      }
    });
  });
}
async function prepareStrata(signal, output = () => {
}) {
  const asset = strataAsset();
  const release = await acquireLease("strata-install", signal);
  try {
    try {
      await access(path.join(runtime(), "strata.py"));
      return;
    } catch {
    }
    await mkdir(root(), { recursive: true });
    const file = path.join(root(), asset.name);
    let bytes = await readFile(file).catch(() => null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      output("Downloading the isolated Strata control runtime. Model weights download only after choosing a model.\n");
      const response = await fetch(`https://github.com/Niko1221/Strata/releases/download/v${STRATA_VERSION}/${asset.name}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18e4)]) : AbortSignal.timeout(18e4) });
      if (!response.ok) throw new Error(`Cannot download Strata (HTTP ${response.status}).`);
      if (Number(response.headers.get("content-length")) > 120 * 2 ** 20) throw new Error("Unexpected Strata archive size.");
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 120 * 2 ** 20 || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Strata checksum mismatch; nothing was executed.");
      await writeFile(file, bytes);
    }
    const tar = process.platform === "win32" ? path.join(process.env.WINDIR || "C:/Windows", "System32/tar.exe") : "tar";
    const { stdout } = await exec(tar, ["-tf", file], { signal, windowsHide: true, maxBuffer: 8 * 2 ** 20 });
    if (stdout.split(/\r?\n/).some((name) => name && (path.win32.isAbsolute(name) || name.split(/[\\/]/).includes("..")))) throw new Error("Unsafe Strata archive path.");
    const stage = await mkdtemp(path.join(root(), "extract-"));
    try {
      await exec(tar, ["-xf", file, "-C", stage], { signal, windowsHide: true, timeout: 12e4 });
      let unpacked = stage;
      try {
        await access(path.join(unpacked, "strata.py"));
      } catch {
        const entries = await readdir(stage);
        if (entries.length !== 1) throw new Error("Invalid Strata archive.");
        unpacked = path.join(stage, entries[0]);
        await access(path.join(unpacked, "strata.py"));
      }
      await rename(unpacked, runtime());
    } finally {
      if (path.dirname(stage) !== root()) throw new Error("Invalid Strata staging path.");
      await rm(stage, { recursive: true, force: true });
    }
  } finally {
    await release();
  }
}
function strataHardware(hw) {
  const cards = Array.isArray(hw?.gpus) ? hw.gpus : [];
  const cpu = hw?.cpu?.avx2 === true || !!hw?.mac;
  const usable = cards.filter((g) => g.usable === true && (["nvidia", "amd"].includes(g.vendor) || hw.mac));
  const gpu = usable.sort((a, b) => Number(b.vendor === "nvidia") - Number(a.vendor === "nvidia") || (b.vram_gb || 0) - (a.vram_gb || 0))[0];
  const available = cpu && !!gpu;
  return {
    available,
    gpu: gpu?.name || cards[0]?.name,
    unified: !!(gpu?.uma || gpu?.unified_gb || hw?.mac),
    backend: hw?.mac ? "metal" : gpu?.vendor === "nvidia" ? "cuda" : gpu?.vendor === "amd" ? "hip" : void 0,
    experimental: !!gpu?.uma,
    reason: !cpu ? "Strata requires AVX2 on x64." : !gpu ? "No GPU supported by this Strata release was detected." : gpu.uma ? "Strix Halo / unified-memory GPU detected. Windows 8060S support is experimental." : "Supported GPU detected; the signed engine package is checked before use.",
    backends: ["cuda", "hip", "metal", "cpu"].map((backend) => ({
      backend,
      available: available && (hw?.mac ? backend === "metal" : gpu?.vendor === "nvidia" ? backend === "cuda" : backend === "hip"),
      reason: backend === "cpu" ? "This Strata integration requires a supported GPU." : backend === "hip" ? "AMD HIP engine; requires a supported GPU architecture." : backend === "cuda" ? "NVIDIA CUDA engine." : "Apple Silicon Metal engine."
    }))
  };
}
function strataContext(row, hw, memory, requested, minimum = 8192) {
  const support = strataHardware(hw), GiB = 2 ** 30;
  if (row.family === "nvfp4" && support.backend !== "cuda") return { fits: false, contextWindow: void 0, reason: "This Strata NVFP4 model requires an NVIDIA CUDA GPU. Choose another model family." };
  const contexts = (Array.isArray(row.contexts) ? row.contexts : []).filter((n) => Number.isSafeInteger(n) && n >= minimum && n <= 524288);
  if (requested !== void 0 && (!Number.isSafeInteger(requested) || requested < 2048 || requested > Math.max(0, ...contexts))) throw new Error("Choose a context within this Strata model\u2019s supported range.");
  const candidates = requested === void 0 ? contexts.filter((n) => n <= Math.min(row.contextWindow, 32768)).sort((a, b) => b - a) : [requested];
  const free = Math.min(memory.availableMemory, memory.totalMemory);
  const known = Number.isSafeInteger(free) && free >= 0 && Number.isFinite(row.memory_gb) && row.memory_gb > 0 && Number.isFinite(row.kvBytesPerToken) && row.kvBytesPerToken > 0;
  const required = (tokens) => support.unified ? Math.max(row.memory_gb + 4, row.need_ram_gb + row.need_vram_gb) * 1e9 + tokens * row.kvBytesPerToken + 3 * GiB : row.need_ram_gb * 1e9 + tokens * row.kvBytesPerToken + 3 * GiB;
  const contextWindow = known && support.available ? candidates.find((n) => required(n) <= free && (support.unified || row.need_vram_gb * 1e9 <= memory.availableVram)) : void 0;
  return { fits: !!contextWindow, contextWindow, reason: !support.available ? support.reason : !known ? "Current free memory could not be verified." : contextWindow ? `Automatic hardware plan: ${support.backend?.toUpperCase()} \xB7 ${contextWindow.toLocaleString()} tokens. No speed benchmark.` : "Insufficient current RAM or GPU memory for a safe Strata load. Free memory and refresh; downloaded files are retained." };
}
function strataModelDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0") || directory.length > 4096) throw new Error("Choose an absolute model folder.");
  const resolved = path.resolve(directory);
  return resolved === path.parse(resolved).root ? path.join(resolved, "Notch", "Models", "Strata") : resolved;
}
async function strataCatalog(memory, signal) {
  let installed = false;
  try {
    await access(path.join(runtime(), "strata.py"));
    installed = true;
  } catch {
  }
  if (!installed) return { installed: false, version: STRATA_VERSION, models: [], backends: [], hardware: null, dataDirectory: void 0, freeDiskBytes: 0 };
  const dataDirectory = strataModelDirectory((await json(path.join(root(), "preferences.json")))?.dataDirectory || path.join(root(), "models"));
  await mkdir(dataDirectory, { recursive: true });
  const disk = await statfs(dataDirectory);
  const freeDiskBytes = disk.bavail * disk.bsize;
  const report = await bridge("catalog", { dataDirectory }, signal);
  if (!Array.isArray(report.models) || !report.hardware) throw new Error("Invalid Strata hardware catalog.");
  const hardware = strataHardware(report.hardware);
  return {
    installed: true,
    version: STRATA_VERSION,
    ...hardware,
    hardware: report.hardware,
    dataDirectory,
    freeDiskBytes,
    models: report.models.map((row) => {
      const plan = strataContext(row, report.hardware, memory);
      const diskFits = row.installed || freeDiskBytes >= (row.download_gb + 8) * 1e9;
      return {
        ...row,
        ...plan,
        name: `${row.family_title} \xB7 ${row.model}`,
        fits: plan.fits && diskFits,
        reason: !diskFits ? `Not enough disk space: ${(freeDiskBytes / 1e9).toFixed(1)} GB free; about ${(row.download_gb + 8).toFixed(0)} GB needed. Choose another model folder.` : plan.reason
      };
    })
  };
}
async function setStrataDirectory(directory) {
  const dataDirectory = strataModelDirectory(directory);
  return withLocalInference(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const preferences = await json(path.join(root(), "preferences.json")) || {};
    await atomic(path.join(root(), "preferences.json"), { ...preferences, dataDirectory });
  });
}
async function strataStatus() {
  const selected = await json(selection());
  let running = false, modelId, contextWindow = selected?.contextWindow;
  if (selected?.instanceId) try {
    const owned = await bridge("status", { profile: selected.profile });
    if (owned.state === "ready" && owned.instance_id === selected.instanceId) {
      const response = await fetch(STRATA_URL + "/models", { signal: AbortSignal.timeout(600) });
      const body = await response.json();
      const actual = body.data?.[0]?.meta?.n_ctx;
      if (response.ok && body.data?.length === 1 && typeof body.data[0].id === "string" && Number.isSafeInteger(actual) && actual >= 2048 && actual <= selected.nativeContext) {
        running = true;
        modelId = body.data[0].id;
        contextWindow = actual;
      }
    }
  } catch {
  }
  return { selected, running, modelId, contextWindow };
}
async function strataModels(memory) {
  const { selected, running } = await strataStatus();
  if (!selected) return [];
  const catalog = running ? null : await strataCatalog(memory), row = catalog?.models.find((r) => r.id === selected.id);
  return [{
    key: `strata/${selected.id}`,
    provider: "strata",
    displayName: `${selected.title} \xB7 Strata`,
    enabled: running || !!row?.fits,
    experimental: true,
    maxInputTokens: selected.nativeContext,
    availableContextWindows: selected.contexts,
    defaultContextWindow: selected.contextWindow,
    maxOutputTokens: 2048,
    description: row?.reason || "Experimental Strata. Memory and context are checked again before each load.",
    running
  }];
}
async function installStrata(id, memory, signal, output = () => {
}) {
  return withLocalInference(async () => {
    const previous = await strataStatus();
    if (previous.running) throw new Error("Unload Strata before changing its model.");
    const catalog = await strataCatalog(memory, signal), row = catalog.models.find((r) => r.id === id);
    if (!row || !row.fits) throw new Error(row?.reason || "Choose a supported Strata catalog model.");
    const result = await bridge("install", { id, contextWindow: row.contextWindow, dataDirectory: catalog.dataDirectory }, signal, output);
    if (result.id !== id || typeof result.profile !== "string" || typeof result.config !== "string") throw new Error("Invalid Strata model selection.");
    signal?.throwIfAborted();
    try {
      await atomic(selection(), { ...result, nativeContext: Math.max(...row.contexts), contexts: row.contexts });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) {
        if (previous.selected) await atomic(selection(), previous.selected);
        else await unlink(selection()).catch((failure) => {
          if (failure.code !== "ENOENT") throw failure;
        });
      }
      throw error;
    }
  }, signal);
}
async function stopStrata() {
  return withLocalInference(async () => {
    const s = await json(selection());
    if (s) await bridge("stop", { profile: s.profile, instanceId: s.instanceId });
  });
}
async function strataPlan(requested, signal, minimum = 8192) {
  const selected = await json(selection());
  if (!selected) throw new Error("Install a Strata model first.");
  const { detectLocalHardware } = await import("./local-models-TQK7MGJV.js");
  const memory = await detectLocalHardware(true), catalog = await strataCatalog(memory, signal);
  const row = catalog.models.find((r) => r.id === selected.id);
  if (!row) throw new Error("The installed Strata model is no longer supported.");
  return strataContext(row, catalog.hardware, memory, requested, minimum);
}
async function startStrata(id, requested, signal, minimum = 8192) {
  return withLocalInference(async () => {
    const state = await strataStatus(), selected = state.selected;
    if (!selected || selected.id !== id) throw new Error("Install this Strata model in Manage models first.");
    if (state.running && (requested === void 0 ? state.contextWindow >= minimum : state.contextWindow === requested)) return { ...state, baseUrl: STRATA_URL };
    if (state.running) await bridge("stop", { profile: selected.profile, instanceId: selected.instanceId }, signal);
    const { detectLocalHardware } = await import("./local-models-TQK7MGJV.js");
    const memory = await detectLocalHardware(true), catalog = await strataCatalog(memory, signal);
    const row = catalog.models.find((r) => r.id === id);
    const plan = row && strataContext(row, catalog.hardware, memory, requested, minimum);
    if (!plan?.fits) throw new Error(plan?.reason || "The installed Strata model is no longer supported.");
    try {
      const ready = await bridge("start", { ...selected, contextWindow: plan.contextWindow, ownerPid: process.pid }, signal);
      if (ready.contextWindow !== plan.contextWindow || typeof ready.runtime?.instance_id !== "string") throw new Error("Strata returned an unexpected context or instance.");
      await atomic(selection(), { ...selected, contextWindow: ready.contextWindow, instanceId: ready.runtime.instance_id });
      const active = await strataStatus();
      if (!active.running || !active.modelId) throw new Error("Strata did not expose its loaded model.");
      if (active.contextWindow > plan.contextWindow || (requested !== void 0 ? active.contextWindow !== requested : active.contextWindow < minimum)) throw new Error("The Strata engine context does not match the requested safe plan.");
      await atomic(selection(), { ...selected, contextWindow: active.contextWindow, instanceId: ready.runtime.instance_id });
      return { ...active, baseUrl: STRATA_URL };
    } catch (error) {
      await bridge("stop", { profile: selected.profile }).catch(() => {
      });
      throw error;
    }
  }, signal);
}

export {
  STRATA_VERSION,
  STRATA_CONTROL,
  STRATA_URL,
  strataAsset,
  STRATA_BRIDGE,
  prepareStrata,
  strataHardware,
  strataContext,
  strataModelDirectory,
  strataCatalog,
  setStrataDirectory,
  strataStatus,
  strataModels,
  installStrata,
  stopStrata,
  strataPlan,
  startStrata
};
