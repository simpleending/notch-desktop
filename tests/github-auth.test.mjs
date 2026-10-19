import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGitHubAuth, parseDeviceCode, parseGitHubAccount, redactGitHubOutput, safeDeviceUrl, REPO_NAME } from '../src/github-auth.mjs';
import { registerModelIpc, patchModelPreload, modelPreload } from '../src/model-ipc.mjs';

test('device codes and account names stay separate from tokens', () => {
  assert.equal(parseDeviceCode('! First copy your one-time code: ABCD-EFGH'), 'ABCD-EFGH');
  assert.equal(parseGitHubAccount('Logged in to github.com account octocat\n  - Token: gho_secretvalue'), 'octocat');
  assert.equal(safeDeviceUrl('https://github.com/login/device?user_code=ABCD-EFGH'), 'https://github.com/login/device?user_code=ABCD-EFGH');
  assert.equal(safeDeviceUrl('https://evil.example/login/device'), null);
  assert.equal(redactGitHubOutput('token gho_secretvalue\n  - Token: gho_secretvalue'), 'token [token]');
  assert.equal(JSON.stringify({ account: parseGitHubAccount('Logged in as octocat') }).includes('gho_'), false);
});

test('Windows install uses the official WinGet package id', async () => {
  const calls = [];
  let installed = false;
  const gh = path.join('C:\\Program Files', 'GitHub CLI', 'gh.exe');
  const winget = path.join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'WindowsApps', 'winget.exe');
  const auth = createGitHubAuth({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: async file => file === winget || (installed && file === gh),
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === winget) installed = true;
      if (args[0] === 'auth') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });
  const status = await auth.install();
  assert.equal(status.installed, true);
  assert.deepEqual(calls.find(call => call[0] === winget)[1], ['install', '--id', 'GitHub.cli', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']);
});

test('browser sign-in opens only the GitHub device page and hides the token', async () => {
  const gh = path.join('C:\\Program Files', 'GitHub CLI', 'gh.exe');
  let opened = '';
  let seen = '';
  let auth;
  auth = createGitHubAuth({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', GITHUB_TOKEN: 'gho_fromenv' },
    exists: async file => file === gh,
    run: async (_file, args) => {
      if (args[0] === 'auth' && args[1] === 'status') return { stdout: '', stderr: 'Logged in to github.com account octocat\n  - Token: gho_secretvalue' };
      return { stdout: '', stderr: '' };
    },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => child.emit('close', 1);
      setImmediate(() => {
        child.stderr.emit('data', '! First copy your one-time code: WXYZ-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
        setImmediate(async () => { seen = (await auth.status()).code; child.emit('close', 0); });
      });
      return child;
    },
    openExternal: async url => { opened = url; },
  });
  const status = await auth.login();
  assert.equal(opened, 'https://github.com/login/device');
  assert.equal(status.account, 'octocat');
  assert.equal(seen, 'WXYZ-1234');
  assert.equal(JSON.stringify(status).includes('gho_secretvalue'), false);
  assert.equal(JSON.stringify(status).includes('gho_fromenv'), false);
  assert.equal(status.environmentToken, true);
});

test('clone accepts only listed owner/name repositories', async () => {
  const gh = '/usr/bin/gh';
  const calls = [];
  const auth = createGitHubAuth({
    platform: 'linux',
    env: {},
    exists: async file => file === gh,
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === 'which') return { stdout: `${gh}\n`, stderr: '' };
      if (args[1] === 'status') return { stdout: 'Logged in to github.com account octocat', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    pickDirectory: async () => '/work',
  });
  await assert.rejects(auth.clone('octocat/../evil'), /repository from the list/);
  assert.equal(REPO_NAME.test('octocat/hello'), true);
  const status = await auth.clone('octocat/hello');
  assert.match(status.message, /Cloned octocat\/hello/);
  assert.deepEqual(calls.find(call => call[1][0] === 'repo'), [gh, ['repo', 'clone', 'octocat/hello', path.join('/work', 'hello')]]);
});

test('GitHub settings IPC rejects unexpected actions and repairs the preload', async () => {
  const handlers = new Map();
  const github = { status: async () => ({ installed: false }), install() {}, login() {}, cancel() {}, repos() {}, clone() {} };
  registerModelIpc({ handle: (key, fn) => handlers.set(key, fn) }, { modelManager: {}, github });
  const frame = { url: 'notch-app://renderer/index.html' };
  const handle = handlers.get('notch-models:github');
  assert.deepEqual(await handle({ senderFrame: frame, sender: { mainFrame: frame } }, 'status'), { installed: false });
  assert.throws(() => handle({ senderFrame: frame, sender: { mainFrame: frame } }, 'shell'), /supported GitHub action/);
  assert.throws(() => handle({ senderFrame: frame, sender: { mainFrame: frame } }, 'clone', 'not a repo'), /repository from the list/);
  assert.match(modelPreload, /notch-models:github/);
  assert.equal(patchModelPreload(modelPreload), modelPreload);
  const previous = modelPreload.replace("\n  github:(action,value)=>ipcRenderer.invoke('notch-models:github',action,value),", '');
  assert.equal(patchModelPreload(previous), modelPreload);
});
