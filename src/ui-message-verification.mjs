import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { assertProductMessages } from './ui-message-patch.mjs';

const properties = node => new Map(node?.type === 'ObjectExpression' ? node.properties.filter(p => p.type === 'Property' && !p.computed).map(p => [p.key.name ?? p.key.value, p.value]) : []);

/** English resource catalogs must be complete; user documents and examples are not catalogs. */
export function assertEnglishCatalogs(source, name = 'renderer') {
  let navigation;
  const navigationReferences = new Set();
  function pair(chinese, english, key) {
    if (chinese.type === 'Literal' && typeof chinese.value === 'string') {
      // This paired composer suffix is intentionally empty in English; its complete sentence is in the prefix.
      const optionalSuffix = key === 'newChatResources.newChat.promptInWorkspaceSuffix';
      if (english?.type !== 'Literal' || typeof english.value !== 'string' || !optionalSuffix && !english.value.trim() && chinese.value.trim()) throw Error(`Missing English message in ${name}: ${key}`);
      if (/\p{Script=Han}/u.test(english.value)) throw Error(`Non-English message in ${name}: ${key}`);
    } else if (chinese.type === 'ObjectExpression') {
      const en = properties(english);
      for (const [child, value] of properties(chinese)) pair(value, en.get(child), key + '.' + child);
    }
  }
  function visit(node, scope = '') {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator') scope = node.id.name ?? scope;
    if (node.type === 'FunctionDeclaration') scope = node.id?.name ?? scope;
    if (node.type === 'CallExpression' && typeof node.arguments?.[0]?.value === 'string' && node.arguments[0].value.startsWith('nav.')) navigationReferences.add(node.arguments[0].value);
    if (node.type === 'ObjectExpression' && /Resources(?:\$\d+)?$/u.test(scope)) {
      const props = properties(node);
      if (props.has('zh') && props.has('en')) pair(props.get('zh'), props.get('en'), scope);
      if (scope === 'shellResources' && props.has('en')) navigation = properties(props.get('en')).get('nav');
    }
    for (const [key, value] of Object.entries(node)) if (!['start', 'end', 'type', 'regex'].includes(key) && !(key === 'value' && node.type === 'Literal')) {
      if (Array.isArray(value)) value.forEach(child => visit(child, scope));
      else if (value && typeof value === 'object') visit(value, scope);
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  for (const key of navigationReferences) {
    let value = navigation;
    for (const part of key.split('.').slice(1)) value = properties(value).get(part);
    if (value?.type !== 'Literal' || typeof value.value !== 'string' || !value.value.trim()) throw Error(`Missing English navigation message in ${name}: ${key}`);
  }
}

/** Run against the assembled renderer, before packaging or publishing an installer. */
export async function verifyProductMessages(application) {
  const assets = path.join(application, 'out/renderer/assets');
  let files = 0, bundles = 0;
  for (const name of await fs.readdir(assets)) {
    if (!/\.(?:js|mjs)$/u.test(name)) continue;
    const source = await fs.readFile(path.join(assets, name), 'utf8');
    const bundle = source.includes('function OnboardingOverlaySurface(');
    assertProductMessages(source, name);
    if (bundle) { assertEnglishCatalogs(source, name); bundles++; }
    files++;
  }
  if (bundles !== 1) throw Error('Expected one IDE renderer when checking product messages.');
  await fs.access(path.join(assets, 'ui-messages.mjs'));
  return { files, bundles, unformattedMessages: 0, incompleteEnglishCatalogs: 0 };
}
