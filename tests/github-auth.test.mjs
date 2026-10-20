import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGitHubAuth, parseDeviceCode, parseGitHubAccount, redactGitHubOutput, safeDeviceUrl, REPO_NAME } from '../src/github-auth.mjs';
import { registerModelIpc, patchModelPreload, modelPreload } from '../src/model-ipc.mjs';
import { githubRepository, githubCloneUrl } from '../src/github-repository.mjs';

test('pasted GitHub repository URLs normalize without accepting other hosts or traversal', () => {
  for (const value of [' owner/repo ', 'https://github.com/owner/repo.git', 'https://github.com/owner/repo/?tab=readme', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) assert.equal(githubRepository(value), 'owner/repo');
  for (const value of ['http://github.com/owner/repo', 'https://github.com.evil.example/owner/repo', 'https://secret@github.com/owner/repo', 'https://github.com:444/owner/repo', 'ssh://other@github.com/owner/repo', 'ssh://git:secret@github.com/owner/repo', 'ssh://git@github.com:2222/owner/repo', 'ssh://git@evil.example/owner/repo', 'owner/..', 'owner/repo/tree/main', null]) assert.equal(githubRepository(value), null);
});

test('overlapping clone requests cannot open two destination pickers', async () => {
  let selected, pickerEntered;
  const entered = new Promise(resolve => { pickerEntered = resolve; });
  const auth = createGitHubAuth({ env: {}, platform: 'linux', exists: async () => true,
    run: async (file, args) => ({ stdout: file === 'which' ? '/usr/bin/gh' : JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'user' }] } }) }),
    pickDirectory: () => { pickerEntered(); return new Promise(resolve => { selected = resolve; }); },
  });
  const first = auth.clone('team/project'); await entered;
  await assert.rejects(auth.clone('team/project'), /already running/);
  selected(null); await first;
});

test('clone URL preserves explicit SSH and HTTPS and applies the chosen protocol to repository names', () => {
  assert.equal(githubCloneUrl('owner/repo'), 'https://github.com/owner/repo.git');
  assert.equal(githubCloneUrl('owner/repo', 'ssh'), 'git@github.com:owner/repo.git');
  assert.equal(githubCloneUrl('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
  assert.equal(githubCloneUrl('ssh://git@github.com/owner/repo.git'), 'git@github.com:owner/repo.git');
  assert.equal(githubCloneUrl('https://github.com/owner/repo', 'ssh'), 'https://github.com/owner/repo.git');
  assert.equal(githubCloneUrl('owner/repo', 'file'), null);
});

test('SSH clone survives settings IPC, GitHub CLI and the system SSH environment without an HTTPS fallback', async () => {
  const calls = [], handlers = new Map();
  const auth = createGitHubAuth({ platform: 'linux', env: { GIT_SSH_COMMAND: 'ssh -i local-key', SSH_AUTH_SOCK: '/local/agent' }, exists: async () => true,
    pickDirectory: async () => '/work', run: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      if (file === 'which') return { stdout: '/usr/bin/gh', stderr: '' };
      if (args[1] === 'status') return { stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'user' }] } }), stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });
  registerModelIpc({ handle: (key, fn) => handlers.set(key, fn) }, { modelManager: {}, github: auth });
  const frame = { url: 'notch-app://renderer/index.html' }, event = { senderFrame: frame, sender: { mainFrame: frame } };
  await handlers.get('notch-models:github')(event, 'clone', 'git@github.com:team/project.git');
  const clone = calls.find(call => call.args[0] === 'repo');
  assert.deepEqual(clone.args, ['repo', 'clone', 'git@github.com:team/project.git', path.join('/work', 'project')]);
  assert.equal(clone.env.GIT_SSH_COMMAND, 'ssh -i local-key');
  assert.equal(clone.env.SSH_AUTH_SOCK, '/local/agent');
  assert.throws(() => handlers.get('notch-models:github')(event, 'clone', 'ssh://git@evil.example/team/project'), /GitHub repository/);
});

test('failed GitHub CLI discovery and process startup leave sign-in retryable', async () => {
  const missing = createGitHubAuth({ platform: 'linux', env: {}, exists: async () => false, run: async () => { throw Error('not found'); } });
  for (let i = 0; i < 2; i++) { await assert.rejects(missing.login(), /Install GitHub CLI/); assert.equal((await missing.status()).phase, 'ready'); }
  const broken = createGitHubAuth({ platform: 'linux', env: {}, exists: async () => true, run: async () => ({ stdout: '/usr/bin/gh' }), spawnProcess() { throw Error('cannot start'); } });
  for (let i = 0; i < 2; i++) { await assert.rejects(broken.login(), /cannot start/); assert.equal((await broken.status()).phase, 'ready'); }
});

test('device codes and account names stay separate from tokens', () => {
  assert.equal(parseDeviceCode('! First copy your one-time code: ABCD-EFGH'), 'ABCD-EFGH');
  assert.equal(parseGitHubAccount('Logged in to github.com account octocat\n  - Token: gho_secretvalue'), 'octocat');
  assert.equal(safeDeviceUrl('https://github.com/login/device?user_code=ABCD-EFGH'), 'https://github.com/login/device?user_code=ABCD-EFGH');
  assert.equal(safeDeviceUrl('https://evil.example/login/device'), null);
  assert.equal(redactGitHubOutput('token gho_secretvalue\n  - Token: gho_secretvalue'), 'token [token]');
  assert.equal(JSON.stringify({ account: parseGitHubAccount('Logged in as octocat') }).includes('gho_'), false);
});

test('environment-token sign-in and clone use GitHub and local Git without a website account or gh',async()=>{
  const calls=[];
  const auth=createGitHubAuth({env:{GH_TOKEN:'fixture-device-token'},exists:async()=>false,pickDirectory:async()=>path.resolve('device-projects'),fetchApi:async url=>{
    assert.equal(url,'https://api.github.com/user');return Response.json({login:'device-user'});
  },run:async(file,args,options)=>{calls.push({file,args,env:options?.env});return {stdout:'',stderr:''};}});
  assert.equal((await auth.status()).account,'device-user');
  const result=await auth.clone('organization/project');
  const clone=calls.find(call=>call.file==='git');
  assert.deepEqual(clone.args,['clone','https://github.com/organization/project.git',path.resolve('device-projects','project')]);
  assert.equal(clone.env.GIT_CONFIG_KEY_1,'http.https://github.com/.extraheader');
  assert.equal(clone.env.GIT_CONFIG_VALUE_1,'Authorization: Basic '+Buffer.from('x-access-token:fixture-device-token').toString('base64'));
  assert.equal(result.clonedPath,path.resolve('device-projects','project'));
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
  let gitConfigured = false;
  let auth;
  auth = createGitHubAuth({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: async file => file === gh,
    run: async (_file, args) => {
      if (args[0] === 'auth' && args[1] === 'setup-git') { assert.deepEqual(args,['auth','setup-git','--hostname','github.com']); gitConfigured=true; }
      if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'octocat' }] } }), stderr: '' };
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
  assert.equal(status.environmentToken, false);
  assert.equal(gitConfigured,true);
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
      if (args[1] === 'status') return { stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'octocat' }] } }), stderr: '' };
      return { stdout: '', stderr: '' };
    },
    pickDirectory: async () => '/work',
  });
  await assert.rejects(auth.clone('octocat/../evil'), /repository from the list/);
  assert.equal(REPO_NAME.test('octocat/hello'), true);
  const status = await auth.clone('octocat/hello');
  assert.match(status.message, /Cloned octocat\/hello/);
  assert.equal(status.clonedPath, path.join('/work', 'hello'));
  assert.equal((await auth.status()).message, status.message);
  assert.deepEqual(calls.find(call => call[1][0] === 'repo'), [gh, ['repo', 'clone', 'https://github.com/octocat/hello.git', path.join('/work', 'hello')]]);
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

test('effective environment token is preserved for status and organization repository pages', async () => {
  const calls = [];
  const auth = createGitHubAuth({ platform: 'linux', env: { GH_TOKEN: 'fake-preferred', GITHUB_TOKEN: 'fake-other', GH_HOST: 'elsewhere.example' }, exists: async () => true,
    run: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      if (file === 'which') return { stdout: '/usr/bin/gh', stderr: '' };
      if (args[0] === 'auth') return { stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'effective-user' }] } }), stderr: '' };
      const rows = args.at(-1).endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ full_name: `team/project-${i}`, private: true })) : [{ full_name: 'collaborator/shared', private: true }];
      return { stdout: JSON.stringify(rows), stderr: '' };
    },
  });
  const status = await auth.status();
  assert.equal(status.account, 'effective-user');
  assert.match(status.message, /using GH_TOKEN/);
  const first = await auth.repos();
  assert.equal(first.repos.length, 100); assert.equal(first.hasMore, true);
  const second = await auth.repos(2);
  assert.equal(second.repos.length, 101); assert.equal(second.hasMore, false);
  assert.ok(calls.filter(call => call.args[0] === 'api').every(call => call.args.at(-1).includes('organization_member')));
  assert.ok(calls.every(call => call.env.GH_TOKEN === 'fake-preferred' && call.env.GH_HOST === 'github.com'));
  await assert.rejects(auth.login(), /Remove GH_TOKEN/);
});

test('an invalid active account never falls back to an inactive account', async () => {
  let checks = 0;
  const auth = createGitHubAuth({ platform: 'linux', env: {}, exists: async () => true,
    run: async file => {
      if (file === 'which') return { stdout: '/usr/bin/gh', stderr: '' };
      checks += 1;
      return { stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'error', login: 'invalid' }, { active: false, state: 'success', login: 'old' }] } }), stderr: '' };
    },
  });
  assert.equal((await auth.status()).account, null);
  assert.equal((await auth.status()).account, null);
  assert.equal(checks, 1, 'polling reuses the recent authentication check');
  await assert.rejects(auth.repos(), /repair authentication/);
});

test('environment tokens work without an installed GitHub CLI', async () => {
  const requests = [];
  const auth = createGitHubAuth({ platform: 'linux', env: { GH_TOKEN: 'fake-preferred', GITHUB_TOKEN: 'fake-other' }, exists: async () => false,
    run: async () => { throw Error('not installed'); },
    fetchApi: async (url, options) => { requests.push({ url, options }); return Response.json(url.endsWith('/user') ? { login: 'token-user' } : [{ full_name: 'organization/private', private: true }]); },
  });
  assert.equal((await auth.status()).account, 'token-user');
  assert.equal((await auth.repos()).repos[0].nameWithOwner, 'organization/private');
  assert.ok(requests.every(row => row.options.headers.Authorization === 'Bearer fake-preferred'));
});

test('cancelling login ends the pending operation without a false sign-in error', async () => {
  let child;
  const auth = createGitHubAuth({ platform: 'linux', env: {}, exists: async () => true,
    run: async file => ({ stdout: file === 'which' ? '/usr/bin/gh' : JSON.stringify({ hosts: {} }), stderr: '' }),
    spawnProcess: () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 1); return child; },
  });
  const pending = auth.login();
  while (!child) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await auth.cancel()).phase, 'ready');
  const result = await pending;
  assert.match(result.message, /cancelled/);
  assert.equal(result.account, null);
});

test('cancelling before executable discovery completes cannot open a browser later', async () => {
  let release, announce, lookups = 0, spawned = false;
  const started = new Promise(resolve => { announce = resolve; });
  const auth = createGitHubAuth({ platform: 'linux', env: {}, exists: async () => true,
    run: async file => {
      if (file === 'which') {
        if (++lookups === 1) { announce(); await new Promise(resolve => { release = resolve; }); }
        return { stdout: '/usr/bin/gh', stderr: '' };
      }
      return { stdout: JSON.stringify({ hosts: {} }), stderr: '' };
    },
    spawnProcess: () => { spawned = true; throw Error('must not start'); },
  });
  const login = auth.login(); await started;
  await auth.cancel(); release();
  assert.equal((await login).phase, 'ready');
  assert.equal(spawned, false);
});
