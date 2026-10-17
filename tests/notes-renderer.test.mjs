import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { patchSecondaryArtwork } from '../src/workbench-patch.mjs';
import { createNotchWorkbench } from '../src/workbench-skin.mjs';
import { rebrandWorkbenchText } from '../src/bundle-patch.mjs';
test('Notes uses a themed wordmark, plain welcome and empty state while retaining header controls', () => {
  const source = 'const appleTreeIllustration="data:image/webp;base64,old",keep=1;function createQuickNoteOnboardingPresentation(){return old;}async function createQuickNoteOnboardingInput(){return loadOldImage();}function QuickNoteWindowSurface(){async function load(){let Y1=await listQuickNotes();return Y1;}return load();}function QuickNoteEmptyState(){return oldDuck;}function QuickNoteWindowHeader(){return jsxRuntimeExports.jsxs("header",{children:[jsxRuntimeExports.jsx("h1",{children:[oldScript,italicNotes]}),jsxRuntimeExports.jsx("button",{onClick:closeNotes,"aria-label":"Close notes"})]});}';
  const patched = patchSecondaryArtwork(source); parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(patchSecondaryArtwork(patched), patched);
  const branded = rebrandWorkbenchText(patched);
  assert.equal(patchSecondaryArtwork(branded), branded);
  assert.doesNotMatch(patched, /oldDuck|oldScript|italicNotes|loadOldImage/);
  for (const kept of ['notchRefreshBuiltinNotes(Y1,updateQuickNote)', 'onClick:closeNotes', '"aria-label":"Close notes"', 'attachments:[]', 'const appleTreeIllustration="data:image/svg+xml;base64,']) assert.ok(patched.includes(kept));
  const React = { createElement: (type, props) => ({ type, props }) };
  for (const theme of ['forest-dark', 'forest-light']) {
    const { Wordmark } = createNotchWorkbench(React, () => ({ resolvedTheme: theme }));
    const image = Wordmark({ width: 86 }); assert.equal(image.props.alt, 'notch'); assert.equal(image.props.width, 86);
    assert.ok(image.props.src.endsWith(theme.endsWith('dark') ? 'notch-wordmark-dark.svg' : 'notch-wordmark-light.svg'));
  }
});
test('a failed cosmetic welcome update leaves all loaded notes available', async () => {
  const source = 'function createQuickNoteOnboardingPresentation(){}async function createQuickNoteOnboardingInput(){}function QuickNoteWindowSurface(){async function load(){let Y1=await listQuickNotes();return Y1;}return load();}';
  const patched = patchSecondaryArtwork(source).replace(/^import[^\n]+\n/, '');
  const notes = [{ id: 'personal-note', text: 'Keep this available' }], warnings = [];
  const result = await new Function('listQuickNotes', 'notchRefreshBuiltinNotes', 'updateQuickNote', 'toast', patched + ';return QuickNoteWindowSurface();')(async () => notes, async () => { throw new Error('Disk full'); }, () => {}, { error: message => warnings.push(message) });
  assert.equal(result, notes); assert.equal(warnings.length, 1); assert.match(warnings[0], /notes are still available/);
});
test('Notes follows the theme palette without enabling workbench layout rules in its window', () => {
  const source = 'function QuickNoteThemeSync(){const{setWindowThemeMode:t1}=useTheme();return reactExports.useEffect(()=>{},[]);}';
  const patched = patchSecondaryArtwork(source);
  assert.equal(patchSecondaryArtwork(rebrandWorkbenchText(patched)), rebrandWorkbenchText(patched));
  for (const appearance of ['light', 'dark']) {
    const document = { documentElement: { dataset: {} } };
    new Function('document', 'reactExports', 'useTheme', patched + ';QuickNoteThemeSync();')(document, { useEffect: action => action() }, () => ({ resolvedTheme: 'forest-' + appearance, setWindowThemeMode() {} }));
    assert.equal(document.documentElement.dataset.notchNotes, 'true');
    assert.equal(document.documentElement.dataset.notchAppearance, appearance);
    assert.equal(document.documentElement.dataset.notchWorkbench, undefined);
  }
});
