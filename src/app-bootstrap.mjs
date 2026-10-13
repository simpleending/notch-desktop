import { app, session } from 'electron';
import path from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateBrandDatabase } from './brand-migration.mjs';
import { createHost } from './notch-host.mjs';
app.setName('notch');
app.setPath('userData', path.join(app.getPath('appData'), 'com.freesyntax.notch.desktop'));
globalThis.__notchHost = createHost(app.getPath('userData'));
const databasePath = path.join(app.getPath('userData'), 'main.sqlite');
if (existsSync(databasePath)) { const database = new DatabaseSync(databasePath); try { migrateBrandDatabase(database); } finally { database.close(); } }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://disabled.notch.invalid/*'] }, (_details, callback) => callback({ cancel: true })));
globalThis.__notchHost.listModels().catch(() => {});
try { await import('../../out/main/index.js'); }
catch (error) {
  const message = String(error.stack || error).slice(0, 32000);
  writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), message, { mode: 0o600 });
  console.error(message); app.exit(1);
}
