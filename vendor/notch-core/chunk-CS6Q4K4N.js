// vendor/notch-cli/src/providers/runtime-maintenance.ts
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
var receiptName = ".notch-owned-runtime.json";
var versionName = /^(?:v\d+\.\d+\.\d+|control-\d+\.\d+\.\d+)$/;
async function inventory(directory) {
  if ((await fs.lstat(directory)).isSymbolicLink() || path.resolve(await fs.realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw Error("Runtime links are kept.");
  const files = [];
  async function walk(folder, cache = false) {
    for (const name of await fs.readdir(folder)) {
      if (name === receiptName) continue;
      const file = path.join(folder, name), info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw Error("Runtime links are kept.");
      if (info.isDirectory()) {
        if (!cache && name !== "__pycache__") files.push({ path: path.relative(directory, file), kind: "directory", size: 0, mtimeMs: 0 });
        await walk(file, cache || name === "__pycache__");
      } else if (info.isFile()) {
        if (cache && name.endsWith(".pyc")) continue;
        files.push({ path: path.relative(directory, file), size: info.size, mtimeMs: info.mtimeMs });
        if (files.length > 2e4) throw Error("Runtime inventory is too large.");
      } else throw Error("Unknown runtime entry.");
    }
  }
  await walk(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function markOwnedRuntime(directory) {
  if (!versionName.test(path.basename(directory))) throw Error("Choose a versioned runtime directory.");
  const receipt = { version: 1, owner: "notch", installedAt: Date.now(), files: await inventory(directory) };
  await fs.writeFile(path.join(directory, receiptName), JSON.stringify(receipt), { flag: "wx", mode: 384 });
}
async function owned(directory) {
  try {
    const info = await fs.lstat(path.join(directory, receiptName));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 2 ** 20) return null;
    const receipt = JSON.parse(await fs.readFile(path.join(directory, receiptName), "utf8"));
    if (receipt.version !== 1 || receipt.owner !== "notch" || !Number.isSafeInteger(receipt.installedAt) || !Array.isArray(receipt.files)) return null;
    if (JSON.stringify(receipt.files) !== JSON.stringify(await inventory(directory))) return null;
    return receipt;
  } catch {
    return null;
  }
}
async function pruneOwnedRuntimes(root, current, processes, apply = false) {
  root = path.resolve(root);
  if ((await fs.lstat(root)).isSymbolicLink() || path.resolve(await fs.realpath(root)).toLowerCase() !== root.toLowerCase()) throw Error("Runtime links are kept.");
  if (!versionName.test(current)) throw Error("Choose the active runtime version.");
  const rows = [];
  for (const name of await fs.readdir(root)) {
    if (!versionName.test(name)) continue;
    const directory = path.resolve(root, name);
    if (path.dirname(directory) !== root) throw Error("Invalid runtime path.");
    const receipt = await owned(directory);
    if (receipt) rows.push({ name, directory, receipt });
  }
  rows.sort((a, b) => b.receipt.installedAt - a.receipt.installedAt);
  const keep = /* @__PURE__ */ new Set([current, ...rows.filter((row) => row.name !== current).slice(0, 1).map((row) => row.name)]), removed = [], available = [];
  const active = (lines, ...directories) => lines.some((line) => directories.some((directory) => line.toLowerCase().includes(directory.toLowerCase())));
  for (const row of rows) {
    if (keep.has(row.name) || active(await processes(), row.directory)) continue;
    available.push(row.name);
    if (!apply) continue;
    if (!await owned(row.directory)) continue;
    const quarantine = path.resolve(root, "cleanup-" + randomUUID());
    if (path.dirname(quarantine) !== root) throw Error("Invalid cleanup path.");
    await fs.rename(row.directory, quarantine);
    try {
      if (active(await processes(), row.directory, quarantine) || !await owned(quarantine)) {
        await fs.rename(quarantine, row.directory);
        continue;
      }
    } catch (error) {
      await fs.rename(quarantine, row.directory);
      throw error;
    }
    if (path.dirname(quarantine) !== root || path.resolve(await fs.realpath(quarantine)).toLowerCase() !== quarantine.toLowerCase()) throw Error("Runtime cleanup path changed.");
    await fs.rm(quarantine, { recursive: true });
    removed.push(row.name);
  }
  return { available, removed };
}
async function rotateRuntimeLog(file, limit = 8 * 2 ** 20) {
  let before;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= limit) return;
  const handle = await fs.open(file, "r"), buffer = Buffer.alloc(limit);
  try {
    await handle.read(buffer, 0, limit, before.size - limit);
  } finally {
    await handle.close();
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, buffer, { flag: "wx", mode: 384 });
    const after = await fs.stat(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return;
    await fs.rename(temporary, file + ".previous");
    await fs.truncate(file, 0);
  } finally {
    await fs.unlink(temporary).catch(() => {
    });
  }
}

export {
  markOwnedRuntime,
  pruneOwnedRuntimes,
  rotateRuntimeLog
};
