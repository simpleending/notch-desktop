import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchSecondaryArtwork } from '../src/workbench-patch.mjs';
test('task activity uses simple mauve circles while errors and waiting keep distinct meanings', () => {
  const source = 'function SidebarSessionStateIndicator({kind}){return kind==="running"?jsxRuntimeExports.jsx(ThinkingDotMatrixIcon,{className:"text-current",sizeClassName:"size-4"}):kind==="unread"?"bg-info":kind==="error"?"text-error":"text-warning";}function SessionMiniIndicator({kind}){return kind==="running"?"bg-primary":kind==="unread"?"bg-info":kind==="error"?"bg-error":"bg-warning";}function TaskMonitorRunningIndicator(){return "size-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none";}';
  const result = patchSecondaryArtwork(source);
  assert.equal(patchSecondaryArtwork(result), result);
  assert.doesNotMatch(result, /ThinkingDotMatrixIcon|bg-primary|bg-info/);
  assert.match(result, /text-error/); assert.match(result, /text-warning/);
  assert.match(result, /bg-error/); assert.match(result, /bg-warning/);
  const css = readFileSync(new URL('../src/workbench-skin.css', import.meta.url), 'utf8');
  assert.match(css, /\.notch-task-dot\{[^}]*border-radius:50%;[^}]*background:var\(--notch-accent,#dab5d1\);animation:none!important/);
});
