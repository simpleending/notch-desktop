import { verifyWorkbenchImports } from '../src/workbench-patch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebResearch } from '../src/web-research.mjs';
import { patchWebToolCatalog } from '../src/web-tools-patch.mjs';
import { patchModelPreload } from '../src/model-ipc.mjs';

test('web settings keep keys encrypted, redact IPC state and survive restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-settings-'));
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test', encryptStringAsync: async key => Buffer.from(key.split('').reverse().join('')), decryptStringAsync: async bytes => ({ result: bytes.toString().split('').reverse().join('') }) };
  try {
    const service = createWebResearch(root, { safeStorage });
    assert.equal((await service.status()).enabled, true); assert.equal((await service.status()).searchProvider, 'duckduckgo');
    await service.update({ key: 'tvly-test-only-secret', searchProvider: 'tavily', browser: 'msedge', enabled: false });
    const raw = await fs.readFile(path.join(root, 'web-research.json'), 'utf8'); assert.ok(!raw.includes('tvly-test-only-secret'));
    const fresh = createWebResearch(root, { safeStorage }); assert.equal((await fresh.configuration()).tavilyKey, 'tvly-test-only-secret');
    assert.deepEqual(await fresh.status(), { enabled: false, searchProvider: 'tavily', browser: 'msedge', hasKey: true, environmentKey: false, persistentKey: true, installing: false });
    assert.ok(!JSON.stringify(await fresh.status()).includes('tvly-test-only-secret'));
    await assert.rejects(fresh.update({ browser: 'invalid' })); await assert.rejects(fresh.update({ key: '\ninvalid' })); await assert.rejects(fresh.update({ unexpected: true }));
    await assert.rejects(fresh.update({ searchProvider: 'invalid' }));
    await fresh.update({ searchProvider: 'duckduckgo' }); assert.equal((await fresh.configuration()).tavilyKey, 'tvly-test-only-secret');
    assert.equal((await createWebResearch(root, { safeStorage }).status()).searchProvider, 'duckduckgo');
    await fresh.update({ key: null }); assert.equal((await createWebResearch(root, { safeStorage }).status()).hasKey, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('without system encryption keys stay in memory and browser installs cannot overlap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-web-session-')); let release;
  try {
    const service = createWebResearch(root, { install: () => new Promise(resolve => { release = resolve; }) });
    await service.update({ key: 'tvly-session-test-only' }); assert.equal((await service.status()).persistentKey, false);
    assert.ok(!(await fs.readFile(path.join(root, 'web-research.json'), 'utf8')).includes('tvly-session-test-only'));
    assert.equal((await createWebResearch(root).status()).hasKey, false);
    const installing = service.install(); await assert.rejects(service.install(), /already running/); release(); await installing; assert.equal((await service.status()).installing, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('web tool and settings bridges patch once and fail closed on a changed native catalog', () => {
  const original = 'const KHe=["Read","Write","Edit","Glob","Grep","Bash","WebSearch","WebFetch","ImageGen"];';
  const patched = patchWebToolCatalog(original); assert.match(patched, /"BrowserRead","BrowserInteract"/); assert.equal(patchWebToolCatalog(patched), patched); assert.throws(() => patchWebToolCatalog('changed'), /differs/);
  const bridge = patchModelPreload(''); assert.match(bridge, /web:patch=>/); assert.match(bridge, /webInstall:/); assert.equal(patchModelPreload(bridge), bridge);
});

test('packaging rejects a missing transitive renderer module before producing an installer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-renderer-modules-'));
  try {
    await fs.writeFile(path.join(root, 'workbench-skin.mjs'), "import './web-settings-view.mjs';");
    await fs.writeFile(path.join(root, 'model-menu.mjs'), 'export const ready = true;');
    await assert.rejects(verifyWorkbenchImports(root), /ENOENT/);
    await fs.writeFile(path.join(root, 'web-settings-view.mjs'), 'export const ready = true;');
    await verifyWorkbenchImports(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
