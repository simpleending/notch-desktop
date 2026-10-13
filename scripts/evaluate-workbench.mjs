import { _electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-workbench-'));
const sessionId = randomUUID(), errors = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
let app;
try {
  app = await _electron.launch({ executablePath: path.resolve('release/Notch-prototype/Notch.exe'), args: ['--lang=en-US'], env, timeout: 45000 });
  app.process().stderr.on('data', chunk => { if (/error|failed/i.test(chunk.toString())) errors.push(chunk.toString().slice(-1500)); });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
  await page.waitForLoadState('domcontentloaded');
  const workspace = await page.evaluate(cwd => window.notchDesktop.createLocalWorkspace({ name: 'notch harness check', rootPaths: [cwd], productMode: 'coding', workspaceIndexEnabled: false }), cwd);
  const admission = await page.evaluate(async ({ cwd, sessionId, workspace }) => {
    return window.notchDesktop.sendChatMessage({ sessionId, agentId: 'agent:default', workspaceId: workspace.workspaceId,
      cwd, productMode: 'coding', model: 'auto', permissionMode: 'default', inputId: crypto.randomUUID(),
      prompt: 'Read the current directory and tell me its path. Do not edit or run shell commands.' });
  }, { cwd, sessionId, workspace });
  const opened = await page.evaluate(sessionId => window.notchDesktop.openChatSession(sessionId), sessionId);
  let state;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    state = await page.evaluate(sessionId => window.notchDesktop.getChatSessionExecutionState(sessionId), sessionId);
    if (state.facts?.executionStatus?.value === 'idle') break;
  }
  const report = { cwd, sessionId, workspace, admission, opened, state, errors };
  await writeFile('../notch-workbench-evaluation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ cwd, sessionId, admission, state, errors: errors.slice(0, 3) }, null, 2));
} catch (error) { await writeFile('../notch-workbench-evaluation.json', JSON.stringify({ cwd, sessionId, error: error.message, errors }, null, 2)); throw error; }
finally {
  if (app) await app.close().catch(() => {});
  await Promise.allSettled([11434,11436].map(port => fetch(`http://127.0.0.1:${port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'notch-hf-abd14067e8d7:latest', stream: false, keep_alive: 0 }), signal: AbortSignal.timeout(10000) })));
}
