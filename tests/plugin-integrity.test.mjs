import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { rebuildPluginCatalog, verifyPluginCatalog } from '../src/plugin-integrity.mjs';
import { validateLocalPlugin } from '../src/plugin-validation.mjs';

test('final branded manifests and every bundled file receive hashes; later tampering is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-plugin-integrity-'));
  try {
    const folder = path.join(root, 'notch.fixture'); await fs.mkdir(path.join(folder, '.notch-app-plugin'), { recursive: true });
    const manifest = { id: 'notch.fixture', version: '1.0.0', main: 'main.cjs' };
    await fs.writeFile(path.join(folder, '.notch-app-plugin/plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(folder, 'main.cjs'), 'module.exports={name:"notch"}');
    await fs.writeFile(path.join(root, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, productId: 'notch', profile: 'stable', plugins: [{ id: manifest.id, version: manifest.version, root: 'notch.fixture', manifest: {}, files: [] }] }));
    assert.deepEqual(await rebuildPluginCatalog(root), { plugins: 1, files: 2 });
    assert.deepEqual(await verifyPluginCatalog(root), { plugins: 1, files: 2 });
    await fs.writeFile(path.join(folder, 'main.cjs'), 'tampered');
    await assert.rejects(verifyPluginCatalog(root), /file integrity failed/);
    await rebuildPluginCatalog(root); await fs.writeFile(path.join(folder, 'unlisted.cjs'), 'extra');
    await assert.rejects(verifyPluginCatalog(root), /file integrity failed/);
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog.v1.json'), 'utf8')); catalog.plugins[0].root = '../escape';
    await fs.writeFile(path.join(root, 'catalog.v1.json'), JSON.stringify(catalog));
    await assert.rejects(rebuildPluginCatalog(root), /Invalid plugin catalog path/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('replacement plugin validation checks manifests and component paths without running plugin code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-plugin-validator-'));
  try {
    await fs.mkdir(path.join(root, '.notch-plugin')); await fs.mkdir(path.join(root, 'skills'));
    const manifest = { name: 'fixture', version: '1.0.0', skills: './skills', mcpServers: './mcp.json' };
    await fs.writeFile(path.join(root, '.notch-plugin/plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'never-executed', args: ['literal'] } } }));
    assert.equal((await validateLocalPlugin(root)).valid, true);
    manifest.skills = '../outside'; await fs.writeFile(path.join(root, '.notch-plugin/plugin.json'), JSON.stringify(manifest));
    const invalid = await validateLocalPlugin(root); assert.equal(invalid.valid, false); assert.match(invalid.diagnostics[0].message, /escaped/);
    await fs.writeFile(path.join(root, '.notch-plugin/plugin.json'), '{invalid'); assert.equal((await validateLocalPlugin(root)).valid, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
