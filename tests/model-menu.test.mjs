import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isModelSelectable} from '../src/model-menu.mjs';

test('freshly discovered models wait for the composer catalog instead of selecting missing keys',()=>{
  const row={key:'ollama/new-model',enabled:true},options=[{value:row.key,disabled:false}];
  assert.equal(isModelSelectable(row,[]),false);
  assert.equal(isModelSelectable(row,options,true),false);
  assert.equal(isModelSelectable(row,options),true);
  assert.equal(isModelSelectable(row,[{value:row.key,disabled:true}]),false);
  assert.equal(isModelSelectable({...row,enabled:false},options),false);
});
