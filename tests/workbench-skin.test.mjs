import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createNotchWorkbench } from '../src/workbench-skin.mjs';
import { patchWorkbenchRenderer } from '../src/workbench-patch.mjs';
const React = { createElement(type, props, ...children) { return { type, props: props || {}, children }; } };
function all(tree) { return [tree, ...tree.children.flat(Infinity).filter(child => child && typeof child === 'object').flatMap(all)]; }
test('appearance controls forward explicit choices to the existing preferences', () => {
  const choices = [], theme = { resolvedTheme: 'forest-dark', themeMode: 'dark', setThemeMode: value => choices.push(value) };
  const { ThemeControls, Appearance, QuickStart, ModeSwitch, PanelLauncher } = createNotchWorkbench(React, () => theme);
  ThemeControls().props.onClick(); assert.deepEqual(choices, ['light']);
  const changes = [], preferences = { fontStyle:'sans', fontSize:'medium', uiScale:'medium', chatWidth:'default', fileIconStyle:'notch', terminalThemeMode:'follow', terminalLinkOpenTarget:'external' };
  for (const key of ['FontStyle','FontSize','UiScale','ChatWidth','FileIconStyle','TerminalThemeMode','TerminalLinkOpenTarget']) preferences[`set${key}`] = value => changes.push([key, value]);
  const nodes = all(Appearance({ preferences, language:'en', setLanguage:value => changes.push(['Language',value]) }));
  const radios = nodes.filter(node => node.type === 'input');
  assert.deepEqual(radios.map(node => node.props.value), ['dark','light','auto']);
  radios[2].props.onChange(); assert.equal(choices.at(-1), 'auto');
  const width = nodes.find(node => node.props['aria-label'] === 'Content width');
  width.props.onChange({target:{value:'wide'}}); assert.deepEqual(changes, [['ChatWidth','wide']]);
  let opened = 0;
  all(QuickStart({onCreateWorkspace:() => opened++})).find(node => node.type === 'button').props.onClick();
  assert.equal(opened, 1);
  const modes = [], modeButtons = all(ModeSwitch({value:'coding',onValueChange:value=>modes.push(value)})).filter(node=>node.type==='button');
  modeButtons[0].props.onClick(); modeButtons[1].props.onClick();
  assert.deepEqual(modes,['general']);
  const panels = [], panelNodes = all(PanelLauncher({onOpenCode:()=>panels.push('files'),onOpenBrowser:()=>{},onOpenTerminal:()=>{},reviewAvailable:false}));
  const panelButtons = panelNodes.filter(node=>node.type==='button');
  assert.deepEqual(panelButtons.map(node=>node.props['aria-label']),['Files','Browser','Terminal']);
  panelButtons[0].props.onClick(); assert.deepEqual(panels,['files']);
  assert.equal(panelNodes.some(node=>node.type==='article'),false);
});

const fixture = `
function preloadDoodleAssets(){loadTrees();}
${['AgentGreetingMark','AppleTreeDoodle','ImageDoodle','PartnerPlanGreetingMark','MobileAppDownloadPromo','NewChatCursorGrid','WorkbenchModeThemeSync','WorkbenchSidebarModeSwitch','WorkspaceTabsEmptyState','normalizeThemeMode','readInitialThemeMode','readColorMode','AppearanceSettings','ProfileMenu','ProfileSettingsForm','isChatComposerVoiceHoldPlaceholderPhaseAvailable','notchLogoLoader','notchLogo'].map(name => `function ${name}(){oldAppearance();}`).join('\n')}
function ThemeProvider(){reactExports.useEffect(()=>{document.documentElement.setAttribute("data-theme",d1)},[d1]);}
function SettingsView(){const N2=p1?void 0:w2==="developer"?"general":w2;const H2=M2.flatMap(D3=>D3.items);return H2;}
function NewChatHomeContent(){return jsxRuntimeExports.jsxs("div",{"data-new-chat-b1-content":!0,children:[jsxRuntimeExports.jsx(PartnerPlanGreetingMark,{}),jsxRuntimeExports.jsx("h1",{children:"Beyond Coding"}),jsxRuntimeExports.jsx("div",{className:"mt-7 w-full max-w-[924px]",children:jsxRuntimeExports.jsx(NewChatWelcomeDashboard,{attentionEnabled:t1,attentionCount:n1,activity:r1,loadCreditsHeatmap:i1,onActivityPlaygroundEvent:s1,gameEntryDismissRequestId:h2})}),jsxRuntimeExports.jsx(ChatComposer,{onSubmit:J1,onStop:W1,placeholder:i2("newChat.placeholder")})]});}
function Frame(){return flag?jsxRuntimeExports.jsxs("div",{"data-layout-window-titlebar":!0,className:"titlebar",children:[jsxRuntimeExports.jsx("div",{style:{WebkitAppRegion:"no-drag"},children:K2}),jsxRuntimeExports.jsx("div",{"aria-hidden":!0,"data-layout-window-titlebar-drag-region":!0,style:{WebkitAppRegion:"drag"}})]}):jsxRuntimeExports.jsx("div",{className:"absolute left-4"});}
const illustration={dangerouslySetInnerHTML:{__html:workspaceFilesEmptyIllustrationRaw}};
function ChatComposerModelMenu(props){return oldModelMenu(props);}
const NotchSetup=createNotchSetup(reactExports);`;
test('reskin removes inherited art while preserving composer actions and native window controls', () => {
  const source = patchWorkbenchRenderer(fixture);
  parse(source,{ecmaVersion:'latest',sourceType:'module'});
  assert.doesNotMatch(source,/loadTrees|Beyond Coding|oldAppearance|dangerouslySetInnerHTML/);
  assert.match(source,/ChatComposer,\{onSubmit:J1,onStop:W1,/);
  assert.doesNotMatch(source,/Show pet|Get the mobile app|themeForest/);
  assert.match(source,/children:\[jsxRuntimeExports.jsx\(NotchWindowBrand,\{\}\),K2\]/);
  assert.match(source,/data-layout-window-titlebar-drag-region/);
  assert.match(source,/data-notch-appearance|dataset.notchAppearance/);
  assert.equal(patchWorkbenchRenderer(source), source);
  assert.throws(() => patchWorkbenchRenderer(fixture.replace('data-new-chat-b1-content','changed-layout')), /anchor changed/);
});
