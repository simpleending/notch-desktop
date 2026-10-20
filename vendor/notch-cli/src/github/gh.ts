import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEVICE_URL = 'https://github.com/login/device';
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GH_LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'] as const;
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

export interface GitHubStatus {
  installed: boolean;
  account: string | null;
  executable: string | null;
  environmentToken: boolean;
  message: string;
}

export function parseDeviceCode(text: string): string | null {
  return text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1] ?? null;
}

export function parseGitHubAccount(text: string): string | null {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  return plain.match(/Logged in to github\.com account ([A-Za-z0-9-]+)/)?.[1]
    ?? plain.match(/Logged in as ([A-Za-z0-9-]+)/)?.[1]
    ?? null;
}

export function safeDeviceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== '/login/device') return null;
    return url.toString();
  } catch { return null; }
}

export function redactGitHubOutput(text: string): string {
  return text
    .replace(/\b(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, '[token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[token]')
    .split(/\r?\n/)
    .filter(line => !/^\s*-?\s*Token:/i.test(line))
    .join('\n')
    .trim()
    .slice(0, 500);
}

export function gitHubChildEnv(env: NodeJS.ProcessEnv = process.env, browserLogin = false): NodeJS.ProcessEnv {
  const next = { ...env };
  if (browserLogin) for (const key of TOKEN_ENV) delete next[key];
  next.GH_HOST = 'github.com';
  return next;
}

function executableName(platform: string) {
  return platform === 'win32' ? 'gh.exe' : 'gh';
}

export function acceptGitHubExecutable(file: string, platform = process.platform) {
  return path.basename(file).toLowerCase() === executableName(platform);
}

function runFile(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env, signal }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (error) { (error as Error & { stdout: string; stderr: string }).stdout = result.stdout; (error as Error & { stderr: string }).stderr = result.stderr; reject(error); return; }
      resolve(result);
    });
  });
}

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function locateGitHubCli(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const platform = process.platform;
  const candidates: string[] = [];
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) if (root) candidates.push(path.join(root, 'GitHub CLI', 'gh.exe'));
    const where = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'where.exe') : 'where.exe';
    try { candidates.unshift(...(await runFile(where, ['gh.exe'], env, 5000)).stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)); } catch { /* not on PATH */ }
  } else {
    try { candidates.unshift(...(await runFile('which', ['gh'], env, 5000)).stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)); } catch { /* not on PATH */ }
  }
  for (const file of candidates) if (acceptGitHubExecutable(file, platform) && await exists(file)) return file;
  return null;
}

export function parseGitHubStatus(text: string): string | null {
  const data = JSON.parse(text) as { hosts?: Record<string, Array<{ active?: boolean; state?: string; login?: string }>> };
  return data.hosts?.['github.com']?.find(row => row.active === true && row.state === 'success')?.login || null;
}

export async function githubStatus(env: NodeJS.ProcessEnv = process.env): Promise<GitHubStatus> {
  const child = gitHubChildEnv(env);
  const executable = await locateGitHubCli(child);
  const source = env.GH_TOKEN ? 'GH_TOKEN' : env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null;
  let account: string | null = null;
  try {
    if (executable) account = parseGitHubStatus((await runFile(executable, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], child, 15_000)).stdout);
    else if (source) {
      const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${env[source]}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(15_000) });
      if (response.ok) account = (await response.json() as { login?: string }).login || null;
    }
  } catch { /* Invalid credentials never count as an active sign-in. */ }
  const message = source
    ? account ? `Signed in as ${account} using ${source}.` : `${source} is configured but GitHub could not validate it. Update or remove it to use browser sign-in.`
    : account ? `Signed in as ${account}.` : executable ? 'GitHub CLI is installed. Run notch github login to sign in or repair authentication.' : 'GitHub CLI is not installed. Run notch github login to install it and sign in.';
  return { installed: !!executable, account, executable, environmentToken: !!source, message };
}

async function installer(env: NodeJS.ProcessEnv): Promise<{ file: string; args: string[] } | null> {
  if (process.platform === 'win32') {
    const candidates = [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe') : ''].filter(Boolean);
    const where = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'where.exe') : 'where.exe';
    try { candidates.unshift(...(await runFile(where, ['winget.exe'], env, 5000)).stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)); } catch { /* WinGet is optional. */ }
    for (const file of candidates) if (path.basename(file).toLowerCase() === 'winget.exe' && await exists(file)) return { file, args: ['install', '--id', 'GitHub.cli', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] };
    return null;
  }
  if (process.platform === 'darwin') {
    const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    try { candidates.unshift(...(await runFile('which', ['brew'], env, 5000)).stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)); } catch { /* Homebrew is optional. */ }
    for (const file of candidates) if (path.basename(file) === 'brew' && await exists(file)) return { file, args: ['install', 'gh'] };
  }
  return null;
}

export async function installGitHubCli(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const existing = await locateGitHubCli(gitHubChildEnv(env));
  if (existing) return existing;
  const command = await installer(env);
  if (!command) throw new Error(process.platform === 'linux' ? 'Install GitHub CLI from https://github.com/cli/cli/blob/trunk/docs/install_linux.md and then run notch github login.' : 'Install GitHub CLI from https://cli.github.com/ and then run notch github login.');
  try { await runFile(command.file, command.args, gitHubChildEnv(env), 600_000); }
  catch (error) {
    const installed = await locateGitHubCli(gitHubChildEnv(env));
    if (!installed) throw new Error(redactGitHubOutput(`${(error as { stderr?: string }).stderr || ''}\n${(error as Error).message}`) || 'GitHub CLI installation failed.');
    return installed;
  }
  const installed = await locateGitHubCli(gitHubChildEnv(env));
  if (!installed) throw new Error('GitHub CLI installed, but it is not available yet. Open a new terminal and run notch github login.');
  return installed;
}

export function openDevicePage(url: string) {
  const safe = safeDeviceUrl(url) ?? DEVICE_URL;
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', safe], { windowsHide: true, stdio: 'ignore', detached: true })
    : process.platform === 'darwin'
      ? spawn('open', [safe], { stdio: 'ignore', detached: true })
      : spawn('xdg-open', [safe], { stdio: 'ignore', detached: true });
  child.on('error', () => { /* The printed device URL remains available. */ });
  child.unref();
}

export async function loginGitHub(env: NodeJS.ProcessEnv = process.env, onCode: (code: string, url: string) => void = () => {}): Promise<GitHubStatus> {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) throw new Error('Remove GH_TOKEN and GITHUB_TOKEN from the environment before browser sign-in, or update the configured token.');
  const executable = await locateGitHubCli(gitHubChildEnv(env)) ?? await installGitHubCli(env);
  const child = spawn(executable, [...GH_LOGIN_ARGS], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitHubChildEnv(env, true) });
  let output = '';
  let announced = false;
  const take = (chunk: Buffer | string) => {
    output += String(chunk);
    const code = parseDeviceCode(output);
    const found = output.match(/https:\/\/github\.com\/login\/device[^\s)'"]*/);
    const url = (found && safeDeviceUrl(found[0])) || DEVICE_URL;
    if (code && !announced) { announced = true; onCode(code, url); openDevicePage(url); }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(redactGitHubOutput(output) || `GitHub sign-in exited with status ${exitCode}.`);
  try { await runFile(executable, ['auth', 'setup-git', '--hostname', 'github.com'], gitHubChildEnv(env), 20_000); }
  catch (error) { console.error(`Signed in. Git credential setup needs another try: ${redactGitHubOutput((error as { stderr?: string }).stderr || (error as Error).message)}`); }
  const status = await githubStatus(env);
  if (!status.account) throw new Error(redactGitHubOutput(output) || 'GitHub sign-in did not finish.');
  return status;
}

export async function listGitHubRepos(env: NodeJS.ProcessEnv = process.env) {
  const status = await githubStatus(env);
  if (!status.account) throw new Error(status.message);
  const repos: Array<{ nameWithOwner: string; description: string; isPrivate: boolean }> = [];
  for (let page = 1; ; page += 1) {
    const endpoint = `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`;
    let rows: Array<{ full_name: string; description?: string; private?: boolean }>;
    if (status.executable) rows = JSON.parse((await runFile(status.executable, ['api', '--hostname', 'github.com', endpoint], gitHubChildEnv(env), 30_000)).stdout);
    else {
      const response = await fetch(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GitHub repository request failed: ${response.status}`);
      rows = await response.json() as typeof rows;
    }
    if (!Array.isArray(rows)) throw new Error('GitHub returned an unexpected repository list.');
    repos.push(...rows.filter(row => REPO_NAME.test(row.full_name)).map(row => ({ nameWithOwner: row.full_name, description: row.description || '', isPrivate: row.private === true })));
    if (rows.length < 100) return [...new Map(repos.map(repo => [repo.nameWithOwner, repo])).values()];
  }
}

export async function readGitHubCliToken(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string | null> {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN || null;
  const executable = await locateGitHubCli(gitHubChildEnv(env));
  if (!executable) return null;
  try {
    const token = (await runFile(executable, ['auth', 'token', '--hostname', 'github.com'], gitHubChildEnv(env), 15_000, signal)).stdout.trim();
    if (/^[\w.-]+$/.test(token) && token.length >= 8 && token.length <= 300) return token;
  } catch { /* Not signed in. */ }
  return null;
}
