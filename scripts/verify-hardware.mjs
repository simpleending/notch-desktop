import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPackageWithOptions } from '@electron/asar';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.resolve(process.argv[2] || path.join(root, '../Free/notch-cli'));
const electron = path.resolve(process.argv[3] || path.join(root, 'release/Notch-prototype/Notch.exe'));
const reportPath = path.resolve(process.argv[4] || path.join(root, 'analysis/rust-hardware-packaging.json'));
const run = promisify(execFile);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-hardware-check-'));
for (const file of ['src/providers/windows-memory.ts', 'scripts/build-hardware.mjs', 'native/windows-hardware/Cargo.toml', 'native/windows-hardware/Cargo.lock', 'native/windows-hardware/src/main.rs']) {
  assert.deepEqual(await fs.readFile(path.join(cli, file)), await fs.readFile(path.join(root, 'vendor/notch-cli', file)), `CLI/IDE drift: ${file}`);
}
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = JSON.parse((await run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--workspaces=false', '--pack-destination', temp], { cwd: cli, windowsHide: true })).stdout)[0];
const helperName = `notch-hardware-win32-${process.arch}.exe`;
assert.ok(packed.files.some(file => file.path === `dist/native/${helperName}`));
assert.ok(packed.files.some(file => file.path === 'dist/native/THIRD-PARTY-NOTICES.txt'));
await run('tar', ['-xf', path.join(temp, packed.filename), '-C', temp], { windowsHide: true });
const packageDist = path.join(temp, 'package/dist');
const core = path.join(root, 'vendor/notch-core');
const staged = path.join(temp, 'ide');
await fs.cp(core, staged, { recursive: true });
await fs.writeFile(path.join(staged, 'package.json'), '{"type":"module"}');
const archive = path.join(temp, 'app.asar');
await createPackageWithOptions(staged, archive, { unpack: '**/*.exe' });
const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
assert.equal(await sha(path.join(packageDist, 'native', helperName)), await sha(path.join(cli, 'dist/native', helperName)));
assert.equal(await sha(path.join(core, 'native', helperName)), await sha(path.join(`${archive}.unpacked`, 'native', helperName)));

const runner = path.join(temp, 'check.mjs');
await fs.writeFile(runner, String.raw`
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [directory, mode] = process.argv.slice(2);
const original = promisify(childProcess.execFile);
const calls = [];
const wrapped = () => { throw new Error('Unexpected callback execution'); };
wrapped[promisify.custom] = async (executable, args, options) => {
  calls.push(executable);
  if (mode === 'failed' || (mode === 'fallback' && executable.includes('notch-hardware-'))) throw new Error('Injected unavailable telemetry');
  return original(executable, args, options);
};
childProcess.execFile = wrapped;
syncBuiltinESMExports();
const file = (await fs.readdir(directory)).find(name => /^windows-memory-.*.js$/.test(name));
assert.ok(file);
const { windowsMemory } = await import(pathToFileURL(path.join(directory, file)).href);
if (mode === 'failed') {
  await assert.rejects(windowsMemory(true), /unavailable telemetry/);
  await assert.rejects(windowsMemory(), /unavailable telemetry/);
  assert.equal(calls.length, 4);
  console.log(JSON.stringify({ passed: true, mode, calls }));
} else {
  const started = performance.now();
  const value = await windowsMemory(true);
  const ms = performance.now() - started;
  assert.ok(Number.isSafeInteger(value.installedMemory) && value.installedMemory > 0);
  assert.ok(value.availableVram >= 0 && value.availableVram <= value.totalVram);
  assert.equal(calls.length, mode === 'live' ? 1 : 2, 'Unexpected native failure/fallback');
  const count = calls.length;
  assert.deepEqual(await windowsMemory(), value);
  assert.equal(calls.length, count, 'Browsing should use the short-lived cache');
  await windowsMemory(true);
  assert.equal(calls.length, 2 * count, 'Safety refresh must execute a new process');
  if (directory.includes('.asar')) assert.ok(calls[0].includes('.asar.unpacked'), 'Execute outside the archive');
  console.log(JSON.stringify({ passed: true, mode, ms, value, calls }));
}
`);
const checks = [];
for (const [product, executable, directory] of [['npm-package', process.execPath, packageDist], ['ide-core', process.execPath, core], ['electron-asar', electron, archive]]) {
  for (const mode of ['live', 'fallback', 'failed']) {
    const { stdout } = await run(executable, [runner, directory, mode], { windowsHide: true, timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    checks.push({ product, ...JSON.parse(stdout) });
  }
}
const report = { passed: true, measuredAt: new Date().toISOString(), temp, package: packed.filename, helperSha256: { cli: await sha(path.join(packageDist, 'native', helperName)), ide: await sha(path.join(core, 'native', helperName)) }, checks };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, checks: checks.length, package: packed.filename, reportPath, temp }));
