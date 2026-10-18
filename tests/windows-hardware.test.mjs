import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { localContextProfile } from '../src/model-policy.mjs';
import { modelFit } from '../vendor/notch-core/desktop-harness.js';

test('Rust and PowerShell telemetry preserve IDE fit decisions at exact memory boundaries', { skip: process.platform !== 'win32' }, async () => {
  const GiB = 2 ** 30;
  const original = childProcess.execFile;
  let forceFallback = false, raw;
  const wrapped = () => { throw new Error('Unexpected callback execution'); };
  wrapped[promisify.custom] = async executable => {
    if (forceFallback && executable.includes('notch-hardware-')) throw new Error('Missing helper');
    return { stdout: JSON.stringify(raw), stderr: '' };
  };
  childProcess.execFile = wrapped;
  syncBuiltinESMExports();
  try {
    const name = (await readdir(new URL('../vendor/notch-core/', import.meta.url))).find(name => /^windows-memory-.*\.js$/.test(name));
    const { windowsMemory } = await import(`../vendor/notch-core/${name}`);
    const model = { bytes: 3 * GiB };
    const metadata = { capabilities: ['tools'], model_info: { 'general.architecture': 'test', 'test.context_length': 16384, 'test.block_count': 32, 'test.attention.head_count_kv': 4, 'test.attention.key_length': 128, 'test.attention.value_length': 128 } };
    // Required weights + overhead + the 1 GiB reserve, immediately around a fit boundary.
    const boundary = model.bytes * 1.2 + 2.5 * GiB;
    for (const installed of [16 * GiB, 32 * GiB]) {
      for (const [dedicated, used] of [[0, 0], [16 * GiB, 5 * GiB], [16 * GiB, 20 * GiB]]) {
        raw = { schemaVersion: 1, installedMemory: installed, dedicatedMemory: dedicated, dedicatedUsage: used };
        forceFallback = false; const native = await windowsMemory(true);
        forceFallback = true; const legacy = await windowsMemory(true);
        assert.deepEqual(native, legacy);
        for (const available of [0, GiB, boundary - 1, boundary, boundary + 1, 12 * GiB]) {
          const hardware = { totalMemory: 16 * GiB, availableMemory: available, appleSilicon: false };
          assert.deepEqual(modelFit(model, { ...hardware, ...native }), modelFit(model, { ...hardware, ...legacy }));
          assert.deepEqual(localContextProfile(model.bytes, { ...hardware, ...native }, metadata), localContextProfile(model.bytes, { ...hardware, ...legacy }, metadata));
          if (used >= dedicated) assert.equal(modelFit(model, { ...hardware, ...native }).fits, available >= boundary);
        }
      }
    }
  } finally { childProcess.execFile = original; syncBuiltinESMExports(); }
});

test('CLI and IDE share the same Rust probe and adapter source', async () => {
  const cli = new URL('../../Free/notch-cli/', import.meta.url);
  for (const relative of ['src/providers/windows-memory.ts', 'scripts/build-hardware.mjs', 'native/windows-hardware/Cargo.toml', 'native/windows-hardware/Cargo.lock', 'native/windows-hardware/src/main.rs']) {
    // Standalone desktop checkouts have their own vendored source and do not require the monorepo.
    const other = await readFile(new URL(relative, cli)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (other) assert.deepEqual(await readFile(new URL(`../vendor/notch-cli/${relative}`, import.meta.url)), other, relative);
  }
});
