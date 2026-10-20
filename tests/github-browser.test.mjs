import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubBrowser, GITHUB_BROWSER_EVENT } from '../src/github-browser.mjs';
import { patchGitHubNavigation } from '../src/workbench-patch.mjs';
import { patchFunction } from '../src/bundle-patch.mjs';
import { createGitHubAuth } from '../src/github-auth.mjs';

const all = node => node && typeof node === 'object' ? [node, ...[node.props?.children, ...(node.children || [])].flat(Infinity).flatMap(all)] : [];
const h = (type, props, ...children) => ({ type, props: props || {}, children });

test('welcome and sidebar use theme-aware official marks and open the same accessible dialog entry', () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  let opened = 0;
  window.addEventListener(GITHUB_BROWSER_EVENT, () => opened++);
  try {
    for (const theme of ['forest-dark', 'forest-light']) {
      const { Entry } = createGitHubBrowser({ createElement: h }, () => ({ resolvedTheme: theme }));
      for (const variant of ['welcome', 'sidebar']) {
        const entry = Entry({ variant });
        assert.equal(entry.props['aria-haspopup'], 'dialog');
        assert.equal(entry.props['aria-label'], 'Browse GitHub repositories');
        assert.equal(entry.children[0].props.alt, '');
        assert.match(entry.children[0].props.src, new RegExp(`github-mark-${theme.endsWith('-dark') ? 'white' : 'black'}\\.svg$`));
        assert.equal(entry.children[1], variant === 'sidebar' ? 'GitHub' : 'Clone from GitHub');
        entry.props.onClick();
      }
    }
    assert.equal(opened, 4);
  } finally { globalThis.window = previous; }
});

test('existing local projects open directly, folder cancellation is harmless, and failures remain visible', async () => {
  const previous = globalThis.window, values = [], calls = [], opened = [];
  let cursor = 0, selection = null;
  const React = { createElement: h, useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; } };
  globalThis.window = { notchModels: { github: async action => { calls.push(action); return selection; } } };
  const { Browser } = createGitHubBrowser(React, () => ({}));
  const props = { projects: [{ id: 'existing', name: 'Existing clone', path: '/local/clone' }], onOpenProject: async directory => opened.push(directory) };
  const render = () => { cursor = 0; return all(Browser(props)); };
  const button = name => render().find(node => node.type === 'button' && (node.props['aria-label'] === name || node.children.includes(name)));
  try {
    await button('Open Existing clone').props.onClick();
    assert.deepEqual(opened, ['/local/clone']); assert.deepEqual(calls, []);
    await button('Open local repository…').props.onClick();
    assert.deepEqual(opened, ['/local/clone']);
    selection = '/another/clone';
    await button('Open local repository…').props.onClick();
    assert.deepEqual(opened, ['/local/clone', '/another/clone']);
    props.onOpenProject = async () => { throw Error('Project unavailable'); };
    await button('Open Existing clone').props.onClick();
    assert.equal(render().find(node => node.props.role === 'alert').children[0], 'Project unavailable');
    assert.equal(button('Open local repository…').props.disabled, false);
  } finally { globalThis.window = previous; }
});

test('the repository host preserves the current route on open/close and hands project navigation to the existing workspace service', async () => {
  const source = patchGitHubNavigation('const {Brand}=createNotchWorkbench(reactExports,useTheme,{ContentDialog});');
  assert.equal(patchGitHubNavigation(source), source);
  let hostBody;
  patchFunction(source, 'notchGitHubBrowserHost', body => { hostBody = body; return body; });
  const values = [], opened = [], local = { workspaceId: 'local', name: 'Clone', rootPaths: ['/local'] }, remote = { workspaceId: 'remote', name: 'SSH host', rootPaths: ['/remote'], remote: true };
  let cursor = 0, effect, loads = 0;
  const events = new EventTarget(), navigation = {}, service = { stateObs: {}, load: async () => { loads++; } };
  const React = { createElement: h, Fragment: 'fragment', useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; }, useEffect(fn) { effect ||= fn; } };
  const Host = new Function('reactExports', 'useServices', 'useNavigation', 'useObservableValue', 'window', 'isRemoteWorkspace', 'openClonedProject', 'ContentDialog', 'notchRepositoryBrowser', hostBody + ';return notchGitHubBrowserHost;')(
    React, () => ({ localWorkspaceService: service }), () => navigation, () => ({ workspaces: [local, remote, { ...local, workspaceId: 'archived', archived: true }] }), events, project => project.remote,
    async (...args) => opened.push(args), 'dialog', 'browser');
  const render = () => { cursor = 0; return Host(); };
  assert.equal(render(), null);
  const cleanup = effect(); events.dispatchEvent(new Event(GITHUB_BROWSER_EVENT));
  let dialog = render();
  assert.equal(dialog.props.title, 'Repositories');
  assert.deepEqual(all(dialog).find(node => node.type === 'browser').props.projects, [{ id: 'local', name: 'Clone', path: '/local' }]);
  assert.deepEqual(opened, []);
  dialog.props.onClose(); assert.equal(render(), null);
  events.dispatchEvent(new Event(GITHUB_BROWSER_EVENT)); dialog = render();
  await all(dialog).find(node => node.type === 'browser').props.onOpenProject('/local');
  assert.deepEqual(opened, [['/local', service, navigation]]);
  assert.equal(render(), null); assert.equal(loads, 2);
  cleanup(); events.dispatchEvent(new Event(GITHUB_BROWSER_EVENT)); assert.equal(render(), null);
});

test('opening a local repository uses the folder picker without requiring GitHub sign-in or touching credentials', async () => {
  const choices = [];
  const auth = createGitHubAuth({ pickDirectory: async purpose => { choices.push(purpose); return '/already/cloned'; }, run: async () => { throw Error('Authentication must not run'); } });
  assert.equal(await auth.pickLocal(), '/already/cloned');
  assert.deepEqual(choices, ['local']);
});
