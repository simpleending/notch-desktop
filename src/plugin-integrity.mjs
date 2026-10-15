import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function target(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '..' || part === '.') || path.isAbsolute(relative)) throw new Error('Invalid plugin catalog path.');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error('Plugin path escaped the bundle.');
  return file;
}
async function inventory(root) {
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Plugin roots cannot be symbolic links.');
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Plugin bundles cannot contain symbolic links.');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push({ path: path.relative(root, file).split(path.sep).join('/'), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
      else throw new Error('Unsupported plugin bundle entry.');
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function inspect(directory, rebuild) {
  const root = await fs.realpath(directory), catalogFile = path.join(root, 'catalog.v1.json');
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  if (catalog.schemaVersion !== 1 || catalog.productId !== 'notch' || !Array.isArray(catalog.plugins)) throw new Error('Invalid notch plugin catalog.');
  const ids = new Set();
  let count = 0;
  for (const plugin of catalog.plugins) {
    if (!plugin || typeof plugin.id !== 'string' || ids.has(plugin.id) || !Array.isArray(plugin.files)) throw new Error('Invalid or duplicate plugin entry.');
    ids.add(plugin.id);
    const folder = target(root, plugin.root), files = await inventory(folder);
    const manifest = JSON.parse(await fs.readFile(target(folder, '.notch-app-plugin/plugin.json'), 'utf8'));
    if (manifest.id !== plugin.id || manifest.version !== plugin.version) throw new Error(`Plugin manifest identity mismatch: ${plugin.id}`);
    for (const file of plugin.files) target(folder, file.path);
    if (rebuild) { plugin.files = files; plugin.manifest = manifest; }
    else {
      if (!isDeepStrictEqual(plugin.manifest, manifest)) throw new Error(`Plugin manifest integrity failed: ${plugin.id}`);
      if (new Set(plugin.files.map(file => file.path)).size !== plugin.files.length || !isDeepStrictEqual([...plugin.files].sort((a, b) => a.path.localeCompare(b.path)), files)) throw new Error(`Plugin file integrity failed: ${plugin.id}`);
    }
    count += files.length;
  }
  if (rebuild) {
    const temporary = `${catalogFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(catalog, null, 2), { flag: 'wx', flush: true }); await fs.rename(temporary, catalogFile); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  return { plugins: ids.size, files: count };
}
/** Run only at build time, after branding; runtime verification stays enabled. */
export const rebuildPluginCatalog = directory => inspect(directory, true);
export const verifyPluginCatalog = directory => inspect(directory, false);
