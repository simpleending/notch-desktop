import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchClassMethod, rebrandWorkbenchText, patchUndoIntegration } from '../src/bundle-patch.mjs';
test('method patches respect strings, regex braces and nested template expressions', () => {
  const source = 'let Demo=class extends Base{target(t){const regex=/[{}]/;const x=`hi ${ {a:1}.a }`;return "}"}other(){return 2}};';
  const result = patchClassMethod(source, 'Demo', 'target', 'return "Notch";');
  assert.equal(result, 'let Demo=class extends Base{target(t){return "Notch";}other(){return 2}};');
});
test('patching refuses missing/ambiguous upstream interfaces instead of guessing', () => {
  assert.throws(() => patchClassMethod('let Demo=class{other(){}}', 'Demo', 'missing', ''), /Expected one/);
  assert.throws(() => patchClassMethod('let Demo=class{target(){}target(){}}', 'Demo', 'target', ''), /Expected one/);
});
test('patches real default-parameter call expressions without matching nested methods', () => {
  const source = 'let Demo=class{target(t=next()){const nested={target(){return 1}};return nested}};';
  assert.equal(patchClassMethod(source, 'Demo', 'target', 'return 2;'), 'let Demo=class{target(t=next()){return 2;}};');
});
test('branding updates names, vendor namespace references and renderer globals while preserving real models', () => {
  const result = rebrandWorkbenchText('import sdk from "@qoder-ai/qoder-agent-sdk";window.qoderDesktop;"Qoder";"Qwen3.5";"qoder-boot-logo";');
  assert.equal(result, 'import sdk from "@notch-ai/notch-agent-sdk";window.notchDesktop;"notch";"Qwen3.5";"notch-boot-logo";');
});
test('removed cloud URLs use a reserved disabled host rather than an unrelated notch.com domain', () => {
  assert.equal(rebrandWorkbenchText('https://api.qoder.com/path'), 'https://disabled.notch.invalid/path');
});
test('lowercase product error identifiers remain valid in the startup error catalog', () => {
  const source = rebrandWorkbenchText('/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u');
  const expression = new Function(`return ${source}`)();
  assert.equal(expression.test('notch_EXECUTION_CONTROL_FAILED'), true);
  assert.equal(expression.test('invalid code'), false);
});

test('native review tracks patch tools and move destinations and the port patch is idempotent', () => {
  const source = 'const _Ke=new Set(["write","edit"]);function access(){if(n){const c=this.dependencies.runtimeManager.acquireRewindSession(e);}}function Xme(){return oldValidator;}function bPe(t){return _Ke.has(t);}function cnr(t,e){return [...e.input.matchAll(/^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/gm)].map(row=>row[1]);}';
  const patched = patchUndoIntegration(source);
  assert.equal(patchUndoIntegration(patched), patched);
  const methods = new Function(`${patched};return {tracked:bPe,paths:cnr};`)();
  assert.equal(methods.tracked('apply_patch'), true);
  assert.deepEqual(methods.paths('apply_patch', {input:'*** Update File: old.txt\n*** Move to: new.txt'}), ['old.txt','new.txt']);
});
