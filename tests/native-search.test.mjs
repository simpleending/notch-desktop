import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createWorkspaceSearch } from '../src/workspace-search.mjs';
import { grepTool } from '../vendor/notch-cli/src/tools/grep.ts';
import { globTool } from '../vendor/notch-cli/src/tools/glob.ts';

async function fixture(t, execArgv = []) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-native-'));
  assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
  const service = createWorkspaceSearch(() => {
    const child = fork(fileURLToPath(new URL('../src/workspace-search-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv });
    child.postMessage = message => child.send(message); return child;
  });
  t.after(async () => { await service.shutdown(); await fs.rm(cwd, { recursive: true, force: true }); });
  const ctx = { cwd, workspaceSearch: (operation, params, root, signal) => service.tool(operation, root, params, signal) };
  const grep = params => grepTool.execute(grepTool.parameters.parse(params), ctx);
  const glob = params => globTool.execute(globTool.parameters.parse(params), ctx);
  return { cwd, service, ctx, grep, glob };
}

function lines(output) { return output === '(no matches)' ? [] : output.replace(/\n$/, '').split('\n').filter(line => line !== '--').map(line => line.replaceAll('\\', '/')).sort(); }

test('native grep pages retain every match, full long lines, Unicode and overlapping CRLF context', async t => {
  const { cwd, service, grep } = await fixture(t);
  await Promise.all(Array.from({ length: 220 }, (_, i) => fs.writeFile(path.join(cwd, `file-${i}.ts`), 'NEEDLE\n')));
  const long = 'x'.repeat(600) + 'NEEDLE';
  await fs.writeFile(path.join(cwd, 'long.ts'), `before\r\n${long}\r\nNEEDLE\r\nafter\r\n`);
  await fs.writeFile(path.join(cwd, 'unicode.ts'), '你好\né\n');
  const result = await grep({ pattern: 'NEEDLE', context: 1 });
  assert.equal(result.isError, undefined, result.content);
  assert.equal(service.engine, 'fff');
  assert.ok(result.content.includes(long + '\r'));
  const expected = await promisify(execFile)('rg', ['--no-require-git', '--no-heading', '-n', '--color=never', '-C', '1', '--max-count=50', '--', 'NEEDLE', cwd], { encoding: 'utf8' });
  assert.deepEqual(lines(result.content), lines(expected.stdout.replaceAll(cwd + path.sep, '')));
  assert.ok((await grep({ pattern: '你好' })).content.includes('unicode.ts:1:你好'));
  assert.equal(service.engine, 'fff');
});

test('native glob and grep honor gitignore without Git metadata and support explicit ignored targets', async t => {
  const { cwd, service, grep, glob } = await fixture(t);
  await fs.mkdir(path.join(cwd, 'ignored'));
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored/\nsecret.ts\n');
  await fs.writeFile(path.join(cwd, 'ignored', 'private.ts'), 'SECRET\n');
  await fs.writeFile(path.join(cwd, 'secret.ts'), 'SECRET\n');
  await fs.writeFile(path.join(cwd, 'a.ts'), 'PUBLIC\n');
  await fs.writeFile(path.join(cwd, 'b.ts'), 'PUBLIC\n');
  assert.deepEqual(await grep({ pattern: 'SECRET' }), { content: '(no matches)' });
  assert.equal(service.engine, 'fff');
  const found = await glob({ pattern: '**/*.ts' });
  assert.deepEqual(found, { content: 'Found 2 file(s):\na.ts\nb.ts' });
  assert.equal(service.engine, 'fff');
  assert.deepEqual(await glob({ pattern: '@(a|b).ts' }), found);
  assert.equal(service.engine, 'ripgrep');
  assert.ok((await grep({ pattern: 'SECRET', path: 'secret.ts' })).content.includes('SECRET'));
  assert.equal(service.engine, 'ripgrep');
  assert.ok((await grep({ pattern: 'SECRET', path: 'ignored' })).content.includes('private.ts:1:SECRET'));
});

test('compatibility route preserves whitespace, regex semantics, glob overrides and unsupported encodings', async t => {
  const { cwd, service, grep } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.ts'), 'foo  bar\nfoo\nbar\né\n');
  let result = await grep({ pattern: 'foo  bar' });
  assert.ok(result.content.includes('foo  bar')); assert.equal(service.engine, 'ripgrep');
  assert.equal((await grep({ pattern: '(?s)foo.*bar' })).content, `${path.join(cwd, 'a.ts')}:1:foo  bar\n`);
  assert.ok((await grep({ pattern: '^\\w+$' })).content.includes('é'));
  assert.equal(service.engine, 'ripgrep');
  assert.equal((await grep({ pattern: '(?=foo)foo' })).isError, true);
  await fs.writeFile(path.join(cwd, '.gitignore'), 'ignored.ts\n');
  await fs.writeFile(path.join(cwd, 'ignored.ts'), 'OVERRIDE\n');
  assert.ok((await grep({ pattern: 'OVERRIDE', glob: '*.ts' })).content.includes('ignored.ts'));
  await fs.writeFile(path.join(cwd, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ENCODED\n', 'utf16le')]));
  await fs.writeFile(path.join(cwd, 'text.bin'), 'ENCODED\n');
  service.invalidate(cwd);
  result = await grep({ pattern: 'ENCODED' });
  assert.ok(result.content.includes('utf16.txt')); assert.ok(result.content.includes('text.bin'));
  assert.equal(service.engine, 'ripgrep');
});

test('index invalidation makes edits and ignore changes visible immediately; outside targets fail closed', async t => {
  const { cwd, service, grep, glob } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.ts'), 'OLD\n');
  assert.ok((await grep({ pattern: 'OLD' })).content.includes('OLD'));
  await fs.appendFile(path.join(cwd, 'a.ts'), 'NEW\n'); service.invalidate(cwd);
  assert.ok((await grep({ pattern: 'NEW' })).content.includes('a.ts:2:NEW'));
  await fs.writeFile(path.join(cwd, '.gitignore'), 'a.ts\n'); service.invalidate(cwd);
  assert.equal((await grep({ pattern: 'NEW' })).content, '(no matches)');
  assert.equal((await glob({ pattern: '*.ts' })).content, 'No files matching "*.ts" in .');
  const denied = await grep({ pattern: 'anything', path: '..' });
  assert.equal(denied.isError, true); assert.match(denied.content, /outside/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.tool('grep', cwd, { pattern: 'NEW', context: 0, max_results: 50 }, controller.signal));
});

test('native enumeration stays complete when ignore rescans reset the progress counter', async t => {
  const preload = `
    import { FileFinder } from ${JSON.stringify(import.meta.resolve('@ff-labs/fff-node'))};
    const scanFiles = FileFinder.prototype.scanFiles, getScanProgress = FileFinder.prototype.getScanProgress;
    let rescanned = false;
    FileFinder.prototype.scanFiles = function () { rescanned = true; return scanFiles.call(this); };
    FileFinder.prototype.getScanProgress = function () {
      const result = getScanProgress.call(this);
      return rescanned && result.ok ? { ...result, value: { ...result.value, scannedFilesCount: 0 } } : result;
    };
  `;
  const { cwd, service, grep, glob } = await fixture(t, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]);
  await Promise.all(Array.from({ length: 220 }, (_, i) => fs.writeFile(path.join(cwd, `file-${i}.ts`), 'MARKER\n')));
  await fs.writeFile(path.join(cwd, '.gitignore'), '');
  assert.equal(lines((await grep({ pattern: 'MARKER' })).content).length, 220);
  await fs.appendFile(path.join(cwd, 'file-0.ts'), 'FRESH\n'); service.invalidate(cwd);
  assert.ok((await grep({ pattern: 'FRESH' })).content.includes('file-0.ts:2:FRESH'));
  await fs.writeFile(path.join(cwd, '.gitignore'), 'file-0.ts\n'); service.invalidate(cwd);
  assert.equal((await grep({ pattern: 'FRESH' })).content, '(no matches)');
  assert.equal(lines((await grep({ pattern: 'MARKER' })).content).length, 219);
  const found = await glob({ pattern: '**/*' });
  assert.equal(found.isError, undefined, found.content);
  assert.match(found.content, /^Found 219 file\(s\):/);
  assert.doesNotMatch(found.content, /file-0\.ts|\.gitignore/);
});
