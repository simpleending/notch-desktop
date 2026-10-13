import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHost } from '../src/notch-host.mjs';
const cwd = await mkdtemp(path.join(os.tmpdir(), 'notch-harness-live-'));
const host = createHost(path.join(cwd, 'agent-state'));
const choices = await host.listModels(true), model = choices.find(row => row.key.includes('notch-hf-'))?.key;
if (!model) throw new Error('Install the tested Hugging Face model with notch models before this live check.');
await writeFile(path.join(cwd, 'test.mjs'), `import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);assert.throws(()=>sum('2',3),TypeError);console.log('Passed');`);
const approvals = [], events = [], started = Date.now();
const query = host.query({ cwd, model, permissionMode: 'default', maxTurns: 10,
  prompt: 'Read test.mjs, create sum.mjs exporting sum(a,b) that adds finite numbers and rejects non-number inputs with TypeError. Run node test.mjs. Report the result.',
  canUseTool: async (name, input, options) => { approvals.push({ name, id: options.toolUseID }); return { behavior: 'allow', updatedInput: input }; },
});
try {
  for await (const event of query) events.push(event);
  assert.equal(events.at(-1)?.subtype, 'success');
  assert.ok(approvals.some(row => row.name === 'Write' || row.name === 'Edit' || row.name === 'ApplyPatch'));
  const implementation = await readFile(path.join(cwd, 'sum.mjs'), 'utf8');
  const { sum } = await import(`data:text/javascript;base64,${Buffer.from(implementation).toString('base64')}`);
  assert.equal(sum(2, 3), 5); assert.throws(() => sum('2', 3), TypeError);
  assert.throws(() => sum(NaN, 1), TypeError); assert.throws(() => sum(1, Infinity), TypeError);
  const report = { passed: true, cwd, model, elapsedMs: Date.now() - started, approvals, toolResults: events.filter(event => event.type === 'user' && event.message?.content?.[0]?.type === 'tool_result').length };
  await writeFile(path.join(cwd, 'evaluation.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await query.close();
  const name = model.slice('ollama/'.length);
  await Promise.allSettled([11434,11436].map(port => fetch(`http://127.0.0.1:${port}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, stream: false, keep_alive: 0 }), signal: AbortSignal.timeout(10000) })));
}
