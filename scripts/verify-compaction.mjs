import assert from 'node:assert/strict';
import { runDesktopTurn, CheckpointManager, estimateTokens } from '../vendor/notch-core/desktop-harness.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const model = 'notch-hf-abd14067e8d7:latest', root = 'http://127.0.0.1:11436';
const cwd = await fs.mkdtemp(path.join(os.tmpdir(),'notch-compaction-real-'));
const messages = [{role:'user',content:'The project verification phrase is SILVER-MAUVE-739. Preserve this decision.'}];
for (let i=0;i<20;i++) messages.push({role:'user',content:`Earlier completed task ${i}: notes for context testing.`},
  {role:'assistant',content:'Completed file review with no remaining changes. Tests passed. Preserve project decisions and continue. '.repeat(25)});
messages.push({role:'user',content:'What was the project verification phrase? Reply with it and COMPACTION_VERIFIED. Do not use tools.'});
const before=estimateTokens(messages);let archived=0,usage;
try {
  const result=await runDesktopTurn({cwd,sessionId:'real-compaction-test',messages,model:`ollama/${model}`,baseUrl:`${root}/v1`,contextWindow:8192,ollamaBatch:64,
    accessMode:'read-only',signal:AbortSignal.timeout(180000),checkpoints:new CheckpointManager(),tools:['Read'],approve:async()=>false,
    onCompact:async original=>{archived++;await fs.writeFile(path.join(cwd,'before-compaction.json'),JSON.stringify(original));},onUsage:value=>{usage=value;}});
  await fs.writeFile(path.join(cwd,'after-compaction.json'),JSON.stringify(result.messages));
  const passed=result.text.includes('SILVER-MAUVE-739') && result.text.includes('COMPACTION_VERIFIED') && archived>0;
  const report={passed,before,after:estimateTokens(result.messages),archived,usage,text:result.text,cwd};
  await fs.writeFile(path.resolve('../notch-context-compaction-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(passed,true);
} finally {
  await fetch(`${root}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,keep_alive:0})});
}
