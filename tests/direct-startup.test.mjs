import {test} from 'node:test';
import assert from 'node:assert/strict';
import {patchDirectStartup} from '../src/bundle-patch.mjs';
test('direct installer startup has no dependency on a previous launcher installation',async()=>{
  const source='async function aBt(options){return oldLauncher(options);} function checkPath(path){if(!path)throw new Error("invalid path");return path;}';
  const patched=patchDirectStartup(source);
  const start=new Function(`${patched};return aBt;`)();
  assert.equal(await start({platform:'win32',packaged:true,installType:'user'}),'current');
  assert.match(patched,/function checkPath\(path\)\{if\(!path\)throw new Error/);
  assert.equal(patchDirectStartup(patched),patched);
  assert.throws(()=>patchDirectStartup('function changedStartup(){}'),/Expected one upstream function aBt/);
});
