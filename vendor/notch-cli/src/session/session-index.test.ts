import { describe, expect, test, beforeEach, afterAll } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Rollout, rolloutPath, indexPath } from './rollout.js';
import {
  querySessions,
  getSession,
  forgetSession,
  tagSession,
  rebuildIndex,
  upsertSessionIndexEntry,
  indexFilePath,
} from './session-index.js';
import { forkSession, seqOfUserTurn } from './fork.js';
import { tailRollout } from './tail.js';

// All of these talk to the real ~/.notch/{rollouts,sessions.index.json}.
// To keep tests hermetic we redirect HOME to a temp dir before the module
// cache captures the home-derived paths — but since rollout.ts reads
// os.homedir() at module load, instead we make the test IDs unique +
// clean up after ourselves. This is a CI-friendly compromise.

const SUFFIX = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkSession(id: string, msgs: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const r = new Rollout(id);
  await r.openNew({ project: 'testproj', model: 'test-model' });
  let msgIdSeq = 0;
  for (const m of msgs) {
    const msgId = `m${msgIdSeq++}`;
    await r.append({
      type: m.role === 'user' ? 'user-message' : 'assistant-message',
      msgId,
      payload: { content: m.content },
    });
  }
  await r.append({ type: 'turn-end' });
  await r.close();
}

async function cleanup(id: string) {
  await fsp.unlink(rolloutPath(id)).catch(() => {});
  await fsp.unlink(indexPath(id)).catch(() => {});
  await forgetSession(id).catch(() => {});
}

describe('session-index', () => {
  const sid = `${SUFFIX}-idx-a`;

  beforeEach(async () => {
    await cleanup(sid);
  });

  afterAll(async () => {
    await cleanup(sid);
  });

  test('close() refreshes the cross-session index automatically', async () => {
    await mkSession(sid, [
      { role: 'user', content: 'hello notch' },
      { role: 'assistant', content: 'hi there' },
    ]);

    const entry = await getSession(sid);
    expect(entry).not.toBeNull();
    expect(entry!.project).toBe('testproj');
    expect(entry!.model).toBe('test-model');
    expect(entry!.turnCount).toBe(2);
    expect(entry!.preview).toBe('hello notch');
    expect(entry!.hasActiveStream).toBe(false);
  });

  test('upsertSessionIndexEntry is idempotent', async () => {
    await mkSession(sid, [{ role: 'user', content: 'x' }]);
    await upsertSessionIndexEntry(sid);
    await upsertSessionIndexEntry(sid);
    const e = await getSession(sid);
    expect(e).not.toBeNull();
  });

  test('listSessions filter by project + search', async () => {
    await mkSession(sid, [{ role: 'user', content: 'unique-search-needle-xyz' }]);
    const byProject = await querySessions({ project: 'testproj', limit: 50 });
    expect(byProject.find((e) => e.id === sid)).toBeTruthy();

    const bySearch = await querySessions({ search: 'unique-search-needle-xyz', limit: 5 });
    expect(bySearch.find((e) => e.id === sid)).toBeTruthy();

    const wrongProject = await querySessions({ project: 'doesnotexist', limit: 5 });
    expect(wrongProject.find((e) => e.id === sid)).toBeFalsy();
  });

  test('tagSession merges tags without duplicates', async () => {
    await mkSession(sid, [{ role: 'user', content: 'y' }]);
    await tagSession(sid, ['alpha', 'beta']);
    await tagSession(sid, ['beta', 'gamma']);
    const e = await getSession(sid);
    expect(e!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('rebuildIndex walks the rollouts dir', async () => {
    await mkSession(sid, [{ role: 'user', content: 'z' }]);
    const result = await rebuildIndex();
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    const e = await getSession(sid);
    expect(e).not.toBeNull();
  });

  test('indexFilePath returns an absolute path under home', () => {
    const p = indexFilePath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.homedir())).toBe(true);
  });
});

describe('forkSession', () => {
  const src = `${SUFFIX}-fork-src`;
  const child = `${SUFFIX}-fork-child`;

  beforeEach(async () => {
    await cleanup(src);
    await cleanup(child);
  });

  afterAll(async () => {
    await cleanup(src);
    await cleanup(child);
  });

  test('forks at a user turn, stamps lineage, updates index', async () => {
    await mkSession(src, [
      { role: 'user', content: 'turn-zero' },
      { role: 'assistant', content: 'reply-zero' },
      { role: 'user', content: 'turn-one' },
      { role: 'assistant', content: 'reply-one' },
      { role: 'user', content: 'turn-two' },
    ]);

    const seqTurn1 = await seqOfUserTurn(src, 1);
    expect(seqTurn1).not.toBeNull();

    const result = await forkSession(src, seqTurn1!, {
      childId: child,
      note: 'trying a different approach',
      truncateAfter: true,
    });

    expect(result.childId).toBe(child);
    expect(result.sourceId).toBe(src);

    const childEntry = await getSession(child);
    expect(childEntry).not.toBeNull();
    expect(childEntry!.forkSourceId).toBe(src);
    expect(childEntry!.forkFromSeq).toBe(seqTurn1);

    const srcEntry = await getSession(src);
    expect(srcEntry!.branches).toBeGreaterThanOrEqual(1);
  });

  test('throws on missing source', async () => {
    await expect(forkSession('does-not-exist-session', 0, { childId: 'x' })).rejects.toThrow();
  });

  test('throws on negative fromSeq', async () => {
    await mkSession(src, [{ role: 'user', content: 'a' }]);
    await expect(forkSession(src, -1)).rejects.toThrow(/fromSeq/);
  });
});

describe('tailRollout', () => {
  const tid = `${SUFFIX}-tail-a`;

  beforeEach(async () => {
    await cleanup(tid);
  });

  afterAll(async () => {
    await cleanup(tid);
  });

  test('emits recorded events from the start and stops on turn-end', async () => {
    // Write the session first, then tail from seq=0. Avoids filesystem
    // timing races that would make the test flaky on slow CI runners.
    await mkSession(tid, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);

    const seen: Array<{ type: string; content?: string }> = [];
    const ctl = tailRollout(
      tid,
      (r) => {
        const payload = r.payload as { content?: string } | undefined;
        seen.push({ type: r.type, content: payload?.content });
      },
      { pollIntervalMs: 20, stopOnIdle: true, timeoutMs: 3000, fromSeq: -1 },
    );

    // Wait for the tail to observe `turn-end` (stopOnIdle will then stop
    // the loop on its own). Poll up to 3s before giving up.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.some((e) => e.type === 'turn-end')) {
      await new Promise((r) => setTimeout(r, 30));
    }
    await ctl.stop();

    expect(seen.some((e) => e.type === 'user-message' && e.content === 'hello')).toBe(true);
    expect(seen.some((e) => e.type === 'turn-end')).toBe(true);
  }, 10_000);

  test('external stop() exits cleanly', async () => {
    const ctl = tailRollout(tid, () => {}, { pollIntervalMs: 30, timeoutMs: 1500 });
    await new Promise((r) => setTimeout(r, 50));
    await ctl.stop();
    // Should resolve without throwing; reaching here is the assertion.
    expect(true).toBe(true);
  }, 5_000);
});
