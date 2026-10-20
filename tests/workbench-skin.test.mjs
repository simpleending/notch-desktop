import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createNotchWorkbench } from '../src/workbench-skin.mjs';
import { patchWorkbenchRenderer, patchSecondaryArtwork, patchVoiceOverlayArtwork, patchThemeBroadcast } from '../src/workbench-patch.mjs';
import { patchFunction } from '../src/bundle-patch.mjs';
const React = { useState(value){return [value,()=>{}];},useEffect(){}, createElement(type, props, ...children) { return { type, props: props || {}, children }; } };
function all(tree) { return [tree, ...tree.children.flat(Infinity).filter(child => child && typeof child === 'object').flatMap(all)]; }

test('About uses the theme-aware wordmark and installed version with a working close action', () => {
  const patched = patchSecondaryArtwork('function AboutDialog(){return oldStickerAndSlogan();}');
  assert.doesNotMatch(patched, /oldStickerAndSlogan|StickerPeel|commitHash|buildDate/);
  assert.equal(patchSecondaryArtwork(patched), patched);
  const jsx = (type, props) => ({ type, props }), changes = [];
  const render = new Function('jsxRuntimeExports', 'ContentDialog', 'notchNotesWordmark', patched + ';return AboutDialog;')({ jsx, jsxs: jsx }, 'dialog', 'wordmark');
  const tree = render({ open: true, application: { version: '0.1.19' }, onOpenChange: value => changes.push(value) });
  const children = tree.props.children.props.children;
  assert.equal(children[0].type, 'wordmark');
  assert.equal(children[1].props.children, 'Version 0.1.19');
  assert.equal(children[2].props.children, 'by freesyntax.dev');
  tree.props.onClose();assert.deepEqual(changes, [false]);
});

test('secondary windows request and follow the main window theme without rebroadcasting or leaking channels',()=>{
  const source='function ThemeProvider(){const n1="light";const m1=reactExports.useMemo(()=>({}),[]);return m1;}';
  const patched=patchThemeBroadcast(source);parse(patched,{ecmaVersion:'latest'});assert.equal(patchThemeBroadcast(patched),patched);
  for(const secondary of [false,true]){
    let channel,cleanup;const modes=[],colors=[],sent=[];
    class Channel{constructor(name){assert.equal(name,'notch-appearance');channel=this;}postMessage(value){sent.push(value);}close(){this.closed=true;}}
    const reactExports={useEffect(fn){cleanup=fn();},useMemo(fn){return fn();}};
    new Function('reactExports','BroadcastChannel','window','r1','s1','normalizeThemeMode','readColorMode',patched+';ThemeProvider();')(reactExports,Channel,{location:{search:secondary?'?surface=live-voice-overlay':''}},v=>modes.push(v),v=>colors.push(v),v=>v,v=>v);
    assert.deepEqual(sent,[secondary?'get-theme':'light']);
    channel.onmessage({data:'invalid'});assert.deepEqual(modes,[]);
    channel.onmessage({data:'dark'});assert.deepEqual(modes,secondary?['dark']:[]);assert.deepEqual(colors,modes);
    channel.onmessage({data:'get-theme'});assert.deepEqual(sent,secondary?['get-theme']:['light','light']);
    cleanup();assert.equal(channel.closed,true);
  }
});

test('voice artwork is static notch branding while native controls, status and reduced-motion handling remain', () => {
  const frames = ['qoduck-voice-frame','qoduck-voice-glass-light','qoduck-voice-glass-dark'].map((id,index) => `jsxRuntimeExports.jsx("img",{id:"${id}",${index?'className:"qoduck-voice-glass",':''}src:${['w1','qoduckVoiceGlassLightSrc','qoduckVoiceGlassDarkSrc'][index]},alt:"",width:${index?120:104},height:${index?120:104},draggable:!1})`).join(',');
  const source = `function LiveVoiceOverlaySurface(){const [s1,o1]=reactExports.useState(0),c1=reactExports.useRef(null);const x1=t1?resolveQoduckFrameSetName(t1):"normal",frames=oldSprites();reactExports.useEffect(()=>{const j1=c1.current;bindControls(j1)},[]);const M1="Listening";return jsxRuntimeExports.jsxs("main",{children:[jsxRuntimeExports.jsx(FloatingCaptionBubble,{}),jsxRuntimeExports.jsx("span",{id:"orb-halo"}),jsxRuntimeExports.jsxs("span",{id:"orb-core",children:[${frames}]}),jsxRuntimeExports.jsx("span",{id:"orb-status",role:"status",children:M1}),...['toggleMuted','toggleMicrophone','close'].map(action=>jsxRuntimeExports.jsx("button",{onClick:()=>window.notchLiveVoiceOverlay.action({action}),children:action}))],onClose:()=>window.matchMedia("(prefers-reduced-motion: reduce)").matches});}`;
  const patched = patchVoiceOverlayArtwork(source);
  parse(patched,{ecmaVersion:'latest'});
  assert.doesNotMatch(patched,/qoduck|oldSprites|useState\(0\)|orb-halo/);
  assert.match(patched,/NotchSymbol,\{size:36\}/);
  assert.doesNotMatch(patched,/children:\[[^\]]*NotchSymbol[^\]]*,"notch"/);
  assert.match(patched,/notch-voice-colors/);
  assert.match(patched,/--notch-voice-background:#242228/);
  assert.match(patched,/--notch-voice-text:#f4f1f5/);
  for(const control of ['toggleMuted','toggleMicrophone','close','role:"status"','prefers-reduced-motion']) assert.ok(patched.includes(control));
  assert.equal(patchVoiceOverlayArtwork(patched),patched);
  const previous=patched.replace('jsxRuntimeExports.jsx("span",{className:"notch-voice-brand","aria-label":"notch",children:jsxRuntimeExports.jsx(NotchSymbol,{size:36})})','jsxRuntimeExports.jsxs("span",{className:"notch-voice-brand",style:{display:"flex",alignItems:"center",gap:6,fontSize:20,fontWeight:600,letterSpacing:"-.6px"},children:[jsxRuntimeExports.jsx(NotchSymbol,{size:22}),"notch"]})');
  assert.equal(patchVoiceOverlayArtwork(previous),patched);
  assert.equal(patchSecondaryArtwork(patched),patched);
  assert.throws(()=>patchVoiceOverlayArtwork(source.replace('id:"orb-core"','id:"changed"')),/anchor changed/);
});

test('recap artwork uses the wordmark without changing content or handoff controls',()=>{
  const source='function TaskMonitorConversationRecapCard({recap}){return jsxRuntimeExports.jsxs("section",{children:[jsxRuntimeExports.jsxs("span",{className:"relative size-5 shrink-0",children:[jsxRuntimeExports.jsx("svg",{children:"green gradient"}),jsxRuntimeExports.jsx(notchQuillPenAiLine,{color:"green"})]}),recap.text,jsxRuntimeExports.jsx(ChatSessionHandoffDialog,{})]});}';
  const patched=patchSecondaryArtwork(source);parse(patched,{ecmaVersion:'latest'});
  assert.match(patched,/notchNotesWordmark,\{width:62,className:"notch-recap-mark"/);
  assert.doesNotMatch(patched,/notchQuillPenAiLine|green gradient/);
  assert.match(patched,/recap.text/);assert.match(patched,/ChatSessionHandoffDialog/);
  assert.equal(patchSecondaryArtwork(patched),patched);
  assert.throws(()=>patchSecondaryArtwork(source.replace('notchQuillPenAiLine','changedIcon')),/Recap artwork anchor changed/);
});

test('all secondary illustrations use the canonical notch symbol and patching is repeatable',()=>{
  const names=['emptyIllustrationRaw','renderErrorIllustrationRaw','liveVoiceEmptyIllustration','emptyTimelineIllustration','failedMarkRaw','applePromptTitleRaw','workspaceFilesEmptyIllustrationRaw'];
  const source=names.map(name=>`const ${name}=\`<svg>old vendor illustration</svg>\`;`).join('\n');
  const patched=patchSecondaryArtwork(source);parse(patched,{ecmaVersion:'latest'});
  assert.doesNotMatch(patched,/old vendor illustration/);assert.equal((patched.match(/aria-label=\\"notch/g)||[]).length,7);
  assert.equal(patchSecondaryArtwork(patched),patched);
  assert.equal(patchWorkbenchRenderer('/* notch workbench skin */\n'+source),'/* notch workbench skin */\n'+patched);
  assert.throws(()=>patchSecondaryArtwork('const emptyIllustrationRaw=unknownMarkup;'),/declaration changed/);
  const controls='function GeneralSettings(){return jsx.jsxs(Section,{children:[jsx.jsx(SettingsItem,{title:t("settings.homeGame"),control:game}),jsx.jsx(SettingsItem,{title:t("settings.notifications"),control:notification})]});} function DesktopPetSurface(){return oldPet();} const picker={children:applicationIconOptions.map(draw)};';
  const cleaned=patchSecondaryArtwork(controls);parse(cleaned,{ecmaVersion:'latest'});
  assert.doesNotMatch(cleaned,/settings.homeGame|oldPet/);assert.match(cleaned,/settings.notifications/);assert.match(cleaned,/filter\(style=>style==='notch'\)/);
  const profile=patchSecondaryArtwork('function ProfileStickerCanvas(){return oldStickers();} function ProfileStickerExperience({children}){subscribeToStickers();return children;}');
  assert.doesNotMatch(profile,/oldStickers|subscribeToStickers/);
  const render=new Function(`${profile};return ProfileStickerExperience;`)();
  assert.equal(render({children:'profile'}),'profile');
});

test('extension route uses the existing local manager without initializing the account marketplace', () => {
  const source = '/* notch workbench skin */\nfunction ExtensionsView(){startAccountMarketplace();}';
  const patched = patchWorkbenchRenderer(source);
  assert.doesNotMatch(patched, /startAccountMarketplace/);
  assert.match(patched, /InstalledExtensionsSettings,\{initialKind\}/);
  assert.equal(patchWorkbenchRenderer(patched), patched);
});
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
${['AgentGreetingMark','AppleTreeDoodle','ImageDoodle','PartnerPlanGreetingMark','MobileAppDownloadPromo','NewChatCursorGrid','FeedbackFloatingButton','FeedbackDialog','WorkbenchModeThemeSync','WorkbenchSidebarModeSwitch','WorkspaceTabsEmptyState','normalizeThemeMode','readInitialThemeMode','readColorMode','AppearanceSettings','ProfileMenu','ProfileSettingsForm','isChatComposerVoiceHoldPlaceholderPhaseAvailable','notchLogoLoader','notchLogo'].map(name => `function ${name}(){oldAppearance();}`).join('\n')}
function ThemeProvider(){reactExports.useEffect(()=>{document.documentElement.setAttribute("data-theme",d1)},[d1]);const m1=reactExports.useMemo(()=>({}),[]);return m1;}
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

test('upgrading an already skinned renderer installs the clone handoff and its import', () => {
  const fresh = patchWorkbenchRenderer(fixture);
  const old = patchFunction(fresh.replace(',openClonedProject', ''), 'AppearanceSettings', 'function AppearanceSettings(){const preferences=useWorkbenchPreferences(),{i18n}=useTranslation();return reactExports.createElement(NotchAppearance,{preferences,language:resolveInterfaceLanguage(i18n.resolvedLanguage??i18n.language),setLanguage:setInterfaceLanguage});}');
  const updated = patchWorkbenchRenderer(old+'\nworkbenchClient.openExternalUrl("https://freesyntax.dev");');
  assert.match(updated, /onOpenProject=path=>openClonedProject/);
  assert.match(updated, /import \{[^}]*openClonedProject[^}]*\} from "\.\/workbench-skin.mjs"/);
  assert.doesNotMatch(updated,/https:\/\/freesyntax\.dev/);
  assert.equal(patchWorkbenchRenderer(updated), updated);
});

test('feedback entry point and dialog render nothing without registering listeners or submitting', () => {
  const source = patchWorkbenchRenderer(fixture);
  const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .filter(node => node.type === 'FunctionDeclaration' && ['FeedbackFloatingButton', 'FeedbackDialog'].includes(node.id.name));
  assert.equal(functions.length, 2);
  for (const node of functions) {
    const render = new Function(`${source.slice(node.start, node.end)};return ${node.id.name};`)();
    assert.equal(render({ open: true }), null);
  }
});
