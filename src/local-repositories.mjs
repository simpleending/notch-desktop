import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { githubRepository } from './github-repository.mjs';

export function githubRemoteRepository(value) {
  try {
    if (/^https:\/\//i.test(value)) {
      const url = new URL(value); url.username = ''; url.password = ''; value = url.toString();
    }
    return githubRepository(value)?.toLowerCase() || null;
  } catch { return null; }
}

export function createLocalRepositories(directory, { run, env = () => process.env, platform = process.platform, repository = githubRemoteRepository, fileName = 'github-clones.json' } = {}) {
  const file = directory && path.join(directory, fileName);
  const key = value => platform === 'win32' ? value.toLowerCase() : value;
  let paths, cached, checkedAt = 0, queue = Promise.resolve();
  const serialize = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  async function load() {
    if (paths) return;
    if (!file) { paths = []; return; }
    try {
      if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw Error('Repository history is too large.');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.paths) || saved.paths.length > 10000 || saved.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0'))) throw Error('Invalid repository history.');
      paths = [...new Map(saved.paths.map(value => [key(value), value])).values()];
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read local repository history. Open projects remain available from Workspaces.', { cause: error });
      paths = [];
    }
  }
  async function inspect(directory) {
    try {
      const existing = await fs.realpath(directory);
      const root = (await run('git', ['-C', existing, 'rev-parse', '--show-toplevel'], { timeout: 5000, env: env() })).stdout.trim();
      if (!path.isAbsolute(root)) return null;
      const remote = (await run('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { timeout: 5000, env: env() })).stdout.trim();
      const repo = repository(remote);
      return repo ? { repo, path: await fs.realpath(root) } : null;
    } catch { return null; }
  }
  async function scan(force = false) {
    await load();
    if (cached && !force && Date.now() - checkedAt < 60000) return { ...cached };
    const found = new Array(paths.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (next < paths.length) { const index = next++; found[index] = await inspect(paths[index]); }
    }));
    cached = {};
    for (const row of found) if (row && !cached[row.repo]) cached[row.repo] = row.path;
    checkedAt = Date.now();
    return { ...cached };
  }
  async function save(nextPaths) {
    if (!file) return;
    const contents = JSON.stringify({ version: 1, paths: nextPaths });
    if (Buffer.byteLength(contents) > 16 * 1024 * 1024) throw Error('Local repository history is full.');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  return {
    snapshot: force => serialize(() => scan(force)),
    remember: directories => serialize(async () => {
      await load();
      if (!file) return {};
      const nextPaths = [...paths];
      for (const directory of directories) {
        const row = await inspect(directory);
        if (row && !nextPaths.some(value => key(value) === key(row.path))) nextPaths.unshift(row.path);
      }
      if (nextPaths.length > 10000) throw Error('Local repository history is full.');
      if (nextPaths.length !== paths.length) { await save(nextPaths); paths = nextPaths; }
      cached = null;
      return scan(true);
    }),
  };
}
