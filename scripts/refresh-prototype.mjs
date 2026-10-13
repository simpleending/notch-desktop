import { readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, createPackageWithOptions } from '@electron/asar';
import { patchWorkbench, rebrandWorkbenchText } from '../src/bundle-patch.mjs';
import { inspectInstallation } from '../src/upstream-inspection.mjs';
import { rebrandTree } from '../src/rebrand-tree.mjs';
const output = path.resolve(process.argv[2] || 'release/Notch-prototype');
const marker = JSON.parse(await readFile(path.join(output, 'prototype-build.json'), 'utf8'));
if (marker.baseline !== 'e1c9f8eaa1edcdaffc42f2cf12d4f879702eb924c1109219801dbc12d848ae28') throw new Error('This is not a verified Notch prototype build.');
const installation = process.argv[3]; if (!installation) throw new Error('Provide the original installation path after the output directory.');
if ((await inspectInstallation(installation)).archiveSha256 !== marker.baseline) throw new Error('The upstream installation changed; inspect it before refreshing.');
const application = path.join(output, 'build-app');
const original = extractFile(path.join(path.resolve(installation), 'resources/app.asar'), path.join('out','main','index.js')).toString('utf8');
const patched = patchWorkbench(original); await writeFile(path.join(application, 'out/main/index.js'), patched.source);
async function rebrand(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await rebrand(file);
    else if (/\.(?:js|cjs|mjs|html|css)$/.test(file)) {
      const source = await readFile(file, 'utf8'), replacement = rebrandWorkbenchText(source);
      if (replacement !== source) await writeFile(file, replacement);
    }
  }
}
await rebrand(path.join(application, 'out'));
await cp('src', path.join(application, 'notch/src'), { recursive: true });
await writeFile(path.join(application, 'notch-bootstrap.mjs'), "await import('./notch/src/app-bootstrap.mjs');\n");
await cp('vendor/notch-core', path.join(application, 'notch/vendor/notch-core'), { recursive: true });
await rebrandTree(application);
const productFile = path.join(output, 'resources/product.json');
const product = JSON.parse(await readFile(productFile, 'utf8'));
await writeFile(productFile, rebrandWorkbenchText(JSON.stringify({ ...product, displayName: 'notch', electronApplicationName: 'notch', productId: 'notch' }, null, 2)));
await writeFile(path.join(output, 'resources/build-manifest.json'), rebrandWorkbenchText(await readFile(path.join(output, 'resources/build-manifest.json'), 'utf8')));
for (const name of ['extensions','dynamic-text','bundled-resources','application-icons']) {
  await rebrandTree(path.join(output, 'resources', name));
}
await createPackageWithOptions(application, path.join(output, 'resources/app.asar'), { unpack: '**/*.{node,dll,exe,so,dylib}' });
await writeFile(path.join(output, 'prototype-build.json'), JSON.stringify({ ...marker, methodPatches: patched.changes }, null, 2));
console.log(JSON.stringify({ output, patchedMethods: patched.changes.length }));
