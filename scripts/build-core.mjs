import { build } from 'tsup';
import { cp, readdir } from 'node:fs/promises';
await build({ entry: ['vendor/notch-cli/src/desktop-harness.ts'], format: ['esm'], target: 'node22', outDir: 'vendor/notch-core', splitting: true, clean: true });
for (const name of await readdir('vendor/notch-cli/src/agent/builtins')) {
  if (name.endsWith('.toml')) await cp(`vendor/notch-cli/src/agent/builtins/${name}`, `vendor/notch-core/builtins/${name}`);
}
