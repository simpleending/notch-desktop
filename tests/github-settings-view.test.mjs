import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSettings } from '../src/github-settings-view.mjs';
import { openClonedProject } from '../src/workbench-skin.mjs';

function harness(initial, bridge) {
  const states = [initial, null, '', '']; let cursor = 0;
  const reference = { current: 0 };
  const React = { useState() { const index = cursor++; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; }, useRef: () => reference, useEffect() {}, createElement(type, props, ...children) { return { type, props: props || {}, children }; } };
  const previous = globalThis.window; globalThis.window = { notchModels: { github: bridge } };
  const Component = createGitHubSettings(React);
  const render = props => { cursor = 0; return Component(props); };
  const all = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(all)] : [];
  const button = (tree, text) => all(tree).find(node => node.type === 'button' && node.children.includes(text));
  return { render, button, all, states, close() { globalThis.window = previous; } };
}

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
    assert.deepEqual(calls.at(-1), ['clone', 'organization/project']);
  } finally { view.close(); }
});

test('opening a clone creates a workspace once and navigates to it', async () => {
  const workspaces = [], routes = [];
  const service = { load: async () => {}, stateObs: { get: () => ({ workspaces }) }, create: async input => { const workspace = { ...input, workspaceId: 'fixture-workspace' }; workspaces.push(workspace); return workspace; } };
  const navigation = { push: route => routes.push(route) };
  await openClonedProject('C:\\projects\\clone', service, navigation);
  await openClonedProject('C:\\projects\\clone', service, navigation);
  assert.equal(workspaces.length, 1);
  assert.deepEqual(workspaces[0].rootPaths, ['C:\\projects\\clone']);
  assert.equal(workspaces[0].name, 'clone');
  assert.deepEqual(routes, Array(2).fill({ kind: 'new-chat', workspaceId: 'fixture-workspace' }));
});
