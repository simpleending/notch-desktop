import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/notch-host.mjs';
import { NotchQuery } from '../src/notch-query.mjs';

test('native selected-turn file undo previews and restores persisted turns across host restarts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-native-undo-'));
  const cwd = path.join(root, 'workspace'), data = path.join(root, 'profile'); await fs.mkdir(cwd);
  let host = createHost(data);
  try {
    const file = path.join(cwd, 'file.txt'); await fs.writeFile(file, 'original');
    async function* prompts() {
      yield { uuid: 'selected-turn', message: { content: 'one' } };
      yield { uuid: 'later-turn', message: { content: 'two' } };
    }
    const query = new NotchQuery(host, { cwd, sessionId: 'persistent', prompt: prompts() }, { runTurn: async turn => {
      await turn.checkpoints.recordBefore(file);
      await fs.writeFile(file, turn.messages.at(-1).content);
      await turn.checkpoints.recordAfter(); await turn.checkpoints.commit('write');
      return { messages: [...turn.messages, { role: 'assistant', content: 'done' }] };
    } });
    for await (const _event of query) {}
    assert.equal(await fs.readFile(file, 'utf8'), 'two');
    host = createHost(data);
    const lease = await host.acquireRewind('persistent');
    const preview = await lease.rewindFiles('selected-turn', true);
    assert.equal(preview.canRewind, true); assert.deepEqual(preview.filesChanged, [file]);
    assert.equal(await fs.readFile(file, 'utf8'), 'two');
    assert.equal((await host.openCheckpoints('persistent', cwd)).undoCount, 2);
    await assert.rejects(lease.rewindFiles('unknown-turn', { dryRun: true }), /No saved/);
    await fs.writeFile(file, 'manual');
    await assert.rejects(lease.rewindFiles('selected-turn'), /changed since/);
    assert.equal(await fs.readFile(file, 'utf8'), 'manual');
    await fs.writeFile(file, 'two'); await lease.rewindFiles('selected-turn'); await lease.release();
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.equal((await host.openCheckpoints('persistent', cwd)).undoCount, 0);
    assert.match((await host.loadSession('persistent', cwd)).messages.at(-1).content, /do not replay/);
    await assert.rejects(lease.rewindFiles('selected-turn'), /released/);
  } finally { await host.workspaceSearch.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});
