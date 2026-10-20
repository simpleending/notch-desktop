import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createLocalRepositories } from './local-repositories.mjs';
import { originRepository, originCloneUrl } from './origin-repository.mjs';
import { gitProcessEnv } from '../vendor/notch-core/desktop-harness.js';

const execute = promisify(execFile);
const defaultRun = (file, args, options) => execute(file, args, { ...options, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
export function createOriginGit({ directory, env = process.env, platform = process.platform, run = defaultRun, pickDirectory = async () => null, nativeAuth, onAuthChange = () => {} } = {}) {
  const clones = createLocalRepositories(directory, { run, env: () => env, platform, repository: originRepository, fileName: 'origin-clones.json' });
  let busy = false;
  let session = null, loginUrl = '', loginError = '', authPromise;
  const auth = () => nativeAuth ? Promise.resolve(nativeAuth) : (authPromise ||= import('@freesyntax/notch-cli/dist/origin-auth.js').then(module => module.createNativeOriginAuth({ env, platform, onLoginUrl: url => { loginUrl = url; } })));
  const state = async () => {
    const status = platform === 'win32' ? await (await auth()).status() : {};
    if (platform === 'win32') await onAuthChange(status.signedIn);
    return { localClones: await clones.snapshot(true), nativeCliSupported: true, ...status, signingIn: !!session, loginUrl, loginError: loginError || status.loginError || '' };
  };
  const api = async endpoint => {
    if (platform === 'win32') return (await auth()).api(endpoint);
    // Origin CLI owns token exchange/refresh. Never treat a Cursor API key as an Origin bearer token.
    let executable = 'origin';
    if (env.HOME) {
      const installed = path.join(env.HOME, '.local', 'bin', 'origin');
      try { await fs.access(installed); executable = installed; } catch { /* Fall back to PATH. */ }
    }
    try {
      const result = await run(executable, ['api', endpoint], { timeout: 30000, env });
      return JSON.parse(result.stdout);
    } catch { throw Error('Origin could not list repositories. Install the official Origin CLI, run origin auth login in a terminal, and confirm this account has Origin access. Then retry.'); }
  };
  return {
    status: state,
    async login() {
      if (platform !== 'win32') throw Error('Run origin auth login in a terminal, then refresh repositories.');
      if (session) return state();
      const client = await auth();
      const controller = new AbortController(); session = controller; loginUrl = ''; loginError = '';
      void client.login(controller.signal).then(() => state()).catch(failure => {
        if (!controller.signal.aborted) {
          const setupErrors = ['The Origin login was saved, but Git configuration could not be read. Check your global Git config permissions and sign in again.', 'The Origin login was saved, but its Git helper could not be configured. Check your global Git config permissions and sign in again.'];
          loginError = setupErrors.includes(failure?.message) ? failure.message : 'Cursor sign-in did not complete. Retry and confirm this account has Origin access.';
        }
      }).finally(() => { if (session === controller) { session = null; loginUrl = ''; } });
      return state();
    },
    async cancel() { session?.abort(); session = null; loginUrl = ''; loginError = ''; return state(); },
    async logout() { session?.abort(); session = null; loginUrl = ''; loginError = ''; await (await auth()).logout(); return state(); },
    close() { session?.abort(); },
    async remember(paths) { await clones.remember(paths); return state(); },
    async openRepo(repo) {
      const localPath = (await clones.snapshot(true))[originRepository(repo)];
      if (!localPath) throw Error('The local clone is no longer available. Refresh repositories or open its current folder.');
      return { ...await state(), clonedPath: localPath };
    },
    async namespaces() {
      const namespaces = []; let token = ''; const seen = new Set();
      do {
        const page = await api('/namespaces?' + new URLSearchParams({ pageSize: '100', ...(token ? { pageToken: token } : {}) }));
        if (!Array.isArray(page.namespaces)) throw Error('Origin returned an unexpected namespace list.');
        namespaces.push(...page.namespaces.map(row => row.namespace?.slug).filter(slug => typeof slug === 'string' && /^[A-Za-z0-9_.-]+$/.test(slug) && slug !== '.' && slug !== '..'));
        token = page.nextPageToken || '';
        if (typeof token !== 'string' || token.length > 4096 || seen.has(token) || namespaces.length > 10000 || seen.size >= 1000) throw Error('Origin returned invalid namespace pagination.');
        seen.add(token);
      } while (token);
      return { ...await state(), namespaces: [...new Set(namespaces)] };
    },
    async repos({ owner, pageToken = '' }) {
      const page = await api(`/repos/${encodeURIComponent(owner)}?` + new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) }));
      if (!Array.isArray(page.repositories) || page.nextPageToken && (typeof page.nextPageToken !== 'string' || page.nextPageToken.length > 4096 || page.nextPageToken === pageToken)) throw Error('Origin returned an unexpected repository page.');
      return { ...await state(), owner, nextPageToken: page.nextPageToken || '', repos: page.repositories.filter(row => originRepository(row.fullName) && row.fullName.split('/')[0] === owner).map(row => ({ name: row.fullName, cloneUrl: originCloneUrl(row.cloneUrl) || originCloneUrl(row.fullName), mirror: row.mirror?.source === 'github', visibility: row.visibility === 'internal' ? 'Internal' : 'Private' })) };
    },
    async clone(value) {
      const url = originCloneUrl(value), repo = originRepository(value);
      if (!url || !repo) throw Error('Enter an HTTPS or SSH Origin repository URL.');
      if (busy) throw Error('An Origin clone is already running.');
      busy = true;
      try {
        const existing = (await clones.snapshot(true))[repo];
        if (existing) return { ...await state(), clonedPath: existing, message: 'This repository is already on this device.' };
        const parent = await pickDirectory();
        if (!parent) return state();
        const destination = path.join(parent, repo.split('/')[1]);
        try { await run('git', ['clone', url, destination], { timeout: 600000, env: { ...gitProcessEnv(env), GIT_TERMINAL_PROMPT: '0' } }); }
        catch {
          // Git output can include credential-helper tokens. Keep authentication failures local and actionable.
          throw Error('Origin clone failed. Check the repository URL and your local Git credentials or registered SSH key. For a first SSH connection, verify Origin’s host fingerprint in a terminal. An existing destination folder will not be overwritten.');
        }
        await clones.remember([destination]);
        return { ...await state(), clonedPath: destination, message: `Cloned ${repo}.` };
      } finally { busy = false; }
    },
  };
}
