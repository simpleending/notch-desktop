import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { originRepository, originCloneUrl } from '../src/origin-repository.mjs';
import { createOriginGit } from '../src/origin-git.mjs';
import { registerModelIpc, patchModelPreload, modelPreload } from '../src/model-ipc.mjs';

const run = promisify(execFile);
test('Origin accepts official HTTPS and SSH clone URLs without accepting credential leaks, other hosts or local paths', () => {
  for (const url of ['acme/rocket', 'https://origin.cursor.com/acme/rocket.git', 'https://origin.cursor.com/git/acme/rocket.git', 'git@origin.cursor.com:acme/rocket.git', 'ssh://git@origin.cursor.com/acme/rocket.git']) assert.equal(originRepository(url), 'acme/rocket');
  assert.equal(originCloneUrl('https://origin.cursor.com/git/acme/rocket.git', 'ssh'), 'https://origin.cursor.com/git/acme/rocket.git');
  assert.equal(originCloneUrl('acme/rocket', 'ssh'), 'git@origin.cursor.com:acme/rocket.git');
  assert.equal(originRepository('https://origin.cursor.com/git/rocket.git'), 'git/rocket');
  for (const url of ['https://origin.cursor.com.evil.invalid/acme/rocket', 'https://secret@origin.cursor.com/acme/rocket', 'http://origin.cursor.com/a/b', 'file:///a/b', 'ssh://user@origin.cursor.com/a/b', 'ssh://git@origin.cursor.com:444/a/b', 'git@github.com:a/b', 'a/..', 'https://origin.cursor.com/a/b.git/local', 'https://origin.cursor.com/a/b?token=secret']) assert.equal(originCloneUrl(url), null, url);
});

test('Origin uses the documented local CLI API, paginates namespaces and preserves repository clone URLs', async () => {
  const calls = [], pages = [
    { namespaces: [{ namespace: { slug: 'acme' } }], nextPageToken: 'next/a+b' },
    { namespaces: [{ namespace: { slug: 'personal' } }] },
    { repositories: [{ fullName: 'acme/rocket', cloneUrl: 'https://origin.cursor.com/git/acme/rocket.git', visibility: 'private', mirror: { source: 'github' } }], nextPageToken: 'more' },
  ];
  const origin = createOriginGit({ platform: 'linux', env: { CURSOR_API_KEY: 'synthetic-user-key' }, run: async (...args) => { calls.push(args); return { stdout: JSON.stringify(pages.shift()) }; } });
  assert.deepEqual((await origin.namespaces()).namespaces, ['acme', 'personal']);
  const result = await origin.repos({ owner: 'acme' });
  assert.deepEqual(calls.map(([file, args]) => [file, args]), [['origin', ['api', '/namespaces?pageSize=100']], ['origin', ['api', '/namespaces?pageSize=100&pageToken=next%2Fa%2Bb']], ['origin', ['api', '/repos/acme?pageSize=100']]]);
  assert.equal(result.repos[0].cloneUrl, 'https://origin.cursor.com/git/acme/rocket.git');
  assert.equal(result.repos[0].mirror, true); assert.equal(result.nextPageToken, 'more');
  assert.equal(JSON.stringify(result).includes('synthetic-user-key'), false);
});

test('Origin missing login, unsupported native Windows CLI and invalid server pagination are actionable without leaking output', async () => {
  const failed = createOriginGit({ platform: 'linux', env: {}, run: async () => { throw Error('token=synthetic-secret'); } });
  await assert.rejects(failed.namespaces(), error => /origin auth login/.test(error.message) && !error.message.includes('synthetic-secret'));
  const windows = createOriginGit({ platform: 'win32', run: async () => { throw Error('must not run'); } });
  assert.equal((await windows.status()).nativeCliSupported, false);
  await assert.rejects(windows.namespaces(), /Windows Git/);
  const invalid = createOriginGit({ platform: 'linux', env: {}, run: async () => ({ stdout: '{"namespaces":[],"nextPageToken":"repeat"}' }) });
  await assert.rejects(invalid.namespaces(), /pagination/);
});

test('Origin IPC validates namespaces, clone hosts, local folders, senders and repairs existing preloads', () => {
  const handlers = new Map(), calls = [], origin = Object.fromEntries(['status', 'namespaces', 'repos', 'remember', 'openRepo', 'clone'].map(action => [action, value => calls.push([action, value])]));
  registerModelIpc({ handle: (name, handler) => handlers.set(name, handler) }, { modelManager: {}, origin });
  const handler = handlers.get('notch-models:origin'), frame = { url: 'notch-app://renderer/index.html' }, event = { senderFrame: frame, sender: { mainFrame: frame } };
  handler(event, 'repos', { owner: 'acme', pageToken: 'opaque' });
  handler(event, 'clone', 'git@origin.cursor.com:acme/rocket.git');
  for (const [action, value] of [['repos', { owner: '../escape' }], ['repos', { owner: 'acme', pageToken: {} }], ['clone', 'https://evil.invalid/acme/rocket'], ['remember', ['relative']], ['status', 'extra'], ['logout', undefined]]) assert.throws(() => handler(event, action, value));
  assert.throws(() => handler({ senderFrame: { url: 'https://evil.invalid' } }, 'status'), /primary/);
  const patched = patchModelPreload('const bridge={github:(action,value)=>ipcRenderer.invoke(\'notch-models:github\',action,value)};');
  assert.match(patched, /notch-models:origin/); assert.equal(patchModelPreload(patched), patched); assert.match(modelPreload, /notch-models:origin/);
  assert.equal(calls.length, 2);
});

test('Origin Git clone, pull, push and restart deduplication work with a real local Git transport fixture', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-origin-git-'));
  t.after(async () => { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const bare = path.join(directory, 'remote.git'), seed = path.join(directory, 'seed');
  await run('git', ['init', '--bare', '--initial-branch=main', bare]);
  await run('git', ['clone', bare, seed]); await fs.writeFile(path.join(seed, 'fixture.txt'), 'seed');
  const git = (cwd, args, env) => run('git', ['-C', cwd, ...args], { env });
  for (const cwd of [seed]) { await git(cwd, ['config', 'user.name', 'Origin QA']); await git(cwd, ['config', 'user.email', 'qa@example.invalid']); }
  await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'seed']); await git(seed, ['push', 'origin', 'main']);
  for (const protocol of ['https', 'ssh']) {
    const url = originCloneUrl('acme/rocket', protocol), parent = path.join(directory, protocol), profile = path.join(directory, `${protocol}-profile`); await fs.mkdir(parent);
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare.replaceAll('\\', '/')}.insteadOf`, GIT_CONFIG_VALUE_0: url, GIT_ALLOW_PROTOCOL: 'file' };
    let selections = 0, clones = 0;
    const options = { directory: profile, env, run: async (file, args, options) => { if (args[0] === 'clone') clones++; return run(file, args, options); }, pickDirectory: async () => { selections++; return parent; } };
    const cloned = (await createOriginGit(options).clone(url)).clonedPath;
    assert.equal((await git(cloned, ['config', '--get', 'remote.origin.url'])).stdout.trim(), url);
    await git(cloned, ['config', 'user.name', 'Origin QA']); await git(cloned, ['config', 'user.email', 'qa@example.invalid']);
    await fs.writeFile(path.join(seed, `${protocol}-pull.txt`), protocol); await git(seed, ['add', '.']); await git(seed, ['commit', '-m', 'pull fixture']); await git(seed, ['push', 'origin', 'main']);
    await git(cloned, ['pull', '--ff-only', 'origin', 'main'], env); assert.equal(await fs.readFile(path.join(cloned, `${protocol}-pull.txt`), 'utf8'), protocol);
    await fs.writeFile(path.join(cloned, `${protocol}-push.txt`), protocol); await git(cloned, ['add', '.']); await git(cloned, ['commit', '-m', 'push fixture']); await git(cloned, ['push', 'origin', 'main'], env);
    await git(seed, ['pull', '--ff-only', 'origin', 'main']); assert.equal(await fs.readFile(path.join(seed, `${protocol}-push.txt`), 'utf8'), protocol);
    const restarted = createOriginGit(options); assert.equal((await restarted.clone(url)).clonedPath, await fs.realpath(cloned));
    assert.equal((await restarted.openRepo('acme/rocket')).clonedPath, await fs.realpath(cloned)); assert.equal(clones, 1); assert.equal(selections, 1);
  }
});

test('cancelled and failed Origin clones can be retried and do not expose process output', async () => {
  let selection = null, calls = 0;
  const origin = createOriginGit({ env: {}, pickDirectory: async () => selection, run: async () => { calls++; throw Error('secret-token'); } });
  assert.equal((await origin.clone('acme/rocket')).clonedPath, undefined); assert.equal(calls, 0);
  selection = os.tmpdir();
  for (let n = 0; n < 2; n++) await assert.rejects(origin.clone('acme/rocket'), error => /registered SSH key/.test(error.message) && !error.message.includes('secret-token'));
  assert.equal(calls, 2);
});
