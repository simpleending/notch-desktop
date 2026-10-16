import { app, session, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateBrandDatabase } from './brand-migration.mjs';
import { createHost } from './notch-host.mjs';
import { createWebResearch } from './web-research.mjs';
import { createModelManager } from './model-manager.mjs';
import { registerModelIpc } from './model-ipc.mjs';
import { createStartupDiscovery } from './startup-discovery.mjs';
import { createLocalVoice } from './local-voice.mjs';
import { createLocalLiveVoice } from './local-live-voice.mjs';
import { managedOllama } from '../vendor/notch-core/desktop-harness.js';
app.setName('notch');
globalThis.__notchDiscovery = createStartupDiscovery();
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', requestedProfile ? path.resolve(requestedProfile) : path.join(app.getPath('appData'), 'com.freesyntax.notch.desktop'));
globalThis.__notchProfileOverride = requestedProfile ? { directory: app.getPath('userData'), existed: existsSync(path.join(app.getPath('userData'), 'main.sqlite')) } : null;
globalThis.__notchHost = createHost(app.getPath('userData'));
globalThis.__notchHost.runtimeReady = managedOllama('0.40.3', globalThis.__notchDiscovery.signal, false).catch(() => {});
globalThis.__notchHost.voice = createLocalVoice(app.getPath('userData'));
globalThis.__notchHost.createLiveVoice = createLocalLiveVoice;
app.on('will-quit', () => { void globalThis.__notchHost.voice.shutdown(); });
app.on('will-quit', () => { void globalThis.__notchHost.workspaceSearch.shutdown(); });
const databasePath = path.join(app.getPath('userData'), 'main.sqlite');
if (existsSync(databasePath)) { const database = new DatabaseSync(databasePath); try { migrateBrandDatabase(database); } finally { database.close(); } }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://disabled.notch.invalid/*'] }, (_details, callback) => callback({ cancel: true })));
app.whenReady().then(() => {
  globalThis.__notchHost.modelManager = createModelManager(app.getPath('userData'), { safeStorage });
  globalThis.__notchHost.webResearch = createWebResearch(app.getPath('userData'), { safeStorage, signal: globalThis.__notchDiscovery.signal });
  registerModelIpc(ipcMain,globalThis.__notchHost);
});
globalThis.__notchHost.listModels().catch(() => {});
try { await import('../../out/main/index.js'); }
catch (error) {
  const message = String(error.stack || error).slice(0, 32000);
  writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), message, { mode: 0o600 });
  console.error(message); app.exit(1);
}
