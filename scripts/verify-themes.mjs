import { _electron } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
const app = await _electron.launch({ executablePath: path.resolve('release/Notch-prototype/Notch.exe'), env, timeout: 45000 });
const states = [];
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
  for (const theme of ['dark','light']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await new Promise(resolve => setTimeout(resolve, 500));
    states.push(await page.evaluate(theme => ({ theme, prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      htmlClass: document.documentElement.className, bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color }), theme));
  }
  await writeFile('../notch-theme-verification.json', JSON.stringify(states, null, 2)); console.log(JSON.stringify(states, null, 2));
} finally { await app.close(); }
