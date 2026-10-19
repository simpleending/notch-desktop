import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

export function gitHubChildEnv(env) {
  const next = { ...env };
  for (const key of TOKEN_ENV) delete next[key];
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
  platform = process.platform,
  env = process.env,
  run = defaultRun,
  spawnProcess = spawn,
  openExternal = async () => {},
  pickDirectory = async () => null,
  exists,
} = {}) {
  let phase = 'ready';
  let code = null;
  let url = DEVICE_URL;
  let message = '';
  let loginChild = null;
  let repos = null;

  const childEnv = () => gitHubChildEnv(env);
  const environmentToken = () => TOKEN_ENV.some(key => !!env[key]);

  async function status() {
    const installedPath = await locateGitHubCli({ platform, env: childEnv(), run, exists });
    let account = null;
    if (installedPath) {
      try {
        const result = await run(installedPath, ['auth', 'status', '--hostname', 'github.com'], { timeout: 15_000, env: childEnv() });
        account = parseGitHubAccount(`${result.stdout}\n${result.stderr}`);
      } catch (error) {
        account = parseGitHubAccount(`${error.stdout || ''}\n${error.stderr || ''}`);
      }
    }
    const tokenWarning = environmentToken() ? ' A GITHUB_TOKEN in the environment overrides this sign-in.' : '';
    if (phase === 'installing' || phase === 'waiting' || phase === 'cloning') {
      return emptyState({ installed: !!installedPath, account, phase, code, url, message, environmentToken: environmentToken(), repos });
    }
    return emptyState({
      installed: !!installedPath,
      account,
      phase: 'ready',
      message: account ? `Signed in as ${account}.${tokenWarning}` : installedPath ? `GitHub CLI is installed. Sign in with the browser to clone and push.${tokenWarning}` : 'Install GitHub CLI, then sign in with the browser.',
      environmentToken: environmentToken(),
      repos,
    });
  }

  return {
    status,
    async install() {
      if (phase === 'installing' || phase === 'waiting') throw new Error('GitHub setup is already running.');
      if (await locateGitHubCli({ platform, env: childEnv(), run, exists })) return status();
      const installer = await locateInstaller(platform, env, run, exists);
      if (!installer) throw new Error(platform === 'linux' ? 'Install GitHub CLI from https://github.com/cli/cli/blob/trunk/docs/install_linux.md and then sign in.' : 'Install GitHub CLI from https://cli.github.com/ and then sign in.');
      phase = 'installing'; message = platform === 'win32' ? 'Installing GitHub CLI with WinGet…' : 'Installing GitHub CLI with Homebrew…'; code = null;
      try {
        await run(installer.file, installer.args, { timeout: 600_000, env: childEnv() });
      } catch (error) {
        const installed = await locateGitHubCli({ platform, env: childEnv(), run, exists });
        if (!installed) {
          phase = 'ready';
          throw new Error(redactGitHubOutput(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message}`) || 'GitHub CLI installation failed.');
        }
      }
      phase = 'ready'; message = 'GitHub CLI is installed.';
      const installed = await locateGitHubCli({ platform, env: childEnv(), run, exists });
      if (!installed) { throw new Error('GitHub CLI installed, but it is not available yet. Open notch again and sign in.'); }
      return status();
    },
    async login() {
      if (loginChild) throw new Error('GitHub sign-in is already open.');
      let installed = await locateGitHubCli({ platform, env: childEnv(), run, exists });
      if (!installed) await this.install();
      installed = await locateGitHubCli({ platform, env: childEnv(), run, exists });
      if (!installed) throw new Error('GitHub CLI is not installed.');
      phase = 'waiting'; code = null; url = DEVICE_URL; message = 'Waiting for the one-time code…'; repos = null;
      const child = spawnProcess(installed, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
      loginChild = child;
      let output = '';
      let opened = false;
      let setupWarning = '';
      const take = chunk => {
        output += String(chunk);
        if (output.length > 100_000) { child.kill(); return; }
        const nextCode = parseDeviceCode(output);
        if (nextCode) code = nextCode;
        const found = output.match(/https:\/\/github\.com\/login\/device[^\s)'"]*/);
        const safe = found ? safeDeviceUrl(found[0]) : null;
        if (safe) url = safe;
        if (code && !opened) {
          opened = true;
          message = `Enter ${code} in the browser.`;
          Promise.resolve(openExternal(url)).catch(() => {});
        }
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      try {
        const exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        if (exitCode !== 0) throw new Error(redactGitHubOutput(output) || `GitHub sign-in exited with status ${exitCode}.`);
        try { await run(installed, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: 20_000, env: childEnv() }); }
        catch (error) { setupWarning = redactGitHubOutput(error.stderr || error.message); }
      } finally { if (loginChild === child) loginChild = null; phase = 'ready'; }
      const next = await status();
      if (!next.account) throw new Error(redactGitHubOutput(output) || 'GitHub sign-in did not finish.');
      if (setupWarning) next.message = `Signed in as ${next.account}. Git credential setup needs another try: ${setupWarning}`;
      return next;
    },
    async cancel() {
      loginChild?.kill();
      loginChild = null;
      if (phase === 'waiting') { phase = 'ready'; message = 'GitHub sign-in cancelled.'; code = null; }
      return status();
    },
    async repos() {
      const current = await status();
      if (!current.installed || !current.account) throw new Error('Sign in with GitHub first.');
      const gh = await locateGitHubCli({ platform, env: childEnv(), run, exists });
      const result = await run(gh, ['repo', 'list', '--limit', '20', '--json', 'nameWithOwner,description,isPrivate'], { timeout: 30_000, env: childEnv() });
      const rows = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) throw new Error('GitHub returned an unexpected repository list.');
      repos = rows.filter(row => REPO_NAME.test(row?.nameWithOwner)).map(row => ({ nameWithOwner: row.nameWithOwner, description: typeof row.description === 'string' ? row.description.slice(0, 180) : '', isPrivate: row.isPrivate === true }));
      return { ...current, repos };
    },
    async clone(repo) {
      if (!REPO_NAME.test(repo || '')) throw new Error('Choose a repository from the list.');
      const current = await status();
      if (!current.account) throw new Error('Sign in with GitHub first.');
      const directory = await pickDirectory();
      if (!directory) return current;
      const gh = await locateGitHubCli({ platform, env: childEnv(), run, exists });
      if (!gh) throw new Error('GitHub CLI is not installed.');
      const destination = path.join(directory, repo.split('/')[1]);
      phase = 'cloning'; message = `Cloning ${repo}…`;
      try { await run(gh, ['repo', 'clone', repo, destination], { timeout: 600_000, env: childEnv() }); }
      catch (error) { phase = 'ready'; throw new Error(redactGitHubOutput(`${error.stderr || ''}\n${error.message}`) || 'Clone failed.'); }
      phase = 'ready';
      const next = await status();
      next.message = `Cloned ${repo}.`;
      return next;
    },
  };
}
