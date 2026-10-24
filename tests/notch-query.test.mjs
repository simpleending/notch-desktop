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
for (const status of ['stalled','verification-failed','max-iterations']) test(`adapter preserves ${status} as a failed result`,async()=>{
  const f=fixture();const query=new NotchQuery(f.host,{cwd:process.cwd(),prompt:'Verify'},{runTurn:async turn=>({status,text:'Checks have not passed.',messages:turn.messages})});
  const events=[];for await(const event of query)events.push(event);
  assert.equal(events.at(-1).subtype,'error_during_execution');assert.equal(events.at(-1).is_error,true);
  assert.match(events.at(-1).result,/Checks have not passed/);assert.notEqual(events.at(-1).terminal_reason,'user_interrupted');
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

test('a new turn waits for model selection and its saved state instead of racing it', async () => {
  const f=fixture();let send,finishCatalog,startCatalog,started;
  const input=new Promise(resolve=>{send=resolve;});
  const catalogStarted=new Promise(resolve=>{startCatalog=resolve;});
  const turnStarted=new Promise(resolve=>{started=resolve;});
  f.host.listModels=()=>{startCatalog();return new Promise(resolve=>{finishCatalog=resolve;});};
  async function* prompts(){yield {message:{content:await input}};}
  const query=new NotchQuery(f.host,{cwd:process.cwd(),model:'ollama/fixture',prompt:prompts()},{runTurn:async turn=>{
    assert.equal(turn.model,'ollama/new');started();await new Promise((_,reject)=>turn.signal.addEventListener('abort',()=>reject(turn.signal.reason),{once:true}));
  }});
  await query.ready;assert.equal(await query.getContextUsage(),null);
  const changing=query.setModel('ollama/new');await catalogStarted;
  send('Begin a task');await new Promise(resolve=>setImmediate(resolve));assert.equal(query.active,undefined);
  await assert.rejects(query.setModel('ollama/fixture'),/previous model selection/);
  finishCatalog([{key:'ollama/new',enabled:true}]);
  await changing;await turnStarted;assert.equal(query.model,'ollama/new');
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

test('an automation canceled while session history loads never reaches inference',async()=>{
  const f=fixture(),abort=new AbortController;let release,started,turns=0;const loading=new Promise(resolve=>{started=resolve;});
  f.host.loadSession=async()=>{started();await new Promise(resolve=>release=resolve);return{messages:[]};};
  const query=new NotchQuery(f.host,{cwd:process.cwd(),sessionId:'automation-load-race',prompt:'Run',automation:{signal:abort.signal}},{runTurn:async turn=>{turns++;return{messages:turn.messages};}});
  await loading;abort.abort(Object.assign(Error('The automation reached its time limit.'),{code:'timeout'}));release();for await(const _event of query){}assert.equal(turns,0);
});

test('merged automation turns rebind cancellation and token budgets instead of keeping the first run',async()=>{
  const f=fixture(),first=new AbortController,second=new AbortController,usages=[0,0];let turns=0;
  f.host.automations={queryOptions:()=>turns===0?{signal:first.signal,maxTokens:10,usage:()=>usages[0]++}:{signal:second.signal,maxTokens:20,usage:()=>usages[1]++}};
  async function* prompts(){yield{message:{content:'First run'}};first.abort(Error('Earlier run ended'));yield{message:{content:'Second run'}};}
  const query=new NotchQuery(f.host,{cwd:process.cwd(),sessionId:'merged-limits',prompt:prompts()},{runTurn:async turn=>{
    assert.equal(turn.signal.aborted,false);assert.equal(turn.maxTotalTokens,turns===0?10:20);turns++;turn.onUsage({inputTokens:1,outputTokens:1,contextWindow:8192});return{messages:turn.messages};
  }});for await(const _event of query){}assert.equal(turns,2);assert.deepEqual(usages,[1,1]);
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
