import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { installLocalFeatures } from '../src/local-feature-bundles.mjs';
const { openLibrary, activate } = createRequire(import.meta.url)('../src/local-features.cjs');

test('local libraries persist literal text, reject stale edits/deletes, and keep failed writes intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-local-library-'));
  let library = openLibrary(root), other;
  try {
    const original = library.save({ title: 'Read me', body: '<script>never executed</script>\nGemma reference 100%_literal' });
    assert.equal(library.list({ query: 'GEMMA' }).documents[0].id, original.id);
    assert.equal(library.list({ query: '%_literal' }).documents.length, 1);
    assert.equal(library.list({ query: "' OR 1=1 --" }).documents.length, 0);
    other = openLibrary(root);
    const saved = other.save({ ...original, body: 'Updated locally' });
    assert.throws(() => library.save({ ...original, body: 'Stale window' }), /changed in another window/);
    assert.throws(() => library.remove(original), /changed or was removed/);
    assert.equal(library.read({ id: original.id }).body, 'Updated locally');
    assert.throws(() => library.save({ title: 'Too big', body: 'a'.repeat(2 * 1024 * 1024 + 1) }), /Invalid document text/);
    assert.throws(() => library.read({ id: '../../outside' }), /Invalid document ID/);
    assert.throws(() => library.save({ title: '', body: 'bad' }), /Invalid title/);
    other.close(); other = null; library.close(); library = openLibrary(root);
    assert.deepEqual(library.read({ id: saved.id }), saved);
    library.remove(saved); assert.equal(library.list().documents.length, 0);
    assert.throws(() => library.read({ id: saved.id }), /no longer exists/);
  } finally { other?.close(); library.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('knowledge, sites, and index services activate without authentication or network access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-local-plugins-'));
  try {
    for (const kind of ['knowledge', 'sites', 'index']) {
      let service, disposed = false;
      const context = { storagePath: path.join(root, kind), subscriptions: [], api: {
        get auth() { throw Error('Authentication must never be read'); },
        node: { registerService(value) { service = value; return { dispose() { disposed = true; } }; } },
        workspace: { listProjects: async () => [{ id: 'project', name: 'Local project' }] },
      } };
      await activate(context, kind);
      if (kind === 'index') assert.equal((await service.methods.snapshot()).projects[0].name, 'Local project');
      else {
        const row = service.methods.save({ title: 'No account', body: 'Local only' });
        assert.equal(service.methods.read({ id: row.id }).body, 'Local only');
      }
      context.subscriptions.forEach(item => item.dispose()); assert.equal(disposed, true);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('packaging replaces all account-backed plugin entrypoints and permissions repeatably', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-local-bundles-'));
  try {
    for (const id of ['notch.knowledge.center', 'notch.sites', 'notch.index-settings']) {
      const folder = path.join(root, id);
      for (const directory of ['.notch-app-plugin', 'dist/node', 'dist/browser']) await fs.mkdir(path.join(folder, directory), { recursive: true });
      await fs.writeFile(path.join(folder, '.notch-app-plugin/plugin.json'), JSON.stringify({ id, main: 'old.cjs', permissions: ['auth.readState','auth.readUserToken'], contributes: { views: [{ id: 'view', entry: 'old.cjs' }], notchAgentSdk: { plugins: ['cloud-cli'] }, filePreviewers: ['cloud'] } }));
    }
    await installLocalFeatures(root); await installLocalFeatures(root);
    for (const id of ['notch.knowledge.center', 'notch.sites', 'notch.index-settings']) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, id, '.notch-app-plugin/plugin.json'), 'utf8'));
      assert.ok(manifest.permissions.every(permission => !permission.startsWith('auth.') && !permission.startsWith('telemetry.')));
      assert.equal(manifest.main, 'dist/node/local-main.cjs');
      assert.equal(manifest.contributes.views[0].entry, 'dist/browser/local-view.cjs');
      assert.equal(manifest.contributes.notchAgentSdk, undefined);
      assert.equal(manifest.contributes.filePreviewers, undefined);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
