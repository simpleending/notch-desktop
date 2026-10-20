import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalRepositories, githubRemoteRepository } from '../src/local-repositories.mjs';
import { createGitHubAuth } from '../src/github-auth.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-repository-history-'));
  t.after(async () => { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const repo = path.join(directory, 'repo'), profile = path.join(directory, 'profile');
  await fs.mkdir(repo); await run('git', ['init', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Team/Repo.git']);
  return { directory, repo, profile, catalog: () => createLocalRepositories(profile, { run }) };
}

test('local Git clone identity survives restart and never stores remote credentials', async t => {
  const f = await fixture(t), catalog = f.catalog();
  await run('git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://synthetic:fake-secret@github.com/Team/Repo.git']);
  await catalog.remember([f.repo]);
  assert.deepEqual(await f.catalog().snapshot(), { 'team/repo': await fs.realpath(f.repo) });
  const saved = await fs.readFile(path.join(f.profile, 'github-clones.json'), 'utf8');
  assert.equal(/secret|github\.com|synthetic/.test(saved), false);
  assert.equal(githubRemoteRepository('ssh://git@github.com/TEAM/REPO.git'), 'team/repo');
});

test('missing folders and changed Git origins cannot remain Open after validation', async t => {
  const f = await fixture(t), catalog = f.catalog(); await catalog.remember([f.repo]);
  await run('git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://github.com/another/repo.git']);
  assert.deepEqual(await catalog.snapshot(true), { 'another/repo': await fs.realpath(f.repo) });
  await run('git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/team/repo.git']);
  assert.deepEqual(await catalog.snapshot(true), {});
  const moved = path.join(f.directory, 'moved');
  assert(moved.startsWith(f.directory + path.sep) && f.repo.startsWith(f.directory + path.sep)); await fs.rename(f.repo, moved);
  assert.deepEqual(await f.catalog().snapshot(), {});
});

test('repository folders with spaces and Unicode names are remembered without path rewriting', async t => {
  const f = await fixture(t), repo = path.join(f.directory, 'répository with spaces 中文');
  await fs.mkdir(repo); await run('git', ['init', repo]); await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/team/unicode.git']);
  await f.catalog().remember([repo]);
  assert.equal((await f.catalog().snapshot())['team/unicode'], await fs.realpath(repo));
});

test('concurrent registration, subfolders and Git worktrees preserve real roots without lost updates', async t => {
  const f = await fixture(t), catalog = f.catalog(), worktree = path.join(f.directory, 'worktree'), child = path.join(f.repo, 'child');
  await fs.mkdir(child); await fs.writeFile(path.join(f.repo, 'file.txt'), 'fixture');
  await run('git', ['-C', f.repo, 'add', 'file.txt']);
  await run('git', ['-C', f.repo, '-c', 'user.name=Repository QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'fixture']);
  await run('git', ['-C', f.repo, 'worktree', 'add', '-b', 'fixture', worktree]);
  await Promise.all([catalog.remember([child]), catalog.remember([worktree])]);
  const saved = JSON.parse(await fs.readFile(path.join(f.profile, 'github-clones.json')));
  assert.deepEqual(new Set(saved.paths), new Set([await fs.realpath(f.repo), await fs.realpath(worktree)]));
  assert.equal((await f.catalog().snapshot())['team/repo'], await fs.realpath(worktree));
});

test('backend clone deduplication works after restart before authentication or destination selection', async t => {
  const f = await fixture(t); await f.catalog().remember([f.repo]);
  let selections = 0, clones = 0;
  const auth = createGitHubAuth({ directory: f.profile, env: {}, exists: async () => false, pickDirectory: async () => { selections++; return f.directory; },
    run: async (file, args, options) => { if (file === 'git') { if (args[0] === 'clone') clones++; return run(file, args, options); } throw Error('No GitHub CLI'); },
  });
  assert.equal((await auth.clone('https://github.com/team/repo.git')).clonedPath, await fs.realpath(f.repo));
  assert.equal(selections, 0); assert.equal(clones, 0);
  assert.equal((await auth.openRepo('TEAM/REPO')).clonedPath, await fs.realpath(f.repo));
  await run('git', ['-C', f.repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
  await assert.rejects(auth.openRepo('team/repo'), /no longer available/);
});

test('corrupt history stays intact and reports a recovery path instead of silently allowing duplicate clones', async t => {
  const f = await fixture(t); await fs.mkdir(f.profile); const file = path.join(f.profile, 'github-clones.json'); await fs.writeFile(file, '{broken');
  await assert.rejects(f.catalog().snapshot(), /Workspaces/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
