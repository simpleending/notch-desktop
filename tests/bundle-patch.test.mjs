import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchClassMethod, rebrandWorkbenchText, patchUndoIntegration, patchMcpShutdownBudget } from '../src/bundle-patch.mjs';

test('MCP budget migration refuses drift and duplicate participants and is repeatable',()=>{
  const participant='const mOr=3e3,FVe=1e3;yo("mcp.shutdown","critical",4e3,()=>t.mcpService.shutdown())';
  const patched=patchMcpShutdownBudget(participant);
  assert.equal(patchMcpShutdownBudget(patched),patched);
  assert.throws(()=>patchMcpShutdownBudget('changed'),/differ/);
  assert.throws(()=>patchMcpShutdownBudget(participant+patched),/differ/);
});
test('method patches respect strings, regex braces and nested template expressions', () => {
  const source = 'let Demo=class extends Base{target(t){const regex=/[{}]/;const x=`hi ${ {a:1}.a }`;return "}"}other(){return 2}};';
  const result = patchClassMethod(source, 'Demo', 'target', 'return "Notch";');
  assert.equal(result, 'let Demo=class extends Base{target(t){return "Notch";}other(){return 2}};');
});

test('method patches support named classes with an inherited base',()=>{
  assert.equal(patchClassMethod('class Demo extends Base{async target(){return 1}other(){return 3}}','Demo','target','return 2;'),'class Demo extends Base{async target(){return 2;}other(){return 3}}');
});
test('patching refuses missing/ambiguous upstream interfaces instead of guessing', () => {
  assert.throws(() => patchClassMethod('let Demo=class{other(){}}', 'Demo', 'missing', ''), /Expected one/);
  assert.throws(() => patchClassMethod('let Demo=class{target(){}target(){}}', 'Demo', 'target', ''), /Expected one/);
});
test('patches real default-parameter call expressions without matching nested methods', () => {
  const source = 'let Demo=class{target(t=next()){const nested={target(){return 1}};return nested}};';
  assert.equal(patchClassMethod(source, 'Demo', 'target', 'return 2;'), 'let Demo=class{target(t=next()){return 2;}};');
});

test('method names inside other method default strings are not treated as declarations',()=>{
  const source='class Demo{install(t){return oldCloud(t)}installInternal(t,mode="install"){return mode}}';
  assert.equal(patchClassMethod(source,'Demo','install','return "local";'),'class Demo{install(t){return "local";}installInternal(t,mode="install"){return mode}}');
});
test('branding updates names, vendor namespace references and renderer globals while preserving real models', () => {
  const result = rebrandWorkbenchText('import sdk from "@qoder-ai/qoder-agent-sdk";window.qoderDesktop;"Qoder";"Qwen3.5";"qoder-boot-logo";');
  assert.equal(result, 'import sdk from "@notch-ai/notch-agent-sdk";window.notchDesktop;"notch";"Qwen3.5";"notch-boot-logo";');
});
test('removed cloud URLs use a reserved disabled host rather than an unrelated notch.com domain', () => {
  assert.equal(rebrandWorkbenchText('https://api.qoder.com/path'), 'https://disabled.notch.invalid/path');
  assert.equal(rebrandWorkbenchText('"https://btardsb9ml-default-sea.rum.aliyuncs.com/rum/web/v2?workspace=legacy&service_id=legacy"'),'"https://disabled.notch.invalid/telemetry"');
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
