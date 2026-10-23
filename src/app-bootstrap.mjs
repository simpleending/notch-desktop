import { app, session, ipcMain, safeStorage, shell, dialog } from 'electron';
import path from 'node:path';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateBrandDatabase } from './brand-migration.mjs';
import { createHost } from './notch-host.mjs';
import { createWebResearch } from './web-research.mjs';
import { createModelManager } from './model-manager.mjs';
import { registerModelIpc } from './model-ipc.mjs';
import { createStartupDiscovery } from './startup-discovery.mjs';
import { createLocalVoice } from './local-voice.mjs';
import { createLocalLiveVoice } from './local-live-voice.mjs';
import { createAppUpdater } from './app-updater.mjs';
import { createPhoneCompanion } from './phone-companion.mjs';
import { createGitHubAuth } from './github-auth.mjs';
import { createOriginGit } from './origin-git.mjs';
import { originGitEnv } from '@freesyntax/notch-cli/dist/origin-auth.js';
import { createRequire } from 'node:module';
import { managedOllama } from '../vendor/notch-core/desktop-harness.js';
app.setName('notch');
if (process.platform === 'win32') app.setAppUserModelId(JSON.parse(readFileSync(path.join(process.resourcesPath, 'product.json'), 'utf8')).appId);
globalThis.__notchDiscovery = createStartupDiscovery();
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', requestedProfile ? path.resolve(requestedProfile) : path.join(app.getPath('appData'), 'com.freesyntax.notch.desktop'));
globalThis.__notchProfileOverride = requestedProfile ? { directory: app.getPath('userData'), existed: existsSync(path.join(app.getPath('userData'), 'main.sqlite')) } : null;
globalThis.__notchHost = createHost(app.getPath('userData'));
globalThis.__notchHost.runtimeReady = managedOllama('0.40.3', globalThis.__notchDiscovery.signal, false).catch(() => {});
globalThis.__notchHost.voice = createLocalVoice(app.getPath('userData'),{getKey:async provider=>(await globalThis.__notchHost.modelManager?.key(provider))||process.env.OPENROUTER_API_KEY});
globalThis.__notchHost.createLiveVoice = createLocalLiveVoice;
app.on('will-quit', () => { void globalThis.__notchHost.voice.shutdown(); });
app.on('will-quit', () => { void globalThis.__notchHost.workspaceSearch.shutdown(); });
const databasePath = path.join(app.getPath('userData'), 'main.sqlite');
if (existsSync(databasePath)) { const database = new DatabaseSync(databasePath); try { migrateBrandDatabase(database); } finally { database.close(); } }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://disabled.notch.invalid/*'] }, (_details, callback) => callback({ cancel: true })));
app.whenReady().then(() => {
  const {autoUpdater}=createRequire(import.meta.url)('../vendor/notch-updater/index.cjs');
  globalThis.__notchHost.updates=createAppUpdater({app,updater:autoUpdater,directory:app.getPath('userData'),profileOverride:!!requestedProfile});
  globalThis.__notchHost.modelManager = createModelManager(app.getPath('userData'), { safeStorage, chooseModelDirectory:async()=>{const result=await dialog.showOpenDialog({title:'Choose Strata model folder',properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];} });
  globalThis.__notchHost.webResearch = createWebResearch(app.getPath('userData'), { safeStorage, signal: globalThis.__notchDiscovery.signal });
  globalThis.__notchHost.github = createGitHubAuth({
    directory: app.getPath('userData'),
    openExternal: url => shell.openExternal(url),
    pickDirectory: async purpose => {
      const result = await dialog.showOpenDialog({ title: purpose === 'local' ? 'Open a local repository' : 'Choose a folder for the clone', properties: purpose === 'local' ? ['openDirectory'] : ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
  });
  let originGitConfigured = false, previousOriginEnv;
  const refreshOriginGit = signedIn => {
    if (signedIn === originGitConfigured) return;
    if (signedIn) {
      const configured = originGitEnv(process.env);
      previousOriginEnv = new Map(Object.keys(configured).filter(key => configured[key] !== process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(process.env, configured);
    } else if (previousOriginEnv) for (const [key, value] of previousOriginEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    originGitConfigured = signedIn;
  };
  globalThis.__notchHost.origin = createOriginGit({
    directory: app.getPath('userData'),
      onAuthChange: refreshOriginGit,
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({ title: 'Choose a folder for the clone', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
  });
  app.on('will-quit', () => globalThis.__notchHost.origin?.close());
  void globalThis.__notchHost.origin.status().catch(() => {});
  registerModelIpc(ipcMain,globalThis.__notchHost);
  void globalThis.__notchHost.phone.start();
});
app.on('browser-window-created',(_event,window)=>{
  for(const event of ['query-session-end','session-end'])window.on(event,()=>globalThis.__notchHost.updates?.deferForShutdown());
});
app.on('will-quit',()=>globalThis.__notchHost.updates?.close());
app.on('will-quit', () => { void globalThis.__notchHost.phone?.close(); });
globalThis.__notchHost.phone = createPhoneCompanion(app.getPath('userData'), { host: globalThis.__notchHost, safeStorage });
globalThis.__notchHost.listModels().catch(() => {});
try { await import('../../out/main/index.js'); }
catch (error) {
  const message = String(error.stack || error).slice(0, 32000);
  writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), message, { mode: 0o600 });
  console.error(message); app.exit(1);
}
