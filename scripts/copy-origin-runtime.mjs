import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// Preserve private dependency versions; the auth-only path does not need SDK sandbox binaries.
export async function copyOriginRuntime(root, destination) {
  async function copy(name, from, modules) {
    const require = createRequire(path.join(from, 'package.json'));
    let source = path.dirname(require.resolve(name));
    let metadata;
    for (;;) {
      try { metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')); } catch { metadata = null; }
      if (metadata?.name === name) break;
      const parent = path.dirname(source); if (parent === source) throw Error(`Cannot resolve Origin runtime package ${name}.`); source = parent;
    }
    const target = path.join(modules, name);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') });
    for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies })) await copy(dependency, source, path.join(target, 'node_modules'));
  }
  await copy('@cursor/sdk', root, destination);
}
