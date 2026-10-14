import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch } from 'node:fs';
import { minimatch } from 'minimatch';

// FFI loads a real shared library; its package must live outside the ASAR archive.
const modulePath = createRequire(import.meta.url).resolve('@ff-labs/fff-node').replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
const { FileFinder } = await import(pathToFileURL(modulePath).href);

const indexes = new Map();
const execFileAsync = promisify(execFile);
const ripgrep = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'notch-rg.exe') : 'rg';
const textExtensions = new Set('ts tsx mts cts js jsx mjs cjs json jsonc md mdx txt toml yaml yml xml svg html htm css scss less rs py go c h cpp hpp cc java kt kts swift sh bash zsh fish ps1 sql graphql gql svelte vue rb php lua r dart ini cfg conf properties csv tsv'.split(' '));
const visible = file => !file.replaceAll('\\', '/').split('/').some(part => part.startsWith('.'));
function destroy(entry) { entry.watcher?.close(); entry.finder.destroy(); }
function value(result) { if (!result.ok) throw new Error(result.error); return result.value; }
async function index(root, content) {
  let entry = indexes.get(root);
  if (entry && content && !entry.content) { destroy(entry); indexes.delete(root); entry = undefined; }
  if (!entry) {
    if (indexes.size >= 2) { const oldest = indexes.keys().next().value; destroy(indexes.get(oldest)); indexes.delete(oldest); }
    const finder = value(FileFinder.create({ basePath: root, followSymlinks: false, disableMmapCache: !content, disableContentIndexing: !content, cacheBudgetMaxBytes: 64 * 1024 ** 2, enableHomeDirScanning: true }));
    entry = { finder, content, dirty: true, revision: 0 };
    if (content) {
      entry.watcher = watch(root, { recursive: true }, () => { entry.dirty = true; entry.revision++; });
      entry.watcher.on('error', () => { entry.dirty = true; entry.watchFailed = true; });
    }
    indexes.set(root, entry);
  } else { indexes.delete(root); indexes.set(root, entry); }
  if (entry.dirty && entry.ready) value(entry.finder.scanFiles());
  return entry;
}
async function allFiles(entry) {
  if (!value(await entry.finder.waitForScan(5000))) throw new Error('Workspace indexing is incomplete; retry the search.');
  entry.ready = true;
  const found = value(entry.finder.glob('**/*', { pageSize: Math.max(1, value(entry.finder.getScanProgress()).scannedFilesCount) }));
  if (found.items.length !== found.totalMatched) throw new Error('Workspace file enumeration is incomplete.');
  return found.items.filter(item => visible(item.relativePath));
}
async function coverage(entry, scope, files) {
  if (!entry.dirty && entry.count === files.length && !entry.watchFailed) return entry;
  const revision = entry.revision;
  const { stdout } = await execFileAsync(ripgrep, ['--files', '--null', '--no-require-git', '--', scope], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 5 * 1024 ** 2 }).catch(error => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  const listed = stdout.split('\0').filter(Boolean).map(file => path.relative(scope, file).replaceAll('\\', '/'));
  const indexed = new Set(files.map(item => item.relativePath.replaceAll('\\', '/')));
  entry.listed = listed;
  entry.equal = listed.length === indexed.size && listed.every(file => indexed.has(file));
  entry.supported = entry.equal;
  // shortcut: conservative UTF-8 source allowlist for fff 0.11, widen only after format-parity tests.
  for (let start = 0; entry.supported && start < files.length; start += 16) {
    const compatible = await Promise.all(files.slice(start, start + 16).map(async file => {
      if (!file.size) return true;
      if (file.size > 10 * 1024 ** 2 || !textExtensions.has(path.extname(file.relativePath).slice(1).toLowerCase())) return false;
      try {
        const bytes = await fs.readFile(path.join(scope, file.relativePath));
        if (bytes.includes(0) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return false;
        new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true;
      }
      catch { return false; }
    }));
    entry.supported = compatible.every(Boolean);
  }
  entry.dirty = entry.revision !== revision; entry.count = files.length;
  return entry;
}
async function contained(root, file) {
  const physical = await fs.realpath(file), relative = path.relative(root, physical);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Search target is outside the selected workspace.');
  return physical;
}
async function search({ root, query, operation = 'search', params, active = () => true }) {
  if (typeof root !== 'string' || typeof query !== 'string' || query.length > 1024) throw new Error('Invalid file search request.');
  root = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('File search root is not a directory.');
  if (operation !== 'search') return tool(operation, root, params, active);
  const { finder } = await index(root, false);
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
async function tool(operation, root, params, active) {
  if (!['grep', 'glob'].includes(operation) || !params || typeof params.pattern !== 'string' || params.pattern.length > 1024 || (params.path !== undefined && typeof params.path !== 'string')) throw new Error('Invalid native tool search request.');
  const scope = await contained(root, path.resolve(root, params.path || '.'));
  const stat = await fs.stat(scope);
  if (stat.isFile()) return { fallback: true };
  if (!stat.isDirectory()) throw new Error('Search target is not a directory.');
  if (operation === 'grep') {
    if (!Number.isSafeInteger(params.context) || params.context < 0 || params.context > 1000 || !Number.isSafeInteger(params.max_results) || params.max_results < 1 || params.max_results > 10000 || (params.glob !== undefined && typeof params.glob !== 'string')) throw new Error('Invalid native grep limits.');
    // fff applies multiline regex semantics; ripgrep preserves the tool's line-based regex contract.
    if (!params.pattern || params.glob || /[\s\\.^$*+?()[\]{}|]/.test(params.pattern)) return { fallback: true };
  } else if (params.pattern.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Glob traversal outside the search directory is unsupported.');
  const entry = await index(scope, true), files = await allFiles(entry);
  if (!active()) throw new Error('WORKSPACE_FILE_SEARCH_CANCELLED');
  await coverage(entry, scope, files);
  if (entry.dirty) {
    if (operation === 'grep') return { fallback: true };
    throw new Error('Workspace changed during indexing; retry the glob.');
  }
  if (operation === 'glob') {
    const native = entry.equal ? value(entry.finder.glob(params.pattern, { pageSize: Math.max(1, files.length) })) : null;
    if (native && native.items.length !== native.totalMatched) throw new Error('Native glob results are incomplete.');
    const expected = entry.listed.filter(file =>
      visible(file) && !file.split('/').some(part => ['node_modules', 'dist', 'build'].includes(part)) && minimatch(file, params.pattern, { dot: false }));
    const candidates = native?.items.map(file => file.relativePath).filter(file => expected.includes(file));
    const matches = candidates?.length === expected.length ? candidates : expected;
    for (const file of matches) await contained(root, path.join(scope, file));
    const relative = matches.map(file => path.relative(root, path.join(scope, file)).replaceAll('\\', '/')).sort();
    const content = relative.length ? `Found ${relative.length} file(s):\n${relative.join('\n')}` : `No files matching "${params.pattern}" in ${path.relative(root, scope) || '.'}`;
    if (Buffer.byteLength(content) > 5 * 1024 ** 2) throw new Error('Search results exceed the 5 MiB limit. Narrow the glob.');
    return { content, engine: native && candidates.length === expected.length ? 'fff' : 'ripgrep' };
  }
  if (!entry.supported) return { fallback: true };
  const rows = new Map(), sourceLines = new Map(); let cursor;
  do {
    if (!active()) throw new Error('WORKSPACE_FILE_SEARCH_CANCELLED');
    // The zero-width prefix disables fff's query-constraint interpretation.
    const found = value(entry.finder.grep(`\\x00{0}(?u:${params.pattern})`, { mode: 'regex', smartCase: false, cursor,
      maxMatchesPerFile: params.max_results, pageSize: 200, beforeContext: params.context, afterContext: params.context }));
    if (found.regexFallbackError) throw new Error(`Regex error: ${found.regexFallbackError}`);
    for (const item of found.items) {
      if (!visible(item.relativePath) || (params.glob && !minimatch(item.relativePath, params.glob, { matchBase: !params.glob.includes('/'), dot: false }))) continue;
      const physical = await contained(root, path.resolve(scope, item.relativePath));
      const file = path.relative(root, path.join(scope, item.relativePath)).replaceAll('\\', '/');
      // fff truncates display lines at 512 bytes; source lines retain full text and CRLF.
      if (!sourceLines.has(physical)) sourceLines.set(physical, (await fs.readFile(physical, 'utf8')).split('\n'));
      const lines = sourceLines.get(physical);
      const add = (number, text, match) => {
        const key = `${file}\0${number}`, previous = rows.get(key);
        if (!previous || match) rows.set(key, { file, number, text, match });
      };
      for (let number = Math.max(1, item.lineNumber - params.context); number <= Math.min(lines.length, item.lineNumber + params.context); number++) {
        if (number === lines.length && lines[number - 1] === '' && lines.length > 1) continue;
        add(number, lines[number - 1], number === item.lineNumber);
      }
    }
    if (found.nextCursor && found.nextCursor._offset <= (cursor?._offset ?? -1)) throw new Error('Native grep pagination did not advance.');
    cursor = found.nextCursor;
    if (rows.size > 100000) throw new Error('Search results exceed the output limit. Narrow the pattern.');
    await new Promise(resolve => setImmediate(resolve));
  } while (cursor);
  const output = []; let previous;
  for (const row of [...rows.values()].sort((a, b) => a.file.localeCompare(b.file) || a.number - b.number)) {
    if (params.context && previous && (previous.file !== row.file || previous.number + 1 !== row.number)) output.push('--');
    output.push(`${row.file}${row.match ? ':' : '-'}${row.number}${row.match ? ':' : '-'}${row.text}`); previous = row;
  }
  const content = output.join('\n') || '(no matches)';
  if (entry.dirty) return { fallback: true };
  if (Buffer.byteLength(content) > 5 * 1024 ** 2) throw new Error('Search results exceed the 5 MiB limit. Narrow the pattern.');
  return { content };
}
let queue = Promise.resolve();
const latest = new Map();
const send = message => process.parentPort ? process.parentPort.postMessage(message) : process.send(message);
function receive(request) {
  if (request.invalidateRoot) {
    for (const [root, entry] of indexes) if (root === request.invalidateRoot || root.startsWith(request.invalidateRoot + path.sep)) { entry.dirty = true; entry.revision++; }
    return;
  }
  if (request.cancelSearchId) { latest.delete(request.cancelSearchId); return; }
  latest.set(request.searchId, request.id);
  queue = queue.then(async () => {
    if (latest.get(request.searchId) !== request.id) return;
    try { send({ id: request.id, result: await search({ ...request, active: () => latest.get(request.searchId) === request.id }) }); }
    catch (error) { send({ id: request.id, error: String(error.message).slice(0, 1024) }); }
    finally { if (latest.get(request.searchId) === request.id) latest.delete(request.searchId); }
  });
}
if (process.parentPort) process.parentPort.on('message', event => receive(event.data));
else process.on('message', receive);
process.on('exit', () => { for (const entry of indexes.values()) destroy(entry); });
