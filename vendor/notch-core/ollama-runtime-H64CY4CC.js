// vendor/notch-cli/src/providers/ollama-runtime.ts
import os from "os";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, readFile, writeFile, rename, stat, open, unlink } from "fs/promises";
import { createZstdDecompress } from "zlib";
import { createHash } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
var exec = promisify(execFile);
var MANAGED_OLLAMA_HOST = "http://127.0.0.1:11436";
var root = () => path.join(os.homedir(), ".notch", "runtimes", "ollama");
function versionAtLeast(actual, minimum) {
  const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const a = parse(actual), b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
function runtimeAssetName(platform, arch) {
  if (platform === "darwin") return "ollama-darwin.tgz";
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : void 0;
  if (!cpu || !["win32", "linux"].includes(platform)) throw new Error("Install a compatible Ollama runtime from https://ollama.com/download.");
  return platform === "win32" ? `ollama-windows-${cpu}.zip` : `ollama-linux-${cpu}.tar.zst`;
}
async function daemonVersion(host) {
  try {
    const response = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(3e3) });
    const body = await response.json();
    return typeof body.version === "string" ? body.version : void 0;
  } catch {
    return void 0;
  }
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
async function downloadAsset(asset, directory, signal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 2 ** 30 || !asset.browser_download_url.startsWith("https://github.com/ollama/ollama/releases/download/")) throw new Error("Ollama release asset has no verifiable digest or download URL.");
  const file = path.join(directory, asset.name);
  try {
    if ((await stat(file)).size === asset.size && await hashFile(file) === asset.digest) return file;
  } catch {
  }
  const partial = file + ".part";
  let received = 0;
  try {
    received = (await stat(partial)).size;
  } catch {
  }
  if (received >= asset.size) received = 0;
  const response = await fetch(asset.browser_download_url, {
    headers: received ? { Range: `bytes=${received}-` } : {},
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18e5)]) : AbortSignal.timeout(18e5)
  });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed (HTTP ${response.status}). Retry to resume.`);
  if (response.status !== 206) received = 0;
  let previous = -1;
  const progress = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    const percent = Math.floor(received / asset.size * 10) * 10;
    if (percent !== previous) {
      console.log(`${asset.name}: ${Math.min(100, percent)}%`);
      previous = percent;
    }
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: received ? "a" : "w", mode: 384 }));
  if ((await stat(partial)).size !== asset.size || await hashFile(partial) !== asset.digest) throw new Error("Runtime checksum did not match the official release. It was not executed.");
  await rename(partial, file);
  return file;
}
async function managedOllama(minimum = "0.30.0", signal) {
  const running = await daemonVersion(MANAGED_OLLAMA_HOST);
  if (running) {
    if (!versionAtLeast(running, minimum)) throw new Error(`Port 11436 hosts incompatible Ollama ${running}. Stop that server before retrying.`);
    return MANAGED_OLLAMA_HOST;
  }
  await mkdir(root(), { recursive: true });
  let installed;
  try {
    const saved = JSON.parse(await readFile(path.join(root(), "installed.json"), "utf8"));
    if (/^v\d+\.\d+\.\d+$/.test(saved.tag) && versionAtLeast(saved.tag, minimum)) {
      const directory = path.join(root(), saved.tag);
      const candidates = [path.join(directory, "ollama.exe"), path.join(directory, "ollama"), path.join(directory, "bin", "ollama")];
      for (const executable of candidates) {
        try {
          const { stdout, stderr } = await exec(executable, ["--version"], { timeout: 5e3, signal, windowsHide: true, env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11436" } });
          const version = /\b(\d+\.\d+\.\d+)\b/.exec(stdout + stderr)?.[1];
          if (version && versionAtLeast(version, minimum)) {
            installed = { tag: saved.tag, executable };
            break;
          }
        } catch {
          signal?.throwIfAborted();
        }
      }
    }
  } catch {
    signal?.throwIfAborted();
  }
  if (!installed) {
    const response = await fetch("https://api.github.com/repos/ollama/ollama/releases/latest", { signal: AbortSignal.timeout(15e3) });
    if (!response.ok) throw new Error(`Cannot discover the official Ollama runtime (HTTP ${response.status}).`);
    const release = await response.json();
    if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !versionAtLeast(release.tag_name, minimum)) throw new Error("No compatible official Ollama release is available.");
    const name = runtimeAssetName(os.platform(), os.arch());
    const main = release.assets.find((asset) => asset.name === name);
    if (!main) throw new Error(`Official runtime asset ${name} is unavailable.`);
    const directory = path.join(root(), release.tag_name);
    await mkdir(directory, { recursive: true });
    const assets = [main];
    if (os.platform() === "win32" && os.arch() === "x64") {
      const rocm = release.assets.find((asset) => asset.name === "ollama-windows-amd64-rocm.zip");
      if (rocm) assets.push(rocm);
    }
    console.log(`This model requires Ollama ${minimum}+. Installing isolated ${release.tag_name}; ${(assets.reduce((sum, asset) => sum + asset.size, 0) / 2 ** 30).toFixed(1)} GiB runtime download. The existing Ollama installation stays available.`);
    const tar = os.platform() === "win32" ? path.join(process.env.WINDIR || "C:/Windows", "System32", "tar.exe") : "tar";
    for (const asset of assets) {
      const archive = await downloadAsset(asset, directory, signal);
      let extract = archive;
      if (archive.endsWith(".zst")) {
        extract = archive.slice(0, -4);
        await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(extract, { mode: 384 }), { signal });
      }
      const { stdout } = await exec(tar, ["-tf", extract], { timeout: 3e4, signal, windowsHide: true, maxBuffer: 8 * 2 ** 20 });
      if (stdout.split(/\r?\n/).some((entry) => entry && (path.win32.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")))) throw new Error("Runtime archive contains an unsafe path; extraction refused.");
      await exec(tar, ["-xf", extract, "-C", directory], { timeout: 18e4, signal, windowsHide: true });
      if (extract !== archive) await unlink(extract);
    }
    const candidates = [path.join(directory, "ollama.exe"), path.join(directory, "ollama"), path.join(directory, "bin", "ollama")];
    for (const executable of candidates) {
      try {
        const { stdout, stderr } = await exec(executable, ["--version"], { timeout: 5e3, signal, windowsHide: true, env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11436" } });
        const version = /\b(\d+\.\d+\.\d+)\b/.exec(stdout + stderr)?.[1];
        if (version && versionAtLeast(version, minimum)) {
          installed = { tag: release.tag_name, executable };
          break;
        }
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (!installed) throw new Error("Downloaded Ollama could not run on this computer.");
    await writeFile(path.join(root(), "installed.json"), JSON.stringify({ tag: installed.tag }), { mode: 384 });
  }
  signal?.throwIfAborted();
  const log = await open(path.join(root(), "server.log"), "a", 384);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key/i.test(key)));
  const child = spawn(installed.executable, ["serve"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
    env: { ...env, OLLAMA_HOST: "127.0.0.1:11436", OLLAMA_NO_CLOUD: "1" }
  });
  await log.close();
  let failure;
  child.on("error", (error) => {
    failure = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    if (failure) throw failure;
    const version = await daemonVersion(MANAGED_OLLAMA_HOST);
    if (version && versionAtLeast(version, minimum)) return MANAGED_OLLAMA_HOST;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Managed Ollama did not start. See ${path.join(root(), "server.log")}.`);
}
export {
  MANAGED_OLLAMA_HOST,
  daemonVersion,
  managedOllama,
  runtimeAssetName,
  versionAtLeast
};
