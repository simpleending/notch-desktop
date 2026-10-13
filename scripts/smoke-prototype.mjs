import { _electron } from 'playwright-core';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const executable = path.resolve(process.argv[2] || 'release/Notch-prototype/Notch.exe');
const reportFile = path.resolve(process.argv[3] || '../notch-prototype-smoke.json');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const errors = [], started = Date.now();
let app;
try {
  app = await _electron.launch({ executablePath: executable, cwd: path.dirname(executable), args: ['--lang=en-US'], env, timeout: 45000 });
  app.process().stderr.on('data', chunk => { const text = chunk.toString(); if (/error|exception|failed/i.test(text)) errors.push(text.slice(-1500)); });
  const window = await app.firstWindow({ timeout: 45000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  window.on('pageerror', error => errors.push(error.message));
  await window.waitForLoadState('domcontentloaded');
  const catalog = await window.evaluate(async () => {
    const api = window.notchDesktop || window.qoderDesktop;
    return await api.listChatComposerModels({ fetchStrategy: 'cache', executionHostKind: 'local', workspaceDirectories: [] });
  });
  const state = await window.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 8000), globals: Object.keys(window).filter(key => /qoder|notch/i.test(key)), apiKeys: Object.keys(window.notchDesktop || window.qoderDesktop || {}).filter(key => /workspace|setting|theme|session/i.test(key)) }));
  const identity = await app.evaluate(({ app, BrowserWindow }) => ({ name: app.getName(), dataDirectory: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length }));
  const report = { executable, elapsedMs: Date.now() - started, identity, state, catalog, errors };
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  if (process.argv.includes('--capture')) {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.show(); });
    await window.screenshot({ path: reportFile.replace(/\.json$/, '.png'), timeout: 15000 });
  }
  console.log(JSON.stringify({ reportFile, identity, globals: state.globals, errors: errors.slice(0, 3) }, null, 2));
} catch (error) {
  await writeFile(reportFile, JSON.stringify({ executable, error: error.message, errors }, null, 2)); throw error;
} finally { if (app) await app.close().catch(() => {}); }
