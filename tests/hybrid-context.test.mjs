import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localContextProfile} from '../src/model-policy.mjs';
const GiB=2**30;
const hardware={totalMemory:32*GiB,availableMemory:14*GiB,totalVram:GiB/2,availableVram:0};
const info={'general.architecture':'qwen35','qwen35.block_count':33,'qwen35.context_length':262144,'qwen35.attention.head_count_kv':4,'qwen35.attention.key_length':256,'qwen35.attention.value_length':256,'qwen35.full_attention_interval':4};
const profile=(extra={},mounted={})=>localContextProfile(6404321191,hardware,{capabilities:['tools'],model_info:{...info,...extra}},mounted);
test('Qwen hybrid attention uses verified layer layout and conservatively rounds partial groups',()=>{
 assert.equal(profile().kvBytesPerToken,9*4*512*2);
 assert.equal(profile({'qwen35.attention.recurrent_layers':Array.from({length:33},(_,i)=>i%4!==3)}).kvBytesPerToken,8*4*512*2);
 for(const value of [0,-1,NaN,1.2,100,'4'])assert.equal(profile({'qwen35.full_attention_interval':value}).kvBytesPerToken,33*4*512*2);
});
test('live allocation anchors incremental context cost without counting integrated GPU shared RAM twice',()=>{
 const active={size:5922986393,size_vram:5922986393,context_length:16384};
 const fit=localContextProfile(6404321191,{...hardware,availableMemory:4*GiB},{capabilities:['tools'],model_info:info},active);
 assert(fit.choices.includes(16384));assert(fit.choices.includes(32768));assert(!fit.choices.includes(262144));
 assert.equal(fit.contextWindow,16384);
});
