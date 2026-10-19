import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isModelSelectable, fallbackCandidates} from '../src/model-menu.mjs';

test('freshly discovered models wait for the composer catalog instead of selecting missing keys',()=>{
  const row={key:'ollama/new-model',enabled:true},options=[{value:row.key,disabled:false}];
  assert.equal(isModelSelectable(row,[]),false);
  assert.equal(isModelSelectable(row,options,true),false);
  assert.equal(isModelSelectable(row,options),true);
  assert.equal(isModelSelectable(row,[{value:row.key,disabled:true}]),false);
  assert.equal(isModelSelectable({...row,enabled:false},options),false);
});
test('OpenRouter fallback candidates omit the primary, the current chain, and models without tools',()=>{
  const rows=[
    {key:'openrouter/lab/primary',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/fast',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/floor',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/chat',provider:'openrouter',enabled:true,tools:false},
    {key:'ollama/local',provider:'ollama',enabled:true},
  ];
  assert.deepEqual(fallbackCandidates(rows,'openrouter/lab/primary',['openrouter/lab/fast']).map(row=>row.key),['openrouter/lab/floor']);
});
