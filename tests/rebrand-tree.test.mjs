import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { rebrandTree } from '../src/rebrand-tree.mjs';
test('module references and file names are renamed together with lowercase branding', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notch-brand-'));
  try {
    await mkdir(path.join(directory, '@qoder-ai'));
    await writeFile(path.join(directory, '@qoder-ai/qoder-sdk.js'), 'export const title="Qoder";');
    await writeFile(path.join(directory, 'index.js'), 'import {title} from "./@qoder-ai/qoder-sdk.js";');
    await writeFile(path.join(directory, 'NOTICE.txt'), 'Original Qoder attribution.');
    await rebrandTree(directory);
    assert.equal(await readFile(path.join(directory, '@notch-ai/notch-sdk.js'), 'utf8'), 'export const title="notch";');
    assert.match(await readFile(path.join(directory, 'index.js'), 'utf8'), /@notch-ai\/notch-sdk/);
    assert.equal(await readFile(path.join(directory, 'NOTICE.txt'), 'utf8'), 'Original Qoder attribution.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
