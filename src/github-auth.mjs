import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitProcessEnv } from '../vendor/notch-core/desktop-harness.js';
import { githubRepository, githubCloneUrl } from './github-repository.mjs';
import { createLocalRepositories } from './local-repositories.mjs';

export const DEVICE_URL = 'https://github.com/login/device';
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

export function parseDeviceCode(text) {
  return String(text).match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1] ?? null;
}

export function parseGitHubAccount(text) {
  const plain = String(text).replace(/\u001b\[[0-9;]*m/g, '');
  return plain.match(/Logged in to github\.com account ([A-Za-z0-9-]+)/)?.[1]
    ?? plain.match(/Logged in as ([A-Za-z0-9-]+)/)?.[1]
    ?? null;
}

export function safeDeviceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== '/login/device') return null;
    return url.toString();
  } catch { return null; }
}

export function redactGitHubOutput(text) {
  return String(text)
    .replace(/\b(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, '[token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[token]')
    .split(/\r?\n/)
    .filter(line => !/^\s*-?\s*Token:/i.test(line))
    .join('\n')
    .trim()
    .slice(0, 500);
}

export function gitHubChildEnv(env, browserLogin = false) {
  const next = { ...env };
  if (browserLogin) for (const key of TOKEN_ENV) delete next[key];
  next.GH_HOST = 'github.com';
  return next;
}

function executableName(platform) {
  return platform === 'win32' ? 'gh.exe' : 'gh';
}

export function acceptGitHubExecutable(file, platform) {
  return !!file && path.basename(file).toLowerCase() === executableName(platform);
}

function defaultRun(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout ?? 20_000, maxBuffer: 1024 * 1024, env: options.env }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (error) { error.stdout = result.stdout; error.stderr = result.stderr; reject(error); return; }
      resolve(result);
    });
  });
}

async function fileExists(file, exists) {
  if (exists) return exists(file);
  try { await fs.access(file); return true; } catch { return false; }
}

export async function locateGitHubCli({ platform = process.platform, env = process.env, run = defaultRun, exists } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, 'GitHub CLI', 'gh.exe'));
    }
    const where = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'where.exe') : 'where.exe';
    try {
      const { stdout } = await run(where, ['gh.exe'], { timeout: 5000, env });
      candidates.unshift(...stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    } catch { /* GitHub CLI is not on PATH yet. */ }
  } else {
    try {
      const { stdout } = await run('which', ['gh'], { timeout: 5000, env });
      candidates.unshift(...stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    } catch { /* GitHub CLI is not on PATH yet. */ }
  }
  for (const file of candidates) {
    if (!acceptGitHubExecutable(file, platform)) continue;
    if (await fileExists(file, exists)) return file;
  }
  return null;
}

async function locateInstaller(platform, env, run, exists) {
  if (platform === 'win32') {
    const candidates = [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe') : ''].filter(Boolean);
    const where = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'where.exe') : 'where.exe';
    try {
      const { stdout } = await run(where, ['winget.exe'], { timeout: 5000, env });
      candidates.unshift(...stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    } catch { /* WinGet is optional. */ }
    for (const file of candidates) if (path.basename(file).toLowerCase() === 'winget.exe' && await fileExists(file, exists)) return { file, args: ['install', '--id', 'GitHub.cli', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] };
    return null;
  }
  if (platform === 'darwin') {
    const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    try {
      const { stdout } = await run('which', ['brew'], { timeout: 5000, env });
      candidates.unshift(...stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    } catch { /* Homebrew is optional. */ }
    for (const file of candidates) {
      if (path.basename(file) !== 'brew' || !await fileExists(file, exists)) continue;
      return { file, args: ['install', 'gh'] };
    }
  }
  return null;
}

function emptyState(extra = {}) {
  return { installed: false, account: null, phase: 'ready', code: null, url: DEVICE_URL, message: '', environmentToken: false, repos: null, ...extra };
}

export function createGitHubAuth({
  platform = process.platform, env = process.env, run = defaultRun, spawnProcess = spawn,
  openExternal = async () => {}, pickDirectory = async () => null, exists, fetchApi = fetch, directory,
} = {}) {
  let phase = 'ready', code = null, url = DEVICE_URL, message = '', loginChild = null;
  let repos = null, repoPage = 0, hasMore = false, clonedPath = null;
  let cached = null, checkedAt = 0, checking = null, loginGeneration = 0;
  const childEnv = () => gitHubChildEnv(env);
  const clones = createLocalRepositories(directory, { run, env: childEnv, platform });
  let cloneBusy = false;
  const environmentToken = () => !!(env.GH_TOKEN || env.GITHUB_TOKEN);

  async function status(force = false) {
    if (force) checkedAt = 0;
    if (!cached || Date.now() - checkedAt >= 15_000) {
      checking ||= (async () => {
        const installedPath = await locateGitHubCli({ platform, env: childEnv(), run, exists });
        let account = null;
        try {
          if (installedPath) {
            const result = await run(installedPath, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], { timeout: 15_000, env: childEnv() });
            account = JSON.parse(result.stdout).hosts?.['github.com']?.find(row => row.active === true && row.state === 'success')?.login || null;
          } else if (environmentToken()) {
            const response = await fetchApi('https://api.github.com/user', { headers: { Authorization: `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(15_000) });
            if (response.ok) account = (await response.json()).login || null;
          }
        } catch { /* Never report an inactive or invalid account as signed in. */ }
        if (cached?.account !== account) { repos = null; repoPage = 0; hasMore = false; if (cached && phase === 'ready') message = ''; }
        cached = { installed: !!installedPath, account, installedPath };
        checkedAt = Date.now();
      })().finally(() => { checking = null; });
      await checking;
    }
    const { installed, account } = cached;
    const source = env.GH_TOKEN ? 'GH_TOKEN' : 'GITHUB_TOKEN';
    const summary = environmentToken()
      ? account ? `Signed in as ${account} using ${source}.` : `${source} is configured but GitHub could not validate it. Update or remove it to use browser sign-in.`
      : account ? `Signed in as ${account}.` : installed ? 'Sign in with GitHub to clone and push, or sign in again to repair authentication.' : 'Install GitHub CLI, then sign in with the browser.';
    return emptyState({ installed, account, phase, code, url, message: message || summary, environmentToken: environmentToken(), repos, repoPage, hasMore, clonedPath, localClones: await clones.snapshot(force) });
  }

  return {
    status,
    async pickLocal() {
      const selected = await pickDirectory('local');
      if (selected) await clones.remember([selected]);
      return selected;
    },
    async remember(paths) {
      await clones.remember(paths);
      return status();
    },
    async openRepo(repo) {
      const name = githubRepository(repo)?.toLowerCase();
      const localPath = name && (await clones.snapshot(true))[name];
      if (!localPath) throw Error('The local clone is no longer available. Refresh repositories or open its current folder.');
      clonedPath = localPath; message = `Opening ${githubRepository(repo)} from ${localPath}.`;
      return status();
    },
    async install(fromLogin = false) {
      if (phase !== 'ready' && !(fromLogin && phase === 'waiting')) throw new Error('GitHub setup is already running.');
      if (await locateGitHubCli({ platform, env: childEnv(), run, exists })) return status(true);
      const installer = await locateInstaller(platform, env, run, exists);
      if (!installer) throw new Error('Install GitHub CLI from https://cli.github.com/ and then sign in.');
      phase = 'installing'; message = 'Installing GitHub CLI…';
      try {
        try { await run(installer.file, installer.args, { timeout: 600_000, env: childEnv() }); }
        catch (error) {
          if (!await locateGitHubCli({ platform, env: childEnv(), run, exists })) throw new Error(redactGitHubOutput(error.stderr || error.message) || 'GitHub CLI installation failed.');
        }
      } finally { phase = 'ready'; message = ''; }
      const next = await status(true);
      if (!next.installed) throw new Error('GitHub CLI installed, but is not available yet. Restart notch and try again.');
      return next;
    },
    async login() {
      if (environmentToken()) throw new Error('Remove GH_TOKEN and GITHUB_TOKEN from the environment before browser sign-in, or update the configured token.');
      if (phase !== 'ready' || loginChild) throw new Error('GitHub setup is already running.');
      const generation = ++loginGeneration;
      phase = 'waiting'; code = null; message = 'Starting GitHub sign-in…';
      let gh;
      try {
        gh = await locateGitHubCli({ platform, env: childEnv(), run, exists });
        if (generation !== loginGeneration) return status();
        if (!gh) { await this.install(true); gh = await locateGitHubCli({ platform, env: childEnv(), run, exists }); }
        if (generation !== loginGeneration) return status();
        if (!gh) throw new Error('GitHub CLI is not installed.');
        phase = 'waiting'; code = null; url = DEVICE_URL; message = 'Waiting for the one-time code…';
      } catch (error) {
        if (generation !== loginGeneration) return status();
        phase = 'ready'; code = null; message = '';
        throw error;
      }
      let child;
      try { child = spawnProcess(gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitHubChildEnv(env, true) }); }
      catch (error) { phase = 'ready'; code = null; message = ''; throw error; }
      loginChild = child;
      let output = '', opened = false, setupWarning = '';
      const take = chunk => {
        if (generation !== loginGeneration) return;
        output += String(chunk);
        if (output.length > 100_000) { child.kill(); return; }
        code = parseDeviceCode(output);
        const found = output.match(/https:\/\/github\.com\/login\/device[^\s)'"]*/);
        url = found && safeDeviceUrl(found[0]) || DEVICE_URL;
        if (code && !opened) { opened = true; message = `Enter ${code} in the browser.`; Promise.resolve(openExternal(url)).catch(() => {}); }
      };
      child.stdout?.on('data', take); child.stderr?.on('data', take);
      try {
        const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        if (generation !== loginGeneration) return status();
        if (exitCode !== 0) throw new Error(redactGitHubOutput(output) || `GitHub sign-in exited with status ${exitCode}.`);
        try { await run(gh, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: 20_000, env: childEnv() }); }
        catch (error) { setupWarning = redactGitHubOutput(error.stderr || error.message); }
      } finally { if (loginChild === child) { loginChild = null; phase = 'ready'; code = null; message = ''; } }
      const next = await status(true);
      if (!next.account) throw new Error('GitHub sign-in did not finish. Sign in again.');
      if (setupWarning) message = next.message = `${next.message} Git credential setup needs another try: ${setupWarning}`;
      if (/credentials saved in plain text/i.test(output)) message = next.message = `${next.message} GitHub CLI could not use secure storage and saved credentials in its configuration file.`;
      return next;
    },
    async cancel() {
      loginGeneration += 1;
      const child = loginChild; loginChild = null;
      phase = 'ready'; code = null; message = 'GitHub sign-in cancelled.';
      child?.kill();
      return status();
    },
    async repos(page = 1) {
      if (!Number.isSafeInteger(page) || page < 1 || (page !== 1 && page !== repoPage + 1)) throw new Error('Choose the next repository page.');
      const current = await status(true);
      if (!current.account) throw new Error(current.message);
      const endpoint = `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`;
      let rows;
      if (cached.installedPath) rows = JSON.parse((await run(cached.installedPath, ['api', '--hostname', 'github.com', endpoint], { timeout: 30_000, env: childEnv() })).stdout);
      else {
        const response = await fetchApi(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`GitHub repository request failed: ${response.status}`);
        rows = await response.json();
      }
      if (!Array.isArray(rows)) throw new Error('GitHub returned an unexpected repository list.');
      const next = rows.filter(row => REPO_NAME.test(row?.full_name)).map(row => ({ nameWithOwner: row.full_name, description: typeof row.description === 'string' ? row.description.slice(0, 180) : '', isPrivate: row.private === true }));
      repos = [...new Map([...(page === 1 ? [] : repos || []), ...next].map(row => [row.nameWithOwner, row])).values()];
      repoPage = page; hasMore = rows.length === 100; message = '';
      return status();
    },
    async clone(repo) {
      const cloneUrl = githubCloneUrl(repo);
      repo = githubRepository(repo);
      if (!repo || !cloneUrl) throw new Error('Choose a repository from the list or enter owner/repo or an HTTPS or SSH GitHub repository URL.');
      if (phase !== 'ready' || cloneBusy) throw new Error('GitHub setup is already running.');
      cloneBusy = true;
      try {
        const localPath = (await clones.snapshot(true))[repo.toLowerCase()];
        if (localPath) { clonedPath = localPath; message = `Already cloned ${repo} to ${localPath}.`; return status(); }
        const current = await status(true);
        if (!current.account) throw new Error(current.message);
        const directory = await pickDirectory();
        if (!directory) return current;
        const gh = await locateGitHubCli({ platform, env: childEnv(), run, exists });
        const destination = path.join(directory, repo.split('/')[1]);
        phase = 'cloning'; message = `Cloning ${repo}…`;
        try { await run(gh || 'git', gh ? ['repo', 'clone', cloneUrl, destination] : ['clone', cloneUrl, destination], { timeout: 600_000, env: gitProcessEnv(childEnv()) }); }
        catch (error) { message = ''; throw new Error(redactGitHubOutput(error.stderr || error.message) || 'Clone failed.'); }
        finally { phase = 'ready'; }
        clonedPath = destination;
        await clones.remember([destination]); message = `Cloned ${repo} to ${destination}.`;
        return status();
      } finally { cloneBusy = false; }
    },
  };
}
