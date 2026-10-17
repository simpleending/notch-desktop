import {test} from 'node:test';
import assert from 'node:assert/strict';
import {patchProfileIcons} from '../src/bundle-patch.mjs';
test('isolated profiles keep window icons without scanning, watching, or rewriting shared shortcuts',async()=>{
  const source='function HUt(){const g=()=>{calls.push("system")},p=async()=>{calls.push("shortcuts")},m=()=>{calls.push("watch")},I=()=>calls.push("window");return {g,p,m,I}}';
  const patched=patchProfileIcons(source),calls=[];
  const create=new Function('calls',`${patched};return HUt`)(calls),previous=globalThis.__notchProfileOverride;
  try {
    globalThis.__notchProfileOverride={directory:'test-profile'};
    const isolated=create();isolated.g();await isolated.p();isolated.m();isolated.I();assert.deepEqual(calls,['window']);
    calls.length=0;globalThis.__notchProfileOverride=null;
    const normal=create();normal.g();await normal.p();normal.m();normal.I();assert.deepEqual(calls,['system','shortcuts','watch','window']);
  }finally{globalThis.__notchProfileOverride=previous;}
  assert.equal(patchProfileIcons(patched),patched);
  assert.throws(()=>patchProfileIcons('function HUt(){changed()}'),/differs from the inspected baseline/);
});
