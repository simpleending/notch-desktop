import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { patchSecondaryArtwork, installWorkbenchAssets } from '../src/workbench-patch.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNotchWorkbench } from '../src/workbench-skin.mjs';
test('compact quill, block pen and polishing artwork use dots without changing actions', () => {
  const image = 'jsxRuntimeExports.jsx("img",{"data-quick-note-create-raster":!0,src:t1,alt:"",className:`pointer-events-none absolute left-1/2 top-1/2 size-14 max-w-none -translate-x-1/2 -translate-y-1/2 object-cover ${n1?"brightness-[1.08] saturate-[0.92]":""}`})';
  const source = `function QuickNoteCreateButton(){return jsxRuntimeExports.jsx(IconButton,{onClick:s1,"aria-label":e1,tabIndex:r1?-1:0,icon:jsxRuntimeExports.jsxs("span",{className:"relative size-10 overflow-hidden",children:[${image},jsxRuntimeExports.jsx(notchQuillPenLine,{size:24,className:"text-white"})]})});}function ExplainButton(){return jsxRuntimeExports.jsx(notchQuillPenAiLine,{className:"size-3.5","aria-hidden":!0});}function OtherPens(){return [jsxRuntimeExports.jsx(FeatherIcon,{size:16}),jsxRuntimeExports.jsx(CustomInputWritingPen,{animationCycle:1}),jsxRuntimeExports.jsx(notchPencilLine,{"aria-label":"Edit"})];}`;
  const patched = patchSecondaryArtwork(source); parse(patched, { ecmaVersion: 'latest' });
  assert.equal(patchSecondaryArtwork(patched), patched);
  assert.doesNotMatch(patched, /notchQuillPen|data-quick-note-create-raster|jsxRuntimeExports.jsx\("img"/);
  assert.equal([...patched.matchAll(/jsxRuntimeExports.jsx\(notchDot,/g)].length, 4);
  assert.match(patched,/jsxRuntimeExports.jsx\(notchPencilLine,\{"aria-label":"Edit"\}/);
  for (const kept of ['onClick:s1', '"aria-label":e1', 'tabIndex:r1?-1:0', 'notch-quick-note-create', 'notch-quick-note-mark']) assert.ok(patched.includes(kept));
  assert.throws(() => patchSecondaryArtwork(source.replace('src:t1', 'src:changed')), /anchor|Expected|occurrence/i);
});
test('already branded bundles migrate compact n marks and wire their dot component exactly once', () => {
  const source='const {Symbol:notchSymbol,Wordmark:notchNotesWordmark}=createnotchWorkbench(reactExports,useTheme);function QuickNoteCreateButton(){return jsxRuntimeExports.jsx(notchSymbol,{size:24});}function TaskMonitorConversationRecapCard(){return jsxRuntimeExports.jsx(notchSymbol,{size:24,className:"notch-recap-mark"});}';
  const patched=patchSecondaryArtwork(source);
  assert.match(patched,/Symbol:notchSymbol,Dot:notchDot,Wordmark:/);
  assert.match(patched,/jsxRuntimeExports.jsx\(notchDot,\{size:24\}/);
  assert.match(patched,/notchNotesWordmark,\{width:62,className:"notch-recap-mark"/);
  assert.equal(patchSecondaryArtwork(patched),patched);
});
test('compact dots inherit both themes and do not introduce animation or change their footprint', () => {
  const React={createElement(type,props,...children){return {type,props,children};}};
  for(const resolvedTheme of ['notch-dark','notch-light']) {
    const {Dot}=createNotchWorkbench(React,()=>({resolvedTheme}));
    const mark=Dot({size:24,className:'size-4'});
    assert.equal(mark.type,'svg');assert.equal(mark.props.fill,'currentColor');
    assert.equal(mark.props.width,24);assert.equal(mark.props.className,'notch-dot size-4');
    assert.equal(mark.children[0].type,'circle');assert.equal(mark.children[0].props.r,4);
  }
});
test('packaged brand logos all contain the canonical mark without replacing provider logos', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-brand-assets-'));
  const application = path.join(temporary, 'application'), renderer = path.join(application, 'out/renderer'), assets = path.join(renderer, 'assets');
  try {
    await fs.mkdir(assets, { recursive: true }); await fs.mkdir(path.join(temporary, 'resources/application-icons'), { recursive: true });
    await fs.writeFile(path.join(renderer, 'index.html'), '<head></head>');
    const names = ['CnIdeLogo', 'DoorLogo', 'IdeLogo', 'Logo', 'workCnLogo', 'workLogo', 'worklogo'].map(name => 'notch' + name + '-fixture.svg');
    const otherBrand = ['duckHead-fixture.png', 'dog-fixture.svg', 'voice_thinking_00001-fixture.webp', 'quickNoteOnboardingFirstNote-fixture.webp', 'profileStickerSparseState-fixture.svg', 'notch-loading-line-fixture.svg'];
    for (const name of [...names, ...otherBrand, 'providerLogo-fixture.svg', 'yarn-fixture.svg']) await fs.writeFile(path.join(assets, name), 'old artwork');
    const project = fileURLToPath(new URL('..', import.meta.url));
    await installWorkbenchAssets(application, project);
    const canonical = await fs.readFile(path.join(project, 'assets/notch-symbol.svg'), 'utf8');
    for (const name of names) assert.equal(await fs.readFile(path.join(assets, name), 'utf8'), canonical);
    for (const name of otherBrand) {
      const extension = path.extname(name), expected = /^(?:duckHead|dog)-/.test(name) ? 'notch-symbol' : 'notch-brand-card';
      assert.deepEqual(await fs.readFile(path.join(assets, name)), await fs.readFile(path.join(project, 'assets', expected + extension)));
    }
    assert.equal(await fs.readFile(path.join(assets, 'providerLogo-fixture.svg'), 'utf8'), 'old artwork');
    assert.equal(await fs.readFile(path.join(assets, 'yarn-fixture.svg'), 'utf8'), 'old artwork');
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
