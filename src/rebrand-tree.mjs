import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { rebrandWorkbenchText } from './bundle-patch.mjs';
const legal = /^(?:licen[cs]e|notice|copying|copyright|third.?party)/i;
const textFile = /\.(?:js|cjs|mjs|json|html|css|svg|md|txt|yml|yaml|xml|ini|proto|toml|cmd|ps1|sh|d\.ts)$/i;
/** Rename both sides of the generated application's import/path graph. */
export async function rebrandTree(directory) {
  const root = path.resolve(directory);
  function contained(file) { if (!path.resolve(file).startsWith(root + path.sep)) throw new Error('Rebrand target escaped the generated application.'); }
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const original = path.join(current, entry.name); contained(original);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(original);
      else if (!legal.test(entry.name) && textFile.test(entry.name)) {
        const source = await readFile(original, 'utf8'), branded = rebrandWorkbenchText(source);
        if (source !== branded) await writeFile(original, branded);
      }
      const name = entry.name.replace(/qoder/gi, 'notch');
      if (name !== entry.name) { const destination = path.join(current, name); contained(destination); await rename(original, destination); }
    }
  }
  await visit(root);
}
