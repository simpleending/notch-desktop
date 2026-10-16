import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./', import.meta.url));
/** Replace account-backed entrypoints before the normal build-time integrity catalog is generated. */
export async function installLocalFeatures(extensions) {
  for (const [id, kind] of [['notch.knowledge.center', 'knowledge'], ['notch.sites', 'sites'], ['notch.index-settings', 'index']]) {
    const folder = path.join(extensions, id), manifestFile = path.join(folder, '.notch-app-plugin/plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (manifest.id !== id) throw new Error(`Local feature manifest mismatch: ${id}`);
    manifest.permissions = ['node.callService', ...(kind === 'knowledge' ? ['chat.createSession', 'chat.revealSession'] : []), ...(kind === 'index' ? ['workspace.readProjects'] : [])];
    delete manifest.contributes.notchAgentSdk;
    delete manifest.contributes.filePreviewers;
    for (const view of manifest.contributes.views) view.entry = 'dist/browser/local-view.cjs';
    manifest.main = 'dist/node/local-main.cjs';
    await fs.copyFile(path.join(source, 'local-features.cjs'), path.join(folder, 'dist/node/local-features.cjs'));
    await fs.writeFile(path.join(folder, 'dist/node/local-main.cjs'), `exports.activate = context => require('./local-features.cjs').activate(context,${JSON.stringify(kind)});\n`);
    await fs.copyFile(path.join(source, 'local-features-view.cjs'), path.join(folder, 'dist/browser/local-view.cjs'));
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  }
  // These contributions require the retired marketplace, pet service, or proprietary scanning runtime.
  for (const id of ['notch.find-extensions', 'notch.desktop-pet-skill', 'notch.security']) {
    const manifestFile = path.join(extensions, id, '.notch-app-plugin/plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.activationEvents = []; manifest.permissions = []; manifest.contributes = {};
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  }
}
