import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gitTool, isSecretPath } from '../vendor/notch-cli/src/tools/git.ts';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function context(cwd, confirm) {
  return { cwd, requireConfirm: true, confirm, log() {} };
}

test('secret files stay out of a prompted commit and push', async () => {
  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('app/.env.local'), true);
  assert.equal(isSecretPath('keys/id_ed25519'), true);
  assert.equal(isSecretPath('src/keyboard.ts'), false);
  assert.equal(isSecretPath('notes/environment.md'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-git-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  try {
    git(root, ['init', '--bare', '-b', 'main', remote]);
    fs.mkdirSync(work);
    git(work, ['init', '-b', 'main']);
    git(work, ['config', 'user.email', 'dev@example.com']);
    git(work, ['config', 'user.name', 'Dev']);
    fs.writeFileSync(path.join(work, 'note.txt'), 'hello\n');
    git(work, ['add', 'note.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['push', '-u', 'origin', 'HEAD']);
    fs.writeFileSync(path.join(work, 'note.txt'), 'hello again\n');
    fs.writeFileSync(path.join(work, '.env'), 'TOKEN=secret\n');

    const result = await gitTool.execute({ operation: 'commit_and_push', args: 'Update the note' }, context(work, async () => true));
    assert.equal(result.isError, undefined);
    assert.match(result.content, /Committed and pushed main/);
    assert.match(result.content, /Left unstaged: \.env/);
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: work, encoding: 'utf8' }).trim(), 'Update the note');
    assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }), /\.env/);
    const published = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    assert.match(published, /note\.txt/);
    assert.doesNotMatch(published, /\.env/);

    const cancelled = await gitTool.execute({ operation: 'commit_and_push', args: 'Should not publish' }, context(work, async () => false));
    assert.equal(cancelled.notExecuted, true);
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: work, encoding: 'utf8' }).trim(), 'Update the note');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
import { forcePushError } from '../vendor/notch-cli/src/tools/git.ts';

function fixture(run) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-git-regression-'));
    const work = path.join(root, 'work'), remote = path.join(root, 'origin.git');
    fs.mkdirSync(work);
    const read = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git(root, ['init', '--bare', '-b', 'main', remote]);
      git(work, ['init', '-b', 'main']);
      git(work, ['config', 'user.name', 'Fixture']); git(work, ['config', 'user.email', 'fixture@example.invalid']);
      git(work, ['remote', 'add', 'origin', remote]);
      await run({ root, work, remote, read, seed() { fs.writeFileSync(path.join(work, 'note.txt'), 'base'); git(work, ['add', '.']); git(work, ['commit', '-m', 'base']); git(work, ['push', '-u', 'origin', 'main']); } });
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'notch-git-regression-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('secret rename destinations and untracked secret directories are never published', fixture(async ({ work, remote, read, seed }) => {
  seed();
  git(work, ['mv', 'note.txt', '.env']);
  fs.mkdirSync(path.join(work, 'config'));
  fs.writeFileSync(path.join(work, 'config', '.env.local'), 'FAKE_FIXTURE_ONLY');
  fs.writeFileSync(path.join(work, 'new file.txt'), 'safe');
  let prompt;
  const result = await gitTool.execute({ operation: 'commit_and_push', args: 'Safe update' }, context(work, async value => { prompt = value; return true; }));
  assert.equal(result.isError, undefined, result.content);
  assert.match(prompt, /Left unstaged:.*\.env/);
  const published = read(work, ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']);
  assert.match(published, /new file.txt/);
  assert.doesNotMatch(published, /\.env/);
  assert.match(published, /note.txt/, 'the excluded rename must not delete the source remotely');
}));

test('a committed branch with no upstream is published to origin', fixture(async ({ work, remote, read, seed }) => {
  seed(); git(work, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(work, 'note.txt'), 'feature'); git(work, ['commit', '-am', 'feature']);
  const result = await gitTool.execute({ operation: 'commit_and_push', args: 'Publish feature' }, context(work, async () => true));
  assert.equal(result.isError, undefined, result.content);
  assert.equal(read(work, ['--git-dir', remote, 'rev-parse', 'feature']), read(work, ['rev-parse', 'HEAD']));
  assert.equal(read(work, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/feature');
}));

test('the first commit works with an empty origin and a renamed remote', fixture(async ({ work, remote, read }) => {
  git(work, ['remote', 'rename', 'origin', 'company']);
  fs.writeFileSync(path.join(work, 'first.txt'), 'initial');
  const result = await gitTool.execute({ operation: 'commit_and_push', args: 'Initial commit' }, context(work, async () => true));
  assert.equal(result.isError, undefined, result.content);
  assert.equal(read(work, ['--git-dir', remote, 'rev-parse', 'main']), read(work, ['rev-parse', 'HEAD']));
}));

test('force protection follows the remote destination and rejects ambiguous mappings', fixture(async ({ work, remote, read, seed }) => {
  seed(); const before = read(work, ['--git-dir', remote, 'rev-parse', 'main']);
  git(work, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(work, 'note.txt'), 'feature'); git(work, ['commit', '-am', 'feature']);
  for (const args of ['--force origin feature:main', 'origin +HEAD:refs/heads/main', '--force-with-lease origin HEAD:master', '--mirror origin', '-vf origin feature:release']) {
    const result = await gitTool.execute({ operation: 'push', args }, context(work, async () => true));
    assert.equal(result.isError, true, args); assert.match(result.content, /Blocked/);
  }
  assert.equal(read(work, ['--git-dir', remote, 'rev-parse', 'main']), before);
  assert.equal(forcePushError(['--force-with-lease', 'origin', 'feature'], 'feature'), null);
}));
