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
function modelFit(model, hardware) {
  const usableRam = Math.max(0, Math.min(hardware.availableMemory - GiB, hardware.totalMemory * 0.75));
  const usableVram = hardware.appleSilicon ? 0 : Math.max(0, hardware.availableVram - GiB);
  const required = model.bytes * 1.2 + 1.5 * GiB;
  const budget = usableRam + usableVram;
  return { fits: required <= budget, required, budget, contextLength: required + 2 * GiB <= budget ? 16384 : 8192, batchSize: 64 };
}

export {
  detectLocalHardware,
  modelFit
};
