import { parseArgs } from 'node:util';
import { cp, mkdir, writeFile, readFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAll, createPackageWithOptions } from '@electron/asar';
import { inspectInstallation } from '../src/upstream-inspection.mjs';
import { patchWorkbench, rebrandWorkbenchText } from '../src/bundle-patch.mjs';
import { readdir } from 'node:fs/promises';
import { rebrandTree } from '../src/rebrand-tree.mjs';
import { installSetupRenderer } from '../src/renderer-patch.mjs';
import { rebuildPluginCatalog, verifyPluginCatalog } from '../src/plugin-integrity.mjs';
import { installLocalFeatures } from '../src/local-feature-bundles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { installation: { type: 'string' }, output: { type: 'string' } } });
if (!values.installation) throw new Error('Specify --installation /path/to/installed/app.');
const installation = path.resolve(values.installation), output = path.resolve(values.output || path.join(root, 'release', 'Notch-prototype'));
if (output === installation || output.startsWith(installation + path.sep) || installation.startsWith(output + path.sep)) throw new Error('Choose an output directory separate from the installed application.');
try { await access(output); throw new Error('Output already exists. Choose a new directory to preserve the previous build.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const inspection = await inspectInstallation(installation);
if (inspection.archiveSha256 !== 'e1c9f8eaa1edcdaffc42f2cf12d4f879702eb924c1109219801dbc12d848ae28') throw new Error('Upstream archive differs from the inspected baseline. Inspect and update the port before building.');
if (inspection.manifest.platform !== process.platform || inspection.manifest.arch !== process.arch) throw new Error('Build on the matching platform and architecture.');
const kernel = path.join(root, 'node_modules', 'electron', 'dist');
await access(path.join(kernel, 'electron.exe'));
await cp(kernel, output, { recursive: true }); await rename(path.join(output, 'electron.exe'), path.join(output, 'Notch.exe'));
const resources = path.join(output, 'resources'), application = path.join(output, 'build-app');
await mkdir(application, { recursive: true });
try { extractAll(path.join(installation, 'resources', 'app.asar'), application); }
catch (error) { if (!String(error.message).startsWith('Unable to extract some files:') || inspection.missingUnpacked.length !== 15) throw error; }
for (const file of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node']) await access(path.join(application, file));
await cp(path.join(root, 'src'), path.join(application, 'notch/src'), { recursive: true });
await cp(path.join(root, 'vendor/notch-core'), path.join(application, 'notch/vendor/notch-core'), { recursive: true });
for (const [name] of Object.entries(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies)) {
  if (name === '@freesyntax/notch-cli') continue;
  await cp(path.join(root, 'node_modules', name), path.join(application, 'node_modules', name), { recursive: true });
}
// Include transitive runtime packages used by the shared CLI dependencies.
await cp(path.join(root, 'node_modules'), path.join(application, 'notch/node_modules'), { recursive: true,
  filter: source => !/[/\\](?:electron|@electron|typescript|tsup|esbuild|@esbuild)(?:[/\\]|$)/.test(source) });
const mainFile = path.join(application, 'out/main/index.js');
const patched = patchWorkbench(await readFile(mainFile, 'utf8')); await writeFile(mainFile, patched.source);
async function rebrandDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await rebrandDirectory(file);
    else if (/\.(?:js|cjs|mjs|html|css)$/.test(entry.name)) {
      const source = await readFile(file, 'utf8'), branded = rebrandWorkbenchText(source);
      if (branded !== source) await writeFile(file, branded);
    }
  }
}
await rebrandDirectory(path.join(application, 'out'));
const packageFile = path.join(application, 'package.json'), pkg = JSON.parse(await readFile(packageFile, 'utf8'));
pkg.name = 'notch-desktop'; pkg.version = '0.1.0'; pkg.description = 'Notch local coding workbench'; pkg.main = './notch-bootstrap.mjs'; pkg.homepage = 'https://freesyntax.dev'; pkg.author = { name: 'Driftrail' };
await writeFile(packageFile, JSON.stringify(pkg, null, 2));
await writeFile(path.join(application, 'notch-bootstrap.mjs'), "await import('./notch/src/app-bootstrap.mjs');\n");
const product = { ...inspection.product, displayName: 'Notch', electronApplicationName: 'Notch', appId: 'com.freesyntax.notch.desktop', dataDirectoryName: 'com.freesyntax.notch.desktop', packageName: 'notch-desktop', protocolScheme: 'notch', windowsLauncherDirectory: 'Notch/Launcher', windowsLauncherFileName: 'Notch Launcher.exe', windowsLauncherMutexName: 'Local/NotchDesktopLauncher' };
await writeFile(path.join(resources, 'product.json'), rebrandWorkbenchText(JSON.stringify(product, null, 2)));
await writeFile(path.join(resources, 'build-manifest.json'), rebrandWorkbenchText(JSON.stringify({ ...inspection.manifest, product: 'notch', productVersion: '0.1.0', electronVersion: '43.7.9' }, null, 2)));
for (const name of ['application-icons', 'bundled-resources', 'dynamic-text', 'extensions', 'bin', 'node-repl', 'tray', 'native-messaging-host', 'app-icon.ico']) {
  const source = path.join(installation, 'resources', name); try { await access(source); await cp(source, path.join(resources, name), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await rebrandTree(application);
await installSetupRenderer(application, root);
for (const name of ['extensions','dynamic-text','bundled-resources','application-icons']) await rebrandTree(path.join(resources, name));
await installLocalFeatures(path.join(resources, 'extensions'));
await rebuildPluginCatalog(path.join(resources, 'extensions'));
await verifyPluginCatalog(path.join(resources, 'extensions'));
await createPackageWithOptions(application, path.join(resources, 'app.asar'), { unpack: '**/*.{node,dll,exe,so,dylib}', unpackDir: '**/{@ff-labs,ffi-rs,@yuuang}' });
await writeFile(path.join(output, 'prototype-build.json'), JSON.stringify({ version: '0.1.0', baseline: inspection.archiveSha256, methodPatches: patched.changes, missingUpstreamFiles: inspection.missingUnpacked,
  limitations: ['Development prototype; full branding and compatibility migration remain in progress.', 'Not yet a signed production release or verified performance-parity build.'] }, null, 2));
console.log(JSON.stringify({ output, executable: path.join(output, 'Notch.exe'), patchedMethods: patched.changes.length }));
