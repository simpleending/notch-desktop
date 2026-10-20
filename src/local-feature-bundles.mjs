import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiMessage } from './ui-messages.mjs';
import { patchUiMessages, assertProductMessages } from './ui-message-patch.mjs';

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
    const view = await fs.readFile(path.join(source, 'local-features-view.cjs'), 'utf8');
    await fs.writeFile(path.join(folder, 'dist/browser/local-view.cjs'), `const uiMessage = ${uiMessage.toString()};\n${view}`);
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  }
  // These contributions require the retired marketplace, pet service, or proprietary scanning runtime.
  for (const id of ['notch.find-extensions', 'notch.desktop-pet-skill', 'notch.security']) {
    const manifestFile = path.join(extensions, id, '.notch-app-plugin/plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.activationEvents = []; manifest.permissions = []; manifest.contributes = {};
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  }
  // These built-in previews have their own isolated React bundles, outside the workbench renderer.
  for (const [id, entry] of [['notch.canvas', 'view.cjs'], ['notch.office', 'index.cjs']]) {
    const file = path.join(extensions, id, 'dist/browser', entry);
    let view;
    try { view = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (id === 'notch.canvas' && !view.includes('state.kind === "compile-error" ? state.message')) {
      const anchor = /description:\s*state\.message\b/gu;
      if ([...view.matchAll(anchor)].length !== 1) throw Error('The Canvas error display differs from the expected version.');
      view = view.replace(anchor, 'description: state.kind === "compile-error" ? state.message : uiMessage(state.message)');
    }
    view = patchUiMessages(view).replace('import { uiMessage } from "./ui-messages.mjs";\n', '');
    const helper = `/* notch product messages */\nconst uiMessage = ${uiMessage.toString()};\n/* end notch product messages */\n`;
    if (view.includes('/* notch product messages */')) view = view.replace(/\/\* notch product messages \*\/[\s\S]*?\/\* end notch product messages \*\//u, helper.trimEnd());
    else {
      const directive = view.match(/^(?:"use strict"|'use strict');\s*/u)?.[0] ?? '';
      view = directive + helper + view.slice(directive.length);
    }
    assertProductMessages(view, id);
    await fs.writeFile(file, view);
  }
}
