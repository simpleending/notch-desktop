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
