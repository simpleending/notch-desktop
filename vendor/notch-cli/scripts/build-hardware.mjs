import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function buildHardware(output) {
  if (process.platform !== 'win32') return;
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[process.arch];
  if (!target) throw new Error(`Unsupported Windows hardware helper architecture: ${process.arch}`);
  const root = fileURLToPath(new URL('../native/windows-hardware/', import.meta.url));
  const rustflags = `CARGO_TARGET_${target.replaceAll('-', '_').toUpperCase()}_RUSTFLAGS`;
  await promisify(execFile)('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(root, 'Cargo.toml')], { windowsHide: true, timeout: 300000, env: { ...process.env, [rustflags]: '-C target-feature=+crt-static' } });
  const name = `notch-hardware-win32-${process.arch}.exe`;
  const metadata = JSON.parse((await promisify(execFile)('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', path.join(root, 'Cargo.toml')], { windowsHide: true })).stdout);
  const notices = [];
  for (const dependency of metadata.packages.filter(row => row.source)) {
    const directory = path.dirname(dependency.manifest_path);
    const licenses = (await readdir(directory)).filter(name => /^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(name));
    if (!licenses.length) throw new Error(`Missing license text for ${dependency.name}`);
    notices.push(`${dependency.name} ${dependency.version} (${dependency.license})\n${dependency.repository || ''}\n${(await Promise.all(licenses.map(name => readFile(path.join(directory, name), 'utf8')))).join('\n')}`);
  }
  for (const directory of [path.join(root, 'bin'), output]) {
    await mkdir(directory, { recursive: true });
    await copyFile(path.join(root, 'target', target, 'release/notch-hardware.exe'), path.join(directory, name));
    await writeFile(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n----------------\n\n'));
  }
}
