import { build } from 'tsup';
import { cp, readdir } from 'node:fs/promises';
import { buildHardware } from '../vendor/notch-cli/scripts/build-hardware.mjs';
await build({ entry: ['vendor/notch-cli/src/desktop-harness.ts'], format: ['esm'], target: 'node22', outDir: 'vendor/notch-core', splitting: true, clean: true });
await buildHardware('vendor/notch-core/native');
for (const name of await readdir('vendor/notch-cli/src/agent/builtins')) {
  if (name.endsWith('.toml')) await cp(`vendor/notch-cli/src/agent/builtins/${name}`, `vendor/notch-core/builtins/${name}`);
}
