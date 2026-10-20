import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchGitPublishDialog } from '../src/git-publish-patch.mjs';

// Released dialog fixture keeps the patch checked against the inherited component.
const fixture = readFileSync(new URL('./fixtures/git-publish-dialog.mjs', import.meta.url), 'utf8');
const patched = patchGitPublishDialog(fixture);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}) {
  let cursor = 0;
  const state = [], closed = [], requests = [], toasts = [];
  const jsx = (type, props) => ({ type, props });
  const scope = {
    reactExports: {
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
      useRef(value) { return { current: value }; }, useEffect() {},
    },
    jsxRuntimeExports: { jsx, jsxs: jsx },
    useTranslation: () => ({ t: key => key, i18n: { resolvedLanguage: 'en-US' } }),
    isChangeInReviewSource: (file, source) => source === 'unstaged' ? file.category === 'untracked' : file.category === 'staged',
    summarizeChanges: files => ({ additions: files.length, deletions: 0 }),
    isGitBranchName: name => !!name,
    workspaceGitErrorMessage: error => error.message,
    workspaceGitErrorText: code => code,
    toast: Object.fromEntries(['error', 'success', 'warning'].map(type => [type, (...args) => toasts.push({ type, args })])),
    ...Object.fromEntries(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'Button', 'Input', 'Textarea', 'Checkbox', 'notchGitBranchLine', 'notchArrowDownSLine', 'notchCheckLine', 'notchLoaderLine'].map(name => [name, name])),
  };
  const component = new Function(...Object.keys(scope), patched + ';return GitPublishDialog;')(...Object.values(scope));
  const props = {
    open: true,
    repository: { label: 'Test project', status: { available: true, branch: 'main', generation: 4, repositoryRoot: '/test', files: [{ category: 'untracked' }] } },
    onOpenChange: value => closed.push(value),
    onCommit: async request => { requests.push(request); return { commit: { summary: 'Saved' }, pushError: null }; },
    onPush: async () => ({ remote: 'origin', branch: 'main' }),
    onGenerateCommitMessage: async () => ({ message: 'Generated', generation: 4 }),
    ...overrides,
  };
  function nodes(node) { return node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] : []; }
  const render = () => { cursor = 0; return nodes(component(props)); };
  const control = name => render().find(node => node.props?.['data-workspace-git-' + name]);
  const write = message => control('commit-message').props.onChange({ target: { value: message } });
  const click = async name => { control(name).props.onClick(); await flush(); };
  return { props, render, control, write, click, closed, requests, toasts };
}

test('commit failures stay in the dialog, retain the message and snapshot guard, and clear after a successful retry', async () => {
  const h = harness();
  const original = h.props.onCommit;
  h.props.onCommit = async request => { h.requests.push(request); throw Error('STALE_REPOSITORY'); };
  h.write('My commit');
  assert.equal(h.control('include-unstaged').props['aria-label'], 'workspace.review.includeUnstaged');
  await h.click('commit-push-action');
  assert.equal(h.control('error').props.role, 'alert');
  assert.equal(h.control('error').props.children, 'STALE_REPOSITORY');
  assert.equal(h.control('commit-message').props.value, 'My commit');
  assert.equal(h.requests[0].expectedGeneration, 4);
  assert.equal(h.requests[0].includeUnstaged, true);
  assert.deepEqual(h.closed, []);
  h.props.onCommit = original;
  await h.click('commit-push-action');
  assert.equal(h.control('error'), undefined);
  assert.deepEqual(h.closed, [false]);
});

test('a rejected push preserves the successful commit and offers push again without creating another commit', async () => {
  const h = harness({ onCommit: async () => ({ commit: { summary: 'Saved' }, pushError: 'AUTH_REQUIRED' }) });
  h.write('My commit');
  await h.click('commit-push-action');
  assert.match(h.control('error').props.children, /commitSucceededPushFailed.*AUTH_REQUIRED/);
  assert.deepEqual(h.closed, []);
  h.props.repository.status.files = [];
  assert.equal(h.control('commit-push-action').props.disabled, true);
  assert.equal(h.control('push-action').props.disabled, false);
  h.props.onPush = async () => { throw Error('NON_FAST_FORWARD'); };
  await h.click('push-action');
  assert.equal(h.control('error').props.children, 'NON_FAST_FORWARD');
  assert.deepEqual(h.closed, []);
  h.props.onPush = async () => ({ remote: 'origin', branch: 'main' });
  await h.click('push-action');
  assert.equal(h.control('error'), undefined);
  assert.deepEqual(h.closed, [false]);
});

test('commit message generation failures are visible and never submit a commit', async () => {
  const h = harness({ onGenerateCommitMessage: async () => { throw Error('MODEL_UNAVAILABLE'); } });
  await h.click('commit-action');
  assert.equal(h.control('error').props.children, 'MODEL_UNAVAILABLE');
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.closed, []);
});

test('the patch is idempotent and fails clearly if the inherited dialog changes', () => {
  assert.equal(patchGitPublishDialog(patched), patched);
  assert.equal(patchGitPublishDialog('function other(){}'), 'function other(){}');
  assert.throws(() => patchGitPublishDialog(fixture.replace('catch(K1){toast.error(', 'catch(K1){changed(')), /anchor changed/);
});
