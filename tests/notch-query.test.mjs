import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotchQuery, accessForMode } from '../src/notch-query.mjs';
function fixture() {
  const saved = [], journal = [];
  return { saved, journal, host: { loadSession: async () => ({ messages: [] }), saveSession: async (_id, state) => saved.push(structuredClone(state)), journal: async (_id, event) => journal.push(event), listModels: async () => [{ key: 'ollama/fixture', enabled: true }] } };
}
test('adapter maps access modes and does not turn automatic/editor modes into full access', () => {
  assert.equal(accessForMode('auto'), 'approve'); assert.equal(accessForMode('acceptEdits'), 'approve');
  assert.equal(accessForMode('bypassPermissions'), 'full-access'); assert.equal(accessForMode('bypassPermissions', true), 'read-only');
  assert.throws(() => accessForMode('unknown'), /Unsupported/);
});
test('streamed text and native tool identities drive the existing workbench contract', async () => {
  const f = fixture(); let approved;
  const query = new NotchQuery(f.host, { cwd: process.cwd(), prompt: 'Write a file', sessionId: 'fixture',
    canUseTool: async (name, input, options) => { approved = { name, input, id: options.toolUseID }; return { behavior: 'allow', updatedInput: input }; } }, {
    runTurn: async turn => {
      assert.equal(turn.accessMode, 'approve');
      assert.equal(await turn.approve('write', { path: 'file.txt', content: 'yes' }, 'Approve', 'call-1'), true);
      turn.onText('Working'); turn.onToolCall('write', { path: 'file.txt', content: 'yes' }, 'call-1');
      await turn.onLifecycle('post-tool', { tool: 'write', toolCallId: 'call-1', result: 'Created file' });
      turn.onToolResult('write', 'Created file', false, 'call-1'); turn.onText('Done');
      return { text: 'Done', status: 'completed', iterations: 2, messages: [...turn.messages, { role: 'assistant', content: 'Done' }] };
    },
  });
  const events = []; for await (const event of query) events.push(event);
  assert.deepEqual(approved, { name: 'Write', input: { file_path: 'file.txt', content: 'yes' }, id: 'call-1' });
  assert.equal(events.at(-1).subtype, 'success');
  const result = events.find(event => event.type === 'user' && event.message.content[0].type === 'tool_result');
  assert.equal(result.message.content[0].tool_use_id, 'call-1'); assert.equal(f.journal.length, 1);
  assert.equal(f.saved.at(-1).messages.at(-1).content, 'Done');
  const textIds = events.filter(event => event.type === 'assistant' && event.message.content[0].type === 'text').map(event => event.uuid);
  assert.equal(new Set(textIds).size, 2);
});
test('interrupt cancels an outstanding approval and never executes the proposed action', async () => {
  const f = fixture(); let approvalStarted; const started = new Promise(resolve => { approvalStarted = resolve; }); let acted = false;
  const query = new NotchQuery(f.host, { cwd: process.cwd(), prompt: 'Write', canUseTool: () => { approvalStarted(); return new Promise(() => {}); } }, {
    runTurn: async turn => { if (await turn.approve('write', { path: 'file', content: 'x' }, '', 'blocked')) acted = true; return { messages: turn.messages }; },
  });
  await started; await query.interrupt();
  const events = []; for await (const event of query) events.push(event);
  assert.equal(acted, false); assert.equal(events.at(-1).terminal_reason, 'user_interrupted');
});
test('failure records completed actions for continuation and does not replay them', async () => {
  const f = fixture(); let calls = 0;
  const query = new NotchQuery(f.host, { cwd: process.cwd(), prompt: 'Fix' }, { runTurn: async turn => {
    calls++; await turn.onLifecycle('post-tool', { tool: 'write', result: 'already written' }); throw new Error('Transport failed');
  } });
  const events = []; for await (const event of query) events.push(event);
  assert.equal(calls, 1); assert.equal(events.at(-1).is_error, true);
  assert.match(f.saved.at(-1).messages.at(-1).content, /Do not replay/);
});
