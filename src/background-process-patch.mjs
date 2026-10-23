import { parse } from 'acorn';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Hide background consoles while preserving explicitly requested windows and command arguments. */
export function patchBackgroundProcesses(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const commands = new Map(), objects = new Set(), utilities = new Set(), promisifiers = new Set(), edits = [];
  const position = name => ['exec','execSync'].includes(name) ? 1 : ['spawn','spawnSync','execFile','execFileSync'].includes(name) ? 2 : undefined;
  const childModule = value => /^(?:node:)?child_process$/.test(value);
  const moduleName = node => node?.type==='CallExpression' ? node.callee.name==='require' ? node.arguments[0]?.value :
    ['__toESM','__importStar','__importDefault'].includes(node.callee.name) ? moduleName(node.arguments[0]) : undefined : undefined;
  const required = node => childModule(moduleName(node));
  const objectName = node => node?.type==='Identifier' ? node.name : node?.type==='MemberExpression' && node.property.name==='default' ? objectName(node.object) : undefined;
  const commandIndex = node => node?.type==='Identifier' ? commands.get(node.name) :
    node?.type==='MemberExpression' && (objects.has(objectName(node.object)) || required(node.object)) ? position(node.property.name ?? node.property.value) : undefined;
  for (const node of tree.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const specifier of node.specifiers) {
      const name = specifier.imported?.name;
      if (childModule(node.source.value) && ['ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(specifier.type)) objects.add(specifier.local.name);
      if (/^(?:node:)?util$/.test(node.source.value) && ['ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(specifier.type)) utilities.add(specifier.local.name);
      if (/^(?:node:)?child_process$/.test(node.source.value) && ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].includes(name)) commands.set(specifier.local.name, ['exec', 'execSync'].includes(name) ? 1 : 2);
      if (/^(?:node:)?util$/.test(node.source.value) && name === 'promisify') promisifiers.add(specifier.local.name);
      if (node.source.value === 'cross-spawn' && specifier.type === 'ImportDefaultSpecifier') commands.set(specifier.local.name, 2);
    }
  }
  const insert = (at, text) => edits.push({ at, text });
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if(node.type==='VariableDeclarator' && required(node.init)) {
      if(node.id.type==='Identifier')objects.add(node.id.name);
      if(node.id.type==='ObjectPattern')for(const property of node.id.properties){const index=position(property.key?.name);if(index!==undefined)commands.set(property.value.name,index);}
    }
    if(node.type==='VariableDeclarator' && /^(?:node:)?util$/.test(moduleName(node.init))){
      if(node.id.type==='Identifier')utilities.add(node.id.name);
      if(node.id.type==='ObjectPattern')for(const property of node.id.properties)if(property.key?.name==='promisify')promisifiers.add(property.value.name);
    }
    const callee=node.init?.callee;
    if (node.type === 'VariableDeclarator' && (promisifiers.has(callee?.name) || callee?.type==='MemberExpression' && utilities.has(objectName(callee.object)) && callee.property.name==='promisify') && commandIndex(node.init.arguments[0])!==undefined) commands.set(node.id.name, commandIndex(node.init.arguments[0]));
    if (node.type === 'CallExpression' && commandIndex(node.callee)!==undefined) {
      let index=commandIndex(node.callee);
      if(index===2 && ['ObjectExpression','FunctionExpression','ArrowFunctionExpression'].includes(node.arguments[1]?.type))index=1;
      const options = node.arguments[index];
      if (!options) insert(node.end - 1, (source.slice(node.arguments.at(-1)?.end ?? node.start,node.end-1).includes(',')?'':',')+'{windowsHide:true}');
      else if (['FunctionExpression', 'ArrowFunctionExpression'].includes(options.type)) insert(options.start, '{windowsHide:true},');
      else if (options.type === 'ObjectExpression') {
        if (!options.properties.some(property => (property.key?.name ?? property.key?.value) === 'windowsHide')) insert(options.start + 1, 'windowsHide:true,');
      } else { insert(options.start, '{windowsHide:true,...'); insert(options.end, '}'); }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  return source;
}

export async function installBackgroundProcesses(application) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8'), patched = patchBackgroundProcesses(source);
        if (patched !== source) await writeFile(file, patched);
      }
    }
  }
  await visit(path.join(application, 'out/main'));
  await visit(path.join(application, 'notch/vendor/notch-core'));
  await visit(path.join(application, 'notch/src'));
  await visit(path.join(application, 'notch/node_modules/@freesyntax/notch-cli/dist'));
}
