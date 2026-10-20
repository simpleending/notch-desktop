import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginSettings } from '../src/origin-settings-view.mjs';
import { createGitHubBrowser } from '../src/github-browser.mjs';

const all = node => node && typeof node === 'object' ? [node, ...(node.children || []).flat(Infinity).flatMap(all)] : [];
const h = (type, props, ...children) => ({ type, props: props || {}, children });
function harness(initial, bridge) {
  let cursor = 0; const states = [initial], previous = globalThis.window, reference = { current: 0 };
  globalThis.window = { notchModels: { origin: bridge } };
  const effects = [];
  const React = { createElement: h, useState(value) { const index = cursor++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; }, useEffect(effect) { effects.push(effect); }, useRef: () => reference };
  const Component = createOriginSettings(React);
  const render = props => { cursor = 0; return all(Component(props)); };
  return { states, effects, render, close() { globalThis.window = previous; } };
}

test('Origin clones with explicit protocol and remembered URLs open instead of cloning again', async () => {
  const calls = [], opened = [], view = harness({ nativeCliSupported: false, localClones: { 'acme/existing': '/local/existing' } }, async (...args) => { calls.push(args); return { clonedPath: '/local/existing' }; });
  const props = { onOpenProject: async directory => opened.push(directory) };
  const input = () => view.render(props).find(node => node.type === 'input');
  try {
    input().props.onChange({ target: { value: 'acme/new' } });
    view.render(props).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), ['clone', 'git@origin.cursor.com:acme/new.git']);
    input().props.onChange({ target: { value: 'https://origin.cursor.com/git/acme/existing.git' } });
    assert.ok(view.render(props).find(node => node.type === 'button' && node.children.includes('Open Origin repository')));
    view.render(props).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1)[0], 'openRepo'); assert.deepEqual(opened, ['/local/existing']);
    assert.equal(view.render(props).some(node => node.children.includes('Load Origin repositories')), false);
    assert.ok(view.render(props).some(node => node.type === 'p' && String(node.children[0]).includes('WSL credentials are separate')));
  } finally { view.close(); }
});

test('Origin namespace choice, paginated repository list, filtering and local Open use accessible actions', async () => {
  const calls = [], view = harness({ nativeCliSupported: true, localClones: { 'acme/local': '/local' } }, async (action, value) => {
    calls.push([action, value]);
    if (action === 'namespaces') return { namespaces: ['acme'] };
    return { repos: [{ name: 'acme/local', visibility: 'Private' }, { name: 'acme/remote', visibility: 'Internal', mirror: true }], nextPageToken: 'opaque-page' };
  });
  const props = { onOpenProject: async () => {} }, button = label => view.render(props).find(node => node.type === 'button' && node.children.includes(label));
  try {
    await button('Load Origin repositories').props.onClick();
    const label = view.render(props).find(node => node.type === 'label' && node.children.includes('Origin namespace'));
    label.children.find(node => node?.type === 'select').props.onChange({ target: { value: 'acme' } }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), ['repos', { owner: 'acme' }]);
    assert.ok(view.render(props).find(node => node.props['aria-label'] === 'Open Origin acme/local'));
    assert.ok(view.render(props).find(node => node.props['aria-label'] === 'Clone Origin acme/remote'));
    await button('Load more Origin repositories').props.onClick(); assert.deepEqual(calls.at(-1), ['repos', { owner: 'acme', pageToken: 'opaque-page' }]);
    const filter = view.render(props).find(node => node.type === 'input' && node.props.type === 'search'); filter.props.onChange({ target: { value: 'local' } });
    assert.equal(view.render(props).filter(node => node.type === 'li').length, 1);
  } finally { view.close(); }
});

test('provider selector preserves GitHub entry and uses official Origin marks for each theme', () => {
  for (const theme of ['forest-dark', 'forest-light']) {
    let cursor = 0; const values = [], React = { createElement: h, useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; } };
    const { Browser } = createGitHubBrowser(React, () => ({ resolvedTheme: theme }));
    const render = () => { cursor = 0; return all(Browser({ projects: [], onOpenProject() {} })); };
    const origin = render().find(node => node.type === 'button' && node.children.includes('Origin'));
    assert.match(origin.children[0].props.src, new RegExp(`origin-repo-mark-${theme.endsWith('-dark') ? 'dark' : 'light'}\\.svg$`));
    assert.equal(origin.props['aria-pressed'], false); origin.props.onClick();
    assert.equal(render().find(node => node.type === 'button' && node.children.includes('Origin')).props['aria-pressed'], true);
    assert.equal(render().at(-1).type.name, 'OriginSettings');
  }
});

test('a delayed initial history response cannot replace a newer Origin clone result', async () => {
  let complete;
  const view = harness(null, async action => action === 'remember' ? new Promise(resolve => { complete = resolve; }) : { clonedPath: '/new/clone', localClones: { 'acme/new': '/new/clone' } });
  try {
    const props = { onOpenProject: async () => {} };
    view.render(props); const cleanup = view.effects[0]();
    view.render(props).find(node => node.type === 'input').props.onChange({ target: { value: 'acme/new' } });
    view.render(props).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    complete({ localClones: {} }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.states[0].clonedPath, '/new/clone'); cleanup();
  } finally { view.close(); }
});
