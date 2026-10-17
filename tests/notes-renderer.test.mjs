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
  for (const kept of ['notchRefreshBuiltinNotes(await listQuickNotes(),updateQuickNote)', 'onClick:closeNotes', '"aria-label":"Close notes"', 'attachments:[]', 'const appleTreeIllustration="data:image/svg+xml;base64,']) assert.ok(patched.includes(kept));
  const React = { createElement: (type, props) => ({ type, props }) };
  for (const theme of ['forest-dark', 'forest-light']) {
    const { Wordmark } = createNotchWorkbench(React, () => ({ resolvedTheme: theme }));
    const image = Wordmark({ width: 86 }); assert.equal(image.props.alt, 'notch'); assert.equal(image.props.width, 86);
    assert.ok(image.props.src.endsWith(theme.endsWith('dark') ? 'notch-wordmark-dark.svg' : 'notch-wordmark-light.svg'));
  }
});
