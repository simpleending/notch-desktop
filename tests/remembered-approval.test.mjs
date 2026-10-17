import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotchQuery } from '../src/notch-query.mjs';
function fixture() {
  let state = { messages: [] };
  return { loadSession: async () => structuredClone(state), saveSession: async (_id, value) => { state = structuredClone(value); }, journal: async () => {} };
}
async function run(host, options, action) {
  const query = new NotchQuery(host, { cwd: process.cwd(), sessionId: 'approval-task', prompt: 'work', ...options }, {
    runTurn: async turn => { await action(turn); return { messages: turn.messages }; },
  });
  const events = []; for await (const event of query) events.push(event);
  assert.equal(events.at(-1).is_error, false, events.at(-1).errors?.join('\n'));
}
test('Auto approve keeps project permission evaluation and skips native prompts; planning always refuses mutations', async () => {
  for (const planMode of [false, true]) await run(fixture(), { permissionMode: 'auto', planMode, canUseTool: () => assert.fail('Unexpected approval prompt') }, async turn => {
    assert.equal(turn.accessMode, planMode ? 'read-only' : 'approve');
    assert.equal(await turn.approve('write', { path: 'a', content: 'x' }), !planMode);
  });
});
test('Always allow persists only the selected tool for this task, including resumed chats', async () => {
  const host = fixture(); let prompts = 0;
  const canUseTool = async (name, input, options) => {
    prompts++;
    assert.equal(name, 'Write');
    assert.deepEqual(options.suggestions, [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }]);
    return { behavior: 'allow', updatedInput: input, updatedPermissions: options.suggestions };
  };
  await run(host, { canUseTool }, async turn => {
    assert.equal(await turn.approve('write', { path: 'a', content: 'x' }), true);
    assert.equal(await turn.approve('write', { path: 'b', content: 'y' }), true);
  });
  assert.equal(prompts, 1);
  await run(host, { canUseTool: () => assert.fail('Remembered choice prompted again') }, async turn => {
    assert.equal(await turn.approve('write', { path: 'c', content: 'z' }), true);
  });
  await run(host, { canUseTool: async () => ({ behavior: 'deny' }) }, async turn => {
    assert.equal(await turn.approve('shell', { command: 'anything' }), false);
  });
  await run(fixture(), { canUseTool: async () => ({ behavior: 'deny' }) }, async turn => {
    assert.equal(await turn.approve('write', { path: 'a', content: 'x' }), false);
  });
});
test('Allow once, malformed grants and unrelated permission updates never establish remembered access', async () => {
  for (const updatedPermissions of [undefined, [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'projectSettings' }]]) {
    let prompts = 0;
    await run(fixture(), { canUseTool: async () => { prompts++; return { behavior: 'allow', updatedPermissions }; } }, async turn => {
      await turn.approve('write', { path: 'a' }); await turn.approve('write', { path: 'b' });
    });
    assert.equal(prompts, 2);
  }
});
