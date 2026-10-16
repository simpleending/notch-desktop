// vendor/notch-cli/src/concurrency/lease.ts
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 100 || !["EPERM", "EBUSY", "EACCES"].includes(error.code || "")) throw error;
      await delay(10);
    }
  }
}
var removeTicket = (file) => retryFileOperation(() => fs.unlink(file)).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
async function acquireLease(key, signal, onWait, directory = path.join(os.homedir(), ".notch", "coordination")) {
  signal?.throwIfAborted();
  const folder = path.join(directory, createHash("sha256").update(key).digest("hex"));
  await fs.mkdir(folder, { recursive: true, mode: 448 });
  const name = `${String(Date.now()).padStart(16, "0")}-${String(process.hrtime.bigint()).padStart(24, "0")}-${process.pid}-${randomUUID()}.ticket`;
  const file = path.join(folder, name);
  await fs.writeFile(file, "", { flag: "wx", mode: 384 });
  const readNumber = async (ticket) => {
    try {
      const raw = await retryFileOperation(() => fs.readFile(path.join(folder, ticket), "utf8")), value = Number(raw);
      return raw && Number.isSafeInteger(value) && value > 0 ? value : void 0;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  };
  let waiting = false, released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await removeTicket(file);
    if (waiting) onWait?.(false);
  };
  try {
    const existing = (await fs.readdir(folder)).filter((name2) => name2.endsWith(".ticket"));
    const number = Math.max(0, ...(await Promise.all(existing.map(readNumber))).map((value) => value ?? 0)) + 1;
    if (!Number.isSafeInteger(number)) throw new Error("Invalid coordination ticket; no operation was started.");
    const temporary = file + ".tmp";
    try {
      await fs.writeFile(temporary, String(number), { flag: "wx", mode: 384 });
      await retryFileOperation(() => fs.rename(temporary, file));
    } finally {
      await removeTicket(temporary);
    }
    while (true) {
      signal?.throwIfAborted();
      const tickets = (await fs.readdir(folder)).filter((name2) => /^\d+-\d+-\d+-[\da-f-]+\.ticket$/.test(name2)).sort();
      let blocked = false;
      for (const ticket of tickets) {
        if (ticket === name) continue;
        const pid = Number(ticket.split("-")[2]);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        if (!alive) {
          await removeTicket(path.join(folder, ticket));
          continue;
        }
        const other = await readNumber(ticket);
        if (other === void 0 || other > 0 && (other < number || other === number && ticket < name)) blocked = true;
      }
      if (!blocked) {
        if (waiting) {
          waiting = false;
          onWait?.(false);
        }
        return release;
      }
      if (!waiting) {
        waiting = true;
        onWait?.(true);
      }
      await delay(50, void 0, { signal });
    }
  } catch (error) {
    await release();
    throw error;
  }
}

// vendor/notch-cli/src/concurrency/local-inference.ts
import { AsyncLocalStorage } from "async_hooks";
var executionContext = new AsyncLocalStorage();
var ownership = new AsyncLocalStorage();
async function withLocalInference(operation, signal) {
  if (ownership.getStore()) return operation();
  const notify = executionContext.getStore()?.onQueue;
  const release = await acquireLease("local-inference", signal, (waiting) => notify?.(waiting ? "Waiting for local model\u2026" : null));
  try {
    return await ownership.run(true, operation);
  } finally {
    await release();
  }
}
function queuedLocalFetch(fetcher) {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0) ?? void 0;
    const notify = executionContext.getStore()?.onQueue;
    const release = await acquireLease("local-inference", signal, (waiting) => notify?.(waiting ? "Waiting for local model\u2026" : null));
    let reader;
    const finish = async () => {
      signal?.removeEventListener("abort", abort);
      await release();
    };
    const abort = () => {
      void (reader?.cancel(signal?.reason) ?? Promise.resolve()).catch(() => {
      }).finally(finish);
    };
    try {
      signal?.throwIfAborted();
      const response = await ownership.run(true, () => fetcher(input, init));
      if (!response.body) {
        await finish();
        return response;
      }
      reader = response.body.getReader();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        await reader.cancel(signal.reason);
        signal.throwIfAborted();
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              controller.close();
              await finish();
            } else controller.enqueue(result.value);
          } catch (error) {
            controller.error(error);
            await reader.cancel().catch(() => {
            });
            await finish();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await finish();
          }
        }
      }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      await finish();
      throw error;
    }
  };
}

// vendor/notch-cli/src/providers/local-models.ts
import os2 from "os";
import path2 from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir, rename, unlink, readdir } from "fs/promises";
import { randomUUID as randomUUID2 } from "crypto";
var exec = promisify(execFile);
var GiB = 2 ** 30;
function supportsMlx(platform, appleSilicon, darwinMajor) {
  return platform === "darwin" && appleSilicon && darwinMajor >= 23;
}
function parseNvidiaMemory(stdout) {
  const rows = stdout.trim().split(/\r?\n/).map((row) => row.split(",").map(Number)).filter((row) => row.length === 2 && row.every((n) => Number.isSafeInteger(n) && n >= 0) && row[0] > 0 && row[1] <= row[0]);
  const selected = rows.sort((a, b) => b[1] - a[1])[0];
  if (!selected) throw new Error("GPU memory telemetry is unavailable.");
  return { totalVram: selected[0] * 2 ** 20, availableVram: selected[1] * 2 ** 20 };
}
async function linuxGpuMemory(root = "/sys/class/drm") {
  let selected = { totalVram: 0, availableVram: 0 };
  for (const card of (await readdir(root)).filter((name) => /^card\d+$/.test(name))) {
    try {
      const device = path2.join(root, card, "device");
      const [total, used] = (await Promise.all(["mem_info_vram_total", "mem_info_vram_used"].map((name) => readFile(path2.join(device, name), "utf8")))).map(Number);
      if (Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(used) && used >= 0 && used <= total && total - used > selected.availableVram) selected = { totalVram: total, availableVram: total - used };
    } catch {
    }
  }
  return selected;
}
async function detectLocalHardware(refresh = false) {
  const platform = os2.platform();
  const arch = os2.arch();
  let appleSilicon = platform === "darwin" && arch === "arm64";
  if (platform === "darwin" && !appleSilicon) {
    try {
      appleSilicon = (await exec("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { timeout: 2e3 })).stdout.trim() === "1";
    } catch {
    }
  }
  let availableVram = 0;
  let totalVram = 0;
  let installedMemory = os2.totalmem();
  if (!appleSilicon) {
    const candidates = ["nvidia-smi", ...platform === "win32" ? [path2.join(process.env.WINDIR || "C:/Windows", "System32/nvidia-smi.exe")] : []];
    for (const executable of candidates) {
      try {
        const { stdout } = await exec(executable, ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"], { timeout: 2500, windowsHide: true });
        ({ availableVram, totalVram } = parseNvidiaMemory(stdout));
        break;
      } catch {
      }
    }
  }
  if (platform === "win32" && availableVram === 0) {
    try {
      const { windowsMemory } = await import("./windows-memory-RX7NZ2OM.js");
      const result = await windowsMemory(refresh);
      installedMemory = result.installedMemory;
      availableVram = result.availableVram;
      totalVram = result.totalVram;
    } catch {
    }
  }
  if (platform === "linux" && totalVram === 0) {
    try {
      ({ availableVram, totalVram } = await linuxGpuMemory());
    } catch {
    }
  }
  return {
    platform,
    arch,
    appleSilicon,
    mlxSupported: supportsMlx(platform, appleSilicon, Number(os2.release().split(".")[0])),
    totalMemory: os2.totalmem(),
    installedMemory,
    availableMemory: Math.min(os2.freemem(), process.availableMemory()),
    availableVram,
    totalVram
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
  let contextLength;
  if (runner === "mlx") {
    const revision = typeof body.sha === "string" && /^[a-f0-9]{40}$/.test(body.sha) ? body.sha : "main";
    const configResponse = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/config.json`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3)
    });
    if (!configResponse.ok) throw new Error(`Cannot verify ${repo}'s native context limit (HTTP ${configResponse.status}).`);
    const config = await configResponse.json();
    contextLength = config.text_config?.max_position_embeddings ?? config.max_position_embeddings ?? config.max_seq_len ?? config.seq_length;
    if (!Number.isSafeInteger(contextLength) || contextLength < 2048) throw new Error(`${repo} has no verifiable native context limit.`);
  }
  return {
    repo,
    runner,
    model: runner === "mlx" ? repo : `hf.co/${repo}:Q4_K_M`,
    bytes,
    license: body.cardData?.license,
    ...contextLength ? { contextLength } : {},
    ...typeof body.createdAt === "string" && Number.isFinite(Date.parse(body.createdAt)) ? { createdAt: new Date(body.createdAt).toISOString() } : {},
    fetchedAt: Date.now(),
    source: "live",
    ...runner === "ollama" ? { ollamaBase: LOCAL_MODEL_CATALOG.find((row) => row.gguf === repo)?.ollamaBase } : {}
  };
}
async function inspectHubModel(repo, runner, signal, token, refresh = false) {
  signal?.throwIfAborted();
  if (!/^[\w](?:[\w.-]*[\w])?\/[\w](?:[\w.-]*[\w])?$/.test(repo)) throw new Error("Use a Hugging Face repository id in owner/model form.");
  const file = path2.join(os2.homedir(), ".notch", "cache", "hub-models", `${runner}-${repo.replace("/", "--")}.json`);
  let cached;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.repo === repo && value.runner === runner && value.model === (runner === "mlx" ? repo : `hf.co/${repo}:Q4_K_M`) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && Number.isFinite(value.fetchedAt) && value.fetchedAt <= Date.now()) cached = value;
    if (!refresh && cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1e3) return { ...cached, source: "cache" };
  } catch {
  }
  try {
    const value = await fetchHubModel(repo, runner, signal, token);
    const temporary = `${file}.${randomUUID2()}.tmp`;
    try {
      await mkdir(path2.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(value), { mode: 384 });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => {
      });
    }
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (!refresh && cached) return { ...cached, source: "cache" };
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
  acquireLease,
  executionContext,
  withLocalInference,
  queuedLocalFetch,
  parseNvidiaMemory,
  linuxGpuMemory,
  detectLocalHardware,
  LOCAL_MODEL_CATALOG,
  inspectHubModel,
  modelFit
};
