import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSettings } from '../src/github-settings-view.mjs';
import { openClonedProject } from '../src/workbench-skin.mjs';

function harness(initial, bridge) {
  const states = [initial, null, '', '']; let cursor = 0;
  const reference = { current: 0 };
  const React = { useState(initialValue) { const index = cursor++; if (!(index in states)) states[index] = initialValue; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; }, useRef: () => reference, useEffect() {}, createElement(type, props, ...children) { return { type, props: props || {}, children }; } };
  const previous = globalThis.window; globalThis.window = { notchModels: { github: bridge } };
  const Component = createGitHubSettings(React);
  const render = props => { cursor = 0; return Component(props); };
  const all = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(all)] : [];
  const button = (tree, text) => all(tree).find(node => node.type === 'button' && node.children.includes(text));
  return { render, button, all, states, close() { globalThis.window = previous; } };
}

test('GitHub displays English errors while preserving repository names and descriptions', () => {
  const initial = { installed: true, account: 'user', phase: 'ready', message: '', repos: [{ nameWithOwner: 'RAW_REPO/project', description: 'IDE_PULL_OK', isPrivate: true }] };
  const view = harness(initial, async () => initial);
  try {
    view.states[2] = 'APP_PLUGIN_PERMISSION_DENIED';
    const rendered = JSON.stringify(view.render());
    assert.match(rendered, /Review its permissions/);
    assert.doesNotMatch(rendered, /APP_PLUGIN_PERMISSION_DENIED/);
    assert.match(rendered, /RAW_REPO\/project/);
    assert.match(rendered, /IDE_PULL_OK/);
    assert.equal(view.states[2], 'APP_PLUGIN_PERMISSION_DENIED');
  } finally { view.close(); }
});

test('Cancel stays available during login and stale login results cannot replace cancellation', async () => {
  let finish;
  const view = harness({ installed: true, account: null, phase: 'ready' }, async action => action === 'login' ? new Promise(resolve => { finish = resolve; }) : { installed: true, account: null, phase: 'ready', message: 'Cancelled' });
  try {
    const pending = view.button(view.render(), 'Sign in with GitHub').props.onClick();
    const cancel = view.button(view.render(), 'Cancel sign-in');
    assert.equal(cancel.props.disabled, false);
    await cancel.props.onClick();
    finish({ installed: true, account: 'stale-user', phase: 'ready' }); await pending;
    assert.equal(view.states[0].message, 'Cancelled');
    assert.equal(view.states[1], null);
  } finally { view.close(); }
});

test('repository pagination, account repair and clone handoff are accessible', async () => {
  const calls = []; const opened = [];
  const initial = { installed: true, account: 'user', phase: 'ready', hasMore: true, repoPage: 1, repos: [], clonedPath: 'C:\\projects\\clone' };
  const view = harness(initial, async (...args) => { calls.push(args); return initial; });
  const props = { onOpenProject: async path => opened.push(path) };
  try {
    assert.ok(view.button(view.render(props), 'Sign in with another account'));
    await view.button(view.render(props), 'Load more repositories').props.onClick();
    assert.deepEqual(calls[0], ['repos', 2]);
    await view.button(view.render(props), 'Open project').props.onClick();
    assert.deepEqual(opened, [initial.clonedPath]);
    const input = view.all(view.render(props)).find(node => node.type === 'input');
    input.props.onChange({ target: { value: 'organization/project' } });
    await view.all(view.render(props)).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), ['clone', 'https://github.com/organization/project.git']);
    input.props.onChange({ target: { value: 'git@github.com:organization/project.git' } });
    await view.all(view.render(props)).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), ['clone', 'git@github.com:organization/project.git']);
  } finally { view.close(); }
});

test('opening a clone creates a workspace once and navigates to it', async () => {
  const workspaces = [], routes = [];
  const service = { load: async () => {}, stateObs: { get: () => ({ workspaces }) }, create: async input => { const workspace = { ...input, workspaceId: 'fixture-workspace' }; workspaces.push(workspace); return workspace; } };
  const navigation = { push: route => routes.push(route) };
  await openClonedProject('C:\\projects\\clone', service, navigation);
  await openClonedProject('c:/PROJECTS/clone/', service, navigation);
  assert.equal(workspaces.length, 1);
  assert.deepEqual(workspaces[0].rootPaths, ['C:\\projects\\clone']);
  assert.equal(workspaces[0].name, 'clone');
  assert.deepEqual(routes, Array(2).fill({ kind: 'new-chat', workspaceId: 'fixture-workspace' }));
});

test('repository browser filters owners and descriptions, names clone actions, and keeps SSH when selecting a row', async () => {
  const calls = [], rows = [
    { nameWithOwner: 'personal/editor', description: 'Editor', isPrivate: true },
    { nameWithOwner: 'team/backend', description: 'Searchable service', isPrivate: false },
  ];
  const initial = { installed: true, account: 'user', phase: 'ready', repos: rows, hasMore: true, repoPage: 1 };
  const view = harness(initial, async (...args) => { calls.push(args); return initial; });
  const labeled = (tree, text) => view.all(tree).find(node => node.type === 'label' && node.children.includes(text)).children.find(node => node && typeof node === 'object');
  try {
    const list = () => view.all(view.render()).find(node => node.type === 'ul');
    assert.equal(list().props['aria-label'], 'GitHub repositories');
    assert.equal(list().props.tabIndex, 0);
    labeled(view.render(), 'Filter loaded repositories').props.onChange({ target: { value: 'searchable' } });
    assert.deepEqual(view.all(list()).filter(node => node.type === 'strong').map(node => node.children[0]), ['team/backend']);
    labeled(view.render(), 'Repository owner').props.onChange({ target: { value: 'personal' } });
    assert.match(JSON.stringify(list()), /No loaded repositories match/);
    labeled(view.render(), 'Filter loaded repositories').props.onChange({ target: { value: '' } });
    labeled(view.render(), 'Clone protocol').props.onChange({ target: { value: 'ssh' } });
    const clone = view.all(list()).find(node => node.type === 'button');
    assert.equal(clone.props['aria-label'], 'Clone personal/editor');
    await clone.props.onClick();
    assert.deepEqual(calls.at(-1), ['clone', 'git@github.com:personal/editor.git']);
    assert.ok(view.button(view.render(), 'Load more repositories'));
  } finally { view.close(); }
});

test('remembered GitHub rows and pasted URLs open their verified clone instead of cloning again', async () => {
  const opened = [], calls = [], initial = { account: 'user', installed: true, phase: 'ready', repos: [{ nameWithOwner: 'Team/Repo' }, { nameWithOwner: 'Team/New' }], localClones: { 'team/repo': 'C:\\projects\\repo' } };
  const view = harness(initial, async (...args) => { calls.push(args); return { ...initial, clonedPath: initial.localClones['team/repo'] }; });
  const props = { onOpenProject: async directory => opened.push(directory) };
  try {
    const nodes = () => view.all(view.render(props));
    assert.equal(nodes().find(node => node.props['aria-label'] === 'Open Team/Repo').children[0], 'Open');
    assert.ok(nodes().find(node => node.props['aria-label'] === 'Clone Team/New'));
    await nodes().find(node => node.props['aria-label'] === 'Open Team/Repo').props.onClick();
    assert.deepEqual(calls, [['openRepo', 'Team/Repo']]);
    assert.deepEqual(opened, ['C:\\projects\\repo']);
    nodes().find(node => node.type === 'input').props.onChange({ target: { value: 'git@github.com:TEAM/REPO.git' } });
    assert.ok(view.button(view.render(props), 'Open repository'));
    nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1)[0], 'openRepo');
    assert.equal(calls.some(([action]) => action === 'clone'), false);
  } finally { view.close(); }
});
