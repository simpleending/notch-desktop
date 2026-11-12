import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createAutomationBackground({ app, BrowserWindow, Tray, Menu, directory }) {
  const file = path.join(directory, 'automation-background.json');
  let enabled = false, quitting = false, tray, writes = Promise.resolve();
  const primary = window => { try { return !window.isDestroyed() && !new URL(window.webContents.getURL() || 'about:blank').searchParams.has('surface'); } catch { return false; } };
  const show = () => { const window = BrowserWindow.getAllWindows().find(primary); if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
  const ready = fs.readFile(file, 'utf8').then(text => { enabled = JSON.parse(text).enabled === true; }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  async function syncTray() {
    if (enabled && !tray) {
      const icon = await app.getFileIcon(process.execPath, { size: 'small' });
      tray = new Tray(icon); tray.setToolTip('Notch — automations running in background');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Notch', click: show }, { label: 'Quit Notch', click: () => { quitting = true; app.quit(); } }]));
      tray.on('double-click', show);
    } else if (!enabled && tray) { show(); tray.destroy(); tray = undefined; }
  }
  app.on('before-quit', () => { quitting = true; });
  app.on('browser-window-created', (_event, window) => {
    window.prependListener('close', event => { if (enabled && tray && !quitting && primary(window)) { event.preventDefault(); window.hide(); } });
    window.on('query-session-end', () => { quitting = true; });
    window.on('session-end', () => { quitting = true; });
  });
  app.on('will-quit', () => { tray?.destroy(); tray = undefined; });
  return {
    async start() { await ready; await syncTray(); },
    async settings(value) {
      if (value === undefined) { await ready; return { enabled }; }
      if (typeof value !== 'boolean') throw Error('Choose whether background automations are enabled.');
      const operation = writes.catch(() => {}).then(async () => {
        await ready; const previous = enabled; enabled = value;
        const temporary = file + '.' + randomUUID() + '.tmp';
        try { await syncTray(); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(temporary, JSON.stringify({ enabled }), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
        catch (error) { enabled = previous; await syncTray(); throw error; }
        finally { await fs.unlink(temporary).catch(() => {}); }
        return { enabled };
      }); writes = operation; return operation;
    },
  };
}

export async function revealAutomation(BrowserWindow, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
  const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !new URL(window.webContents.getURL() || 'about:blank').searchParams.has('surface'));
  if (!window) return;
  if (window.isMinimized()) window.restore(); window.show(); window.focus();
  await window.webContents.executeJavaScript(`(async()=>{await window.notchDesktop.openChatSession(${JSON.stringify(sessionId)});window.location.hash='/chat/'+encodeURIComponent(${JSON.stringify(sessionId)});})()`);
}
