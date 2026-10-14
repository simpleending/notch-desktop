// vendor/notch-cli/src/providers/local-models.ts
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import { randomUUID } from "crypto";
var exec = promisify(execFile);
var GiB = 2 ** 30;
function supportsMlx(platform, appleSilicon, darwinMajor) {
  return platform === "darwin" && appleSilicon && darwinMajor >= 23;
}
async function detectLocalHardware() {
  const platform = os.platform();
  const arch = os.arch();
  let appleSilicon = platform === "darwin" && arch === "arm64";
  if (platform === "darwin" && !appleSilicon) {
    try {
      appleSilicon = (await exec("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { timeout: 2e3 })).stdout.trim() === "1";
    } catch {
    }
  }
  let availableVram = 0;
  let installedMemory = os.totalmem();
  if (!appleSilicon) {
    const candidates = ["nvidia-smi", ...platform === "win32" ? [path.join(process.env.WINDIR || "C:/Windows", "System32/nvidia-smi.exe")] : []];
    for (const executable of candidates) {
      try {
        const { stdout } = await exec(executable, ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 2500, windowsHide: true });
        const rows = stdout.trim().split(/\r?\n/).map(Number).filter((value) => Number.isFinite(value) && value > 0);
        availableVram = Math.max(0, ...rows) * 2 ** 20;
        break;
      } catch {
      }
    }
  }
  if (platform === "win32" && availableVram === 0) {
    try {
      const { windowsMemory } = await import("./windows-memory-JB77LYUI.js");
      const result = await windowsMemory();
      installedMemory = result.installedMemory;
      availableVram = result.availableVram;
    } catch {
    }
  }
  return {
    platform,
    arch,
    appleSilicon,
    mlxSupported: supportsMlx(platform, appleSilicon, Number(os.release().split(".")[0])),
    totalMemory: os.totalmem(),
    installedMemory,
    availableMemory: Math.min(os.freemem(), process.availableMemory()),
    availableVram
  };
}
var LOCAL_MODEL_CATALOG = [
  { label: "Qwen3.5 4B", gguf: "unsloth/Qwen3.5-4B-GGUF", mlx: "mlx-community/Qwen3.5-4B-4bit", ollamaBase: "qwen3.5:4b" },
  { label: "Qwen3.5 9B", gguf: "unsloth/Qwen3.5-9B-GGUF", mlx: "mlx-community/Qwen3.5-9B-4bit", ollamaBase: "qwen3.5:9b" },
  { label: "Qwen3 Coder 30B", gguf: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", mlx: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit", ollamaBase: "qwen3-coder:30b" }
];
async function fetchHubModel(repo, runner, signal, token) {
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error("Use a Hugging Face repository id in owner/model form.");
  const response = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3)
  });
  if (!response.ok) throw new Error(`Cannot inspect ${repo} (HTTP ${response.status}). Choose an accessible public model.`);
  const body = await response.json();
  if (body.gated) throw new Error(`${repo} is gated. The guided installer supports public models that need no account.`);
  const weights = body.siblings?.filter((file) => runner === "mlx" ? /\.safetensors$/i.test(file.rfilename) : /Q4_K_M(?:-\d+-of-\d+)?\.gguf$/i.test(file.rfilename) && !/mmproj/i.test(file.rfilename)) ?? [];
  const bytes = weights.reduce((sum, file) => sum + (file.size ?? file.lfs?.size ?? 0), 0);
  if (!weights.length || !Number.isSafeInteger(bytes) || bytes <= 0 || weights.some((file) => !Number.isSafeInteger(file.size ?? file.lfs?.size) || (file.size ?? file.lfs?.size ?? 0) <= 0)) {
    throw new Error(`${repo} has no verifiable ${runner === "mlx" ? "MLX safetensors" : "Q4_K_M GGUF"} weights.`);
  }
  return {
    repo,
    runner,
    model: runner === "mlx" ? repo : `hf.co/${repo}:Q4_K_M`,
    bytes,
    license: body.cardData?.license,
    ...typeof body.createdAt === "string" && Number.isFinite(Date.parse(body.createdAt)) ? { createdAt: new Date(body.createdAt).toISOString() } : {},
    fetchedAt: Date.now(),
    source: "live",
    ...runner === "ollama" ? { ollamaBase: LOCAL_MODEL_CATALOG.find((row) => row.gguf === repo)?.ollamaBase } : {}
  };
}
async function inspectHubModel(repo, runner, signal, token) {
  signal?.throwIfAborted();
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error("Use a Hugging Face repository id in owner/model form.");
  const file = path.join(os.homedir(), ".notch", "cache", "hub-models", `${runner}-${repo.replace("/", "--")}.json`);
  let cached;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.repo === repo && value.runner === runner && value.model === (runner === "mlx" ? repo : `hf.co/${repo}:Q4_K_M`) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && Number.isFinite(value.fetchedAt) && value.fetchedAt <= Date.now()) cached = value;
    if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1e3) return { ...cached, source: "cache" };
  } catch {
  }
  try {
    const value = await fetchHubModel(repo, runner, signal, token);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(value), { mode: 384 });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => {
      });
    }
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (cached) return { ...cached, source: "cache" };
    throw error;
  }
}
function modelFit(model, hardware) {
  const usableRam = Math.max(0, Math.min(hardware.availableMemory - GiB, hardware.totalMemory * 0.75));
  const usableVram = hardware.appleSilicon ? 0 : Math.max(0, hardware.availableVram - GiB);
  const required = model.bytes * 1.2 + 1.5 * GiB;
  const budget = usableRam + usableVram;
  return { fits: required <= budget, required, budget, contextLength: required + 2 * GiB <= budget ? 16384 : 8192, batchSize: 64 };
}

export {
  detectLocalHardware,
  LOCAL_MODEL_CATALOG,
  inspectHubModel,
  modelFit
};
