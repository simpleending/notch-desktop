import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { listPackage, extractFile, statFile } from '@electron/asar';

export const inspectionPatterns = {
  localAccountGate: 'requireAccountId(){',
  composerLoginGate: 'async listComposerModels(',
  sdkSession: 'Exe({prompt:',
  jobToken: 'createJobTokenCallback(){',
  modelIpc: 'chatModelsList:',
  providerIpc: 'byokConfigCreate:',
  permissionIpc: 'chatSessionSetPermissionMode:',
  interruptIpc: 'chatSessionInterrupt:',
};
export function inspectCode(source) {
  return Object.fromEntries(Object.entries(inspectionPatterns).map(([name, pattern]) => {
    const offsets = []; let at = -1;
    for (let count = 0; count < 8; count++) { at = source.indexOf(pattern, at + 1); if (at < 0) break; offsets.push(at); }
    return [name, { pattern, offsets }];
  }));
}
export async function inspectInstallation(installation) {
  const resources = path.join(path.resolve(installation), 'resources');
  const archive = path.join(resources, 'app.asar');
  const entries = listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
  const manifest = JSON.parse(await readFile(path.join(resources, 'build-manifest.json'), 'utf8'));
  const product = JSON.parse(await readFile(path.join(resources, 'product.json'), 'utf8'));
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  const main = extractFile(archive, path.join('out', 'main', 'index.js')).toString('utf8');
  const missingUnpacked = [];
  for (const file of entries) {
    const metadata = statFile(archive, file.split('/').join(path.sep));
    if (metadata.unpacked && !metadata.files) {
      try { await access(path.join(`${archive}.unpacked`, file)); } catch { missingUnpacked.push(file); }
    }
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return { inspectedAt: new Date().toISOString(), product, manifest,
    archiveSha256: hash.digest('hex'),
    entries: entries.length, sourceMaps: entries.filter(file => file.endsWith('.map')),
    rendererEntries: entries.filter(file => /^out\/renderer\/assets\/index-.*\.js$/.test(file)),
    sdk: pkg.dependencies?.['@qoder-ai/qoder-agent-sdk'], missingUnpacked,
    integrationPoints: inspectCode(main),
    method: 'Read-only archive/header and static bundle inspection. No installed app or user data modified; no application code executed.' };
}
