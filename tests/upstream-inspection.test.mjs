import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { inspectCode, inspectInstallation } from '../src/upstream-inspection.mjs';
test('static integration-point discovery records occurrences and missing patterns', () => {
  const report = inspectCode('requireAccountId(){return local} requireAccountId(){return cloud}');
  assert.equal(report.localAccountGate.offsets.length, 2);
  assert.deepEqual(report.jobToken.offsets, []);
});
test('archive inspection reads packaged code without modifying the installation', async () => {
  const installation = await mkdtemp(path.join(os.tmpdir(), 'notch-upstream-'));
  try {
    const resources = path.join(installation, 'resources'), fixture = path.join(installation, 'fixture');
    await mkdir(path.join(fixture, 'out/main'), { recursive: true }); await mkdir(resources);
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ dependencies: { '@qoder-ai/qoder-agent-sdk': 'fixture' } }));
    await writeFile(path.join(fixture, 'out/main/index.js'), 'class Example{requireAccountId(){return null}}');
    await writeFile(path.join(resources, 'product.json'), JSON.stringify({ displayName: 'Fixture' }));
    await writeFile(path.join(resources, 'build-manifest.json'), JSON.stringify({ productVersion: '1.0.0' }));
    const archive = path.join(resources, 'app.asar'); await createPackage(fixture, archive);
    const before = await readFile(archive), report = await inspectInstallation(installation);
    assert.equal(report.product.displayName, 'Fixture'); assert.equal(report.sdk, 'fixture');
    assert.equal(report.integrationPoints.localAccountGate.offsets.length, 1);
    assert.deepEqual(report.missingUnpacked, []); assert.deepEqual(await readFile(archive), before);
  } finally { await rm(installation, { recursive: true, force: true }); }
});
