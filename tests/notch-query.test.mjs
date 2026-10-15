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

test('native state follows running, approval and idle while context counts use the latest request', async () => {
  const f = fixture();
  const query = new NotchQuery(f.host,{cwd:process.cwd(),model:'ollama/fixture',prompt:'Write',canUseTool:async()=>({behavior:'allow'})},{runTurn:async turn=>{
    turn.onUsage({inputTokens:100,outputTokens:10,contextWindow:8192});
    await turn.approve('write',{path:'file',content:'x'},'','exact-call');
    turn.onUsage({inputTokens:150,outputTokens:20,contextWindow:8192});
    turn.onUsage({inputTokens:NaN,outputTokens:20,contextWindow:8192});
    return {messages:turn.messages};
  }});
  const events=[];for await(const event of query)events.push(event);
  assert.deepEqual(events.filter(event=>event.subtype==='session_state_changed').map(event=>event.state),['idle','running','requires_action','running','idle']);
  const usage=await query.getContextUsage();assert.equal(usage.totalTokens,170);assert.equal(usage.percentage,170/8192);
  assert.equal(f.saved.at(-1).contextUsage.totalTokens,170);
  usage.totalTokens=0;assert.equal((await query.getContextUsage()).totalTokens,170);
  await assert.rejects(query.setModel('unknown/model'),/available/);
  await query.setModel('ollama/fixture');assert.equal(await query.getContextUsage(),null);
});

test('model selection cannot change a turn that starts while the catalog is loading', async () => {
  const f=fixture();let send,finishCatalog,startCatalog,started;
  const input=new Promise(resolve=>{send=resolve;});
  const catalogStarted=new Promise(resolve=>{startCatalog=resolve;});
  const turnStarted=new Promise(resolve=>{started=resolve;});
  f.host.listModels=()=>{startCatalog();return new Promise(resolve=>{finishCatalog=resolve;});};
  async function* prompts(){yield {message:{content:await input}};}
  const query=new NotchQuery(f.host,{cwd:process.cwd(),model:'ollama/fixture',prompt:prompts()},{runTurn:async turn=>{
    started();await new Promise((_,reject)=>turn.signal.addEventListener('abort',()=>reject(turn.signal.reason),{once:true}));
  }});
  await query.ready;assert.equal(await query.getContextUsage(),null);
  const changing=query.setModel('ollama/new');await catalogStarted;
  send('Begin a task');await turnStarted;
  finishCatalog([{key:'ollama/new',enabled:true}]);
  await assert.rejects(changing,/Finish or interrupt/);assert.equal(query.model,'ollama/fixture');
  await query.close();
});
test('native compaction progress closes on success and failure without fabricated token counts',async()=>{
  for(const fail of [false,true]){
    const f=fixture();const query=new NotchQuery(f.host,{cwd:process.cwd(),prompt:'continue'},{runTurn:async turn=>{
      await turn.onLifecycle('pre-compact',{});if(fail)throw new Error('summary cancelled');await turn.onLifecycle('post-compact',{});return {messages:turn.messages};
    }});
    const events=[];for await(const event of query)events.push(event);
    assert.deepEqual(events.filter(event=>event.subtype==='status').map(event=>event.status),['compacting',null]);
    assert.equal(events.some(event=>event.subtype==='compact_boundary'),false);
  }
});

test('workbench file-review hooks are awaited with native names, inputs and matching call IDs', async () => {
  const f = fixture(), hooks = [];
  const query = new NotchQuery(f.host, { cwd: process.cwd(), prompt: 'write', hooks: {
    PreToolUse: [{ hooks: [async (input, id) => { hooks.push({ event: input.hook_event_name, name: input.tool_name, input: input.tool_input, id }); }] }],
    PostToolUse: [{ hooks: [async (input, id) => { hooks.push({ event: input.hook_event_name, id }); }] }],
  } }, { runTurn: async turn => {
    await turn.onLifecycle('pre-tool', { tool: 'write', args: { path: 'file.txt', content: 'x' }, toolCallId: 'exact-id' });
    assert.equal(hooks.length, 1);
    await turn.onLifecycle('post-tool', { tool: 'write', args: { path: 'file.txt', content: 'x' }, result: 'done', toolCallId: 'exact-id' });
    return { messages: turn.messages };
  } });
  for await (const _event of query) {}
  assert.deepEqual(hooks, [{ event: 'PreToolUse', name: 'Write', input: { file_path: 'file.txt', content: 'x' }, id: 'exact-id' }, { event: 'PostToolUse', id: 'exact-id' }]);
});
