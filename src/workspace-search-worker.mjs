import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// FFI loads a real shared library; its package must live outside the ASAR archive.
const modulePath = createRequire(import.meta.url).resolve('@ff-labs/fff-node').replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
const { FileFinder } = await import(pathToFileURL(modulePath).href);

const indexes = new Map();
function value(result) { if (!result.ok) throw new Error(result.error); return result.value; }
async function search({ root, query }) {
  if (typeof root !== 'string' || typeof query !== 'string' || query.length > 1024) throw new Error('Invalid file search request.');
  root = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('File search root is not a directory.');
  let finder = indexes.get(root);
  if (!finder) {
    if (indexes.size >= 2) { const oldest = indexes.keys().next().value; indexes.get(oldest).destroy(); indexes.delete(oldest); }
    finder = value(FileFinder.create({ basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true, enableHomeDirScanning: true }));
    indexes.set(root, finder);
  } else { indexes.delete(root); indexes.set(root, finder); }
  const complete = value(await finder.waitForScan(5000));
  const found = value(finder.fileSearch(query.replaceAll('\\', '/'), { pageSize: 200, maxThreads: 2 }));
  const entries = [];
  for (const item of found.items) {
    try {
      const physical = await fs.realpath(path.resolve(root, item.relativePath));
      const relative = path.relative(root, physical);
      // File symlinks must not disclose names from outside the selected project.
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      entries.push({ path: item.relativePath.replaceAll('\\', '/'), name: item.fileName, type: 'file' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { entries, truncated: found.totalMatched > 200, incomplete: !complete };
}
let queue = Promise.resolve();
const latest = new Map();
const send = message => process.parentPort ? process.parentPort.postMessage(message) : process.send(message);
function receive(request) {
  latest.set(request.searchId, request.id);
  queue = queue.then(async () => {
    if (latest.get(request.searchId) !== request.id) return;
    try { send({ id: request.id, result: await search(request) }); }
    catch (error) { send({ id: request.id, error: String(error.message).slice(0, 1024) }); }
    finally { if (latest.get(request.searchId) === request.id) latest.delete(request.searchId); }
  });
}
if (process.parentPort) process.parentPort.on('message', event => receive(event.data));
else process.on('message', receive);
process.on('exit', () => { for (const finder of indexes.values()) finder.destroy(); });
