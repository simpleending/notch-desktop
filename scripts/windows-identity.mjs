import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function applyWindowsIdentity(application, version, productName = 'notch') {
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/winCodeSign');
  let editor;
  for (const folder of await fs.readdir(cache)) {
    const candidate = path.join(cache, folder, 'rcedit-x64.exe');
    try { await fs.access(candidate); editor = candidate; break; } catch {}
  }
  if (!editor) throw new Error('The Windows resource editor is missing from its build cache.');
  await promisify(execFile)(editor, [path.join(application, 'Notch.exe'), '--set-icon', path.join(application, 'resources/app-icon.ico'),
    '--set-file-version', version.split('-')[0], '--set-product-version', version,
    '--set-version-string', 'ProductName', productName, '--set-version-string', 'FileDescription', `${productName} by freesyntax.dev`,
    '--set-version-string', 'CompanyName', 'freesyntax.dev', '--set-version-string', 'InternalName', 'notch',
    '--set-version-string', 'OriginalFilename', 'Notch.exe', '--set-version-string', 'LegalCopyright', 'Copyright 2026 Driftrail'], { windowsHide: true });
}
