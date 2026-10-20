import { parse } from 'acorn';

const property = (object, name) => object?.properties?.find(p => !p.computed && (p.key?.name ?? p.key?.value) === name)?.value;
const memberName = node => node?.computed ? node.property?.value : node?.property?.name;
const protectedScope = /(?:Terminal|CodeBlock|Markdown|ToolOutput|ToolResult|ToolResponse|ToolInvocation|MessageContent|SourceEditor)/;
const messageName = /^(?:error|message|warning|notice|reason|fitLabel|pollError|displayError|workspaceError|loadError|connectionError)$/i;
const renders = node => {
  const callee = node?.callee?.type === 'SequenceExpression' ? node.callee.expressions.at(-1) : node?.callee;
  return node?.type === 'CallExpression' && (['h', 'el'].includes(callee?.name) || ['jsx', 'jsxs', 'createElement'].includes(memberName(callee)));
};
const rawLiteral = node => node?.type === 'Literal' && typeof node.value === 'string' && /\p{Script=Han}|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^(?:settings|chatSession|chatActivity|workspace|composer|remoteSsh|startup|common|appError|error|cloudAutomation)\.[\w.-]+$/u.test(node.value);

/** Find product-message display boundaries, never the data producers or protocol classifiers. */
export function productMessageSites(source) {
  const sites = [], tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const add = (node, fallback) => {
    if (!node || node.type === 'SpreadElement' || node.type === 'Literal' && typeof node.value !== 'string') return;
    if (node.type === 'Literal' && !rawLiteral(node)) return;
    if (node.type === 'CallExpression' && node.callee?.name === 'uiMessage') return;
    // Canvas compiler diagnostics belong to the user's source; only its application failures are product copy.
    if (node.type === 'ConditionalExpression' && node.test.type === 'BinaryExpression' && node.test.operator === '===' && memberName(node.test.left) === 'kind' && node.test.right.value === 'compile-error') {
      add(node.alternate, fallback);
      return;
    }
    // A mixed render tree may contain file names, commands, and user content. Inspect its children individually.
    let mixed = false;
    function containsRender(value) {
      if (!value || typeof value !== 'object') return;
      if (renders(value) || /Function/.test(value.type ?? '')) { mixed = true; return; }
      for (const [key, child] of Object.entries(value)) if (!['loc', 'start', 'end'].includes(key)) {
        if (Array.isArray(child)) child.forEach(containsRender); else if (child && typeof child === 'object') containsRender(child);
      }
    }
    containsRender(node);
    if (!mixed) sites.push({ start: node.start, end: node.end, loc: node.loc, fallback });
  };
  function messageValue(node) {
    if (!node) return false;
    if (node.type === 'Identifier') return messageName.test(node.name);
    if (node.type === 'MemberExpression') return messageName.test(memberName(node) ?? '');
    if (node.type === 'ChainExpression') return messageValue(node.expression);
    if (['LogicalExpression', 'BinaryExpression'].includes(node.type)) return messageValue(node.left) || messageValue(node.right);
    if (node.type === 'ConditionalExpression') return messageValue(node.consequent) || messageValue(node.alternate);
    return false;
  }
  function visit(node, scope = '', productContext = false, preserve = false) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') scope = node.id?.name ?? scope;
    if (node.type === 'VariableDeclarator' && /FunctionExpression/.test(node.init?.type ?? '')) scope = node.id.name;
    if (!preserve && !protectedScope.test(scope) && node.type === 'AssignmentExpression' && ['textContent', 'innerText'].includes(memberName(node.left))
      && (messageValue(node.right) || /error|status|notice|banner|warning/i.test(node.left.object?.name ?? ''))) add(node.right);
    if (node.type === 'CallExpression') {
      const callee = node.callee.type === 'SequenceExpression' ? node.callee.expressions.at(-1) : node.callee, method = memberName(callee);
      const toast = callee?.object?.name === 'toast' || memberName(callee?.object) === 'toast';
      if (toast && (['error', 'success', 'warning', 'info', 'loading', 'message'].includes(method) || callee.computed && method === undefined) || callee?.name === 'toast') {
        add(node.arguments[0], method === 'success' ? 'The action finished.' : method === 'loading' ? 'Working…' : method !== 'error' ? 'No further details are available.' : undefined);
        for (const name of ['description', 'title']) add(property(node.arguments[1], name));
      }
      if (renders(node)) {
        const [tag, props, ...children] = node.arguments, tagName = tag?.value;
        const errorScope = /ErrorState|ErrorCard|ErrorBanner/.test(scope);
        const keep = preserve || ['code', 'textarea', 'script', 'style'].includes(tagName) || tagName === 'pre' && !errorScope || protectedScope.test(scope);
        const role = property(props, 'role')?.value;
        const danger = /(?:^|[\s-])(?:error|danger|destructive)(?:$|[\s-])/.test(property(props, 'className')?.value ?? '');
        const context = productContext || role === 'alert' || danger || errorScope;
        const fallback = role === 'status' ? 'Status details are unavailable. Refresh to check again.' : undefined;
        const values = [...children, property(props, 'children')].filter(Boolean);
        if (!keep) {
          for (const value of values) {
            if (value.type === 'ArrayExpression') { for (const element of value.elements) if (context || messageValue(element) || rawLiteral(element)) add(element, fallback); }
            else if (context || messageValue(value) || rawLiteral(value)) add(value, fallback);
          }
          for (const name of ['title', 'description', 'message', 'label', 'aria-label', 'placeholder', 'alt']) {
            const value = property(props, name);
            if (messageValue(value) || rawLiteral(value) || ['title', 'description', 'message'].includes(name) && /Error|Notification|Banner/.test(tag?.name ?? '') && value?.type !== 'Literal') add(value);
          }
        }
        // Props contain handlers and data as well as copy; only rendered children inherit the alert context.
        visit(callee, scope, false, keep);
        for (const prop of props?.properties ?? []) visit(prop.value ?? prop.argument, scope, (prop.key?.name ?? prop.key?.value) === 'children' && context, keep);
        for (const child of children) visit(child, scope, context, keep);
        return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'type', 'regex'].includes(key) || key === 'value' && node.type === 'Literal') continue;
      const childContext = productContext && (['ArrayExpression', 'ConditionalExpression', 'LogicalExpression', 'ChainExpression'].includes(node.type) || key === 'value' && node.type === 'Property' && (node.key.name ?? node.key.value) === 'children');
      if (Array.isArray(value)) value.forEach(child => visit(child, scope, childContext, preserve));
      else if (value && typeof value === 'object') visit(value, scope, childContext, preserve);
    }
  }
  visit(tree);
  // Prefer the outermost message expression so nested interpolation is formatted only once.
  return sites.filter((node, i) => !sites.some((other, j) => j !== i && other.start <= node.start && other.end >= node.end && (other.start !== node.start || j < i)));
}

export function patchUiMessages(source) {
  const sites = productMessageSites(source);
  if (!sites.length) return source;
  for (const node of sites.sort((a, b) => b.start - a.start)) source = source.slice(0, node.start) + 'uiMessage(' + source.slice(node.start, node.end) + (node.fallback ? ', ' + JSON.stringify(node.fallback) : '') + ')' + source.slice(node.end);
  if (!/import\s*\{[^}]*\buiMessage\b[^}]*\}\s*from\s*['"]\.\/ui-messages\.mjs['"]/.test(source)) source = 'import { uiMessage } from "./ui-messages.mjs";\n' + source;
  return source;
}

export function assertProductMessages(source, name = 'renderer') {
  const sites = productMessageSites(source);
  if (sites.length) throw new Error(`Unformatted product message in ${name}:${sites[0].loc.start.line}: ${source.slice(sites[0].start, sites[0].end).slice(0, 100)}`);
}
