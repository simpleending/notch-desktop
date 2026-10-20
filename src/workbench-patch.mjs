import { readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { patchFunction } from './bundle-patch.mjs';
import { readFileSync } from 'node:fs';
import { parse, tokenizer } from 'acorn';
import { patchLocalOnlyRenderer } from './local-only-patch.mjs';
import { patchEnglishRenderer } from './english-renderer-patch.mjs';
import { patchWorkingStatus } from './working-status-patch.mjs';

const symbolMarkup = readFileSync(new URL('../assets/notch-symbol.svg',import.meta.url),'utf8').replace('<svg ','<svg width="48" height="48" style="max-width:48px;max-height:48px;margin:auto" ');
const brandCardUrl = 'data:image/svg+xml;base64,' + readFileSync(new URL('../assets/notch-brand-card.svg',import.meta.url)).toString('base64');
const symbolUrl = 'data:image/svg+xml;base64,' + Buffer.from(symbolMarkup).toString('base64');
export const legacyBrandAsset = /^(?:duck|Qoduck|userCard|voice_|activeDays\d+Sticker|(?:automationFirstCreate|desktopPetFirstUse|forkFirstUse|goalFirstUse|mobileMessageFirstReceive|snakeFirstPlay|voiceFirstUse)Sticker|notch(?:Anniversary|Pioneer|-(?:loading-line|metal|mobile-download-visual))|profileStickerSparseState|quickNote(?:AddButton|EmptyState|OnboardingFirstNote|TitleQuick)|onboardingWallpaper|parchmentDoodle|(?:bird|crocodile|dog|gorilla)-|planAgentAvatar|agent(?:-team)?-creation-figure|Login_poster|update-notification-card|feedbackWatermark|(?:failed|idle|jumping|look|review|running|waiting|waving|glass)(?:-|_))/;
export function patchSecondaryArtwork(source) {
  source = patchWorkingStatus(source);
  source = source.replace('backgroundImage:`url(${keyboardBackgroundSrc})`', 'backgroundImage:"linear-gradient(135deg,var(--notch-panel),var(--notch-accent-fill))"')
    .replaceAll('No task data yet :)', 'No tasks yet.')
    .replaceAll('No tasks yet :)', 'No tasks yet.')
    .replaceAll('No artifact data yet :)', 'No artifacts yet.')
    .replaceAll('No web reading data yet :)', 'No web activity yet.')
    .replaceAll('No Skills & MCP data yet :)', 'No skills or MCP activity yet.')
    .replaceAll('No source data yet :)', 'No sources yet.')
    .replaceAll('No memory data yet :)', 'No memories yet.')
    .replaceAll('The notch you know and use :)', 'The notch you know and use.')
    .replaceAll('暂无产出数据 :)', 'No artifacts yet.')
    .replaceAll('暂无网页查阅数据 :)', 'No web activity yet.')
    .replaceAll('暂无技能与 MCP 数据 :)', 'No skills or MCP activity yet.')
    .replaceAll('暂无来源数据 :)', 'No sources yet.')
    .replaceAll('暂无记忆数据 :)', 'No memories yet.')
    .replaceAll('暂无任务数据 :)', 'No tasks yet.')
    .replaceAll('暂无任务 :)', 'No tasks yet.')
    .replaceAll('就是你一直在用的 notch :)', 'The notch you know and use.')
    .replace('Choose whether new input from the main composer or desktop pet waits in the queue or steers the active turn.', 'Choose whether new input waits in the queue or steers the active turn.')
    .replace('Generate a short task recap. Sessions using your own API key or an external model provider keep their session model. Otherwise, use the selected model or automatically choose the cheapest platform model. Charges depend on the model used.', 'Generate a short task recap with the task’s model. Local models run on your device; cloud usage follows your provider’s pricing.');
  if (source.includes('function AboutDialog(')) source = patchFunction(source, 'AboutDialog', 'function AboutDialog({open,application,onOpenChange}){return jsxRuntimeExports.jsx(ContentDialog,{open,onClose:()=>onOpenChange(!1),title:"About notch",description:"Local models first. Your workspace, your choice.",closeLabel:"Close",maxWidth:440,children:jsxRuntimeExports.jsxs("div",{className:"flex flex-col items-start gap-5 py-4",children:[jsxRuntimeExports.jsx(notchNotesWordmark,{width:148}),jsxRuntimeExports.jsx("p",{children:"Version "+(application?.version??"—")}),jsxRuntimeExports.jsx("p",{className:"text-text-secondary",children:"by freesyntax.dev"})]})});}');
  if (source.includes('function QuickNoteThemeSync(')) source = patchFunction(source, 'QuickNoteThemeSync', body => {
    if (body.includes('root.dataset.notchNotes')) return body;
    body = replaceOnce(body, '{setWindowThemeMode:t1}', '{setWindowThemeMode:t1,resolvedTheme:notchNotesTheme}');
    return replaceOnce(body, 'return reactExports.useEffect(', 'reactExports.useEffect(()=>{const root=document.documentElement;root.dataset.notchNotes="true";root.dataset.notchAppearance=notchNotesTheme.endsWith("-dark")?"dark":"light"},[notchNotesTheme]);return reactExports.useEffect(');
  });
  for (const name of ['appleTreeIllustration', 'appleTreeIllustrationColor', 'appleTreeStampGray', 'beeDoodle', 'mintDoodle', 'exploreAgentAvatarUrl']) {
    const match = new RegExp(`\\b${name}=`).exec(source);
    if (!match) continue;
    const start = match.index + match[0].length, node = tokenizer(source.slice(start), { ecmaVersion: 'latest' }).getToken();
    if (node.type.label !== 'string' || !node.value.startsWith('data:image/')) throw new Error(`Inline brand artwork anchor changed: ${name}`);
    source = source.slice(0, start) + JSON.stringify(name === 'exploreAgentAvatarUrl' ? symbolUrl : brandCardUrl) + source.slice(start + node.end);
  }
  if (source.includes('function QuickNoteWindowSurface(')) {
    if (!source.includes('from "./notes-branding.mjs"')) source = 'import {welcomeNote as notchWelcomeNote,refreshBuiltinWelcomeNotes as notchRefreshBuiltinNotes} from "./notes-branding.mjs";\n' + source;
    source = patchFunction(source, 'createQuickNoteOnboardingPresentation', 'function createQuickNoteOnboardingPresentation(){return structuredClone(notchWelcomeNote);}');
    source = patchFunction(source, 'createQuickNoteOnboardingInput', 'function createQuickNoteOnboardingInput(note){return {...note,attachments:[]};}');
    source = patchFunction(source, 'QuickNoteWindowSurface', body => {
      const load = 'let Y1=await listQuickNotes();try{Y1=await notchRefreshBuiltinNotes(Y1,updateQuickNote)}catch{toast.error("The welcome note could not be refreshed. Your notes are still available.")}';
      body = body.replace('let Y1=await notchRefreshBuiltinNotes(await listQuickNotes(),updateQuickNote);', load);
      return body.includes('notchRefreshBuiltinNotes(') ? body : replaceOnce(body, 'let Y1=await listQuickNotes();', load);
    });
  }
  source = source.replace('Symbol:NotchSymbol}=createNotchWorkbench', 'Symbol:NotchSymbol,Wordmark:notchNotesWordmark}=createNotchWorkbench');
  source = source.replace(/Symbol:([Nn]otchSymbol),(?!Dot:)/, 'Symbol:$1,Dot:notchDot,');
  source = source.replace(/Wordmark:notchNotesWordmark(?=}=createNotchWorkbench)/i,'Wordmark:notchNotesWordmark,VoiceModels:notchVoiceModels')
    .replace(/createNotchWorkbench\(reactExports,useTheme\)/gi,match=>match.slice(0,-1)+',{ContentDialog})');
  if (source.includes('function QuickNoteEmptyState(')) source = patchFunction(source, 'QuickNoteEmptyState', 'function QuickNoteEmptyState(){return jsxRuntimeExports.jsxs("div",{"data-quick-note-empty-state":!0,className:"notch-notes-empty",role:"status",children:[jsxRuntimeExports.jsx(notchNotesWordmark,{width:112}),jsxRuntimeExports.jsx("p",{children:"No notes yet. Save an idea or add a note to a task."})]});}');
  if (source.includes('function QuickNoteWindowHeader(')) source = patchFunction(source, 'QuickNoteWindowHeader', body => {
    if (body.includes('className:"notch-notes-title"')) return body;
    const tree = parse(body, { ecmaVersion: 'latest' }); let heading;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.arguments?.[0]?.value === 'h1') { heading = node; return; }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
    visit(tree);
    const children = heading?.arguments[1]?.properties.find(prop => prop.key.name === 'children')?.value;
    if (!children) throw new Error('Notes header artwork anchor changed.');
    return body.slice(0, children.start) + '[jsxRuntimeExports.jsx(notchNotesWordmark,{width:86}),jsxRuntimeExports.jsx("span",{className:"notch-notes-title",children:"Notes"})]' + body.slice(children.end);
  });
  source = source.replace('quickNotes:{open:"Open Quick Note",close:"Close Quick Note",title:"Quick Notes",description:"Saved snippets from Agent replies."', 'quickNotes:{open:"Open notes",close:"Close notes",title:"Notes",description:"Notes saved on this device."').replaceAll('addPlaceholder:"What’s on your mind…"', 'addPlaceholder:"Write a note…"');
  for (const name of ['SidebarSessionStateIndicator', 'SessionMiniIndicator', 'TaskMonitorRunningIndicator']) {
    if (!source.includes(`function ${name}(`)) continue;
    source = patchFunction(source, name, body => body
      .replace('jsxRuntimeExports.jsx(ThinkingDotMatrixIcon,{className:"text-current",sizeClassName:"size-4"})', 'jsxRuntimeExports.jsx("span",{className:"notch-task-dot","aria-hidden":!0})')
      .replaceAll('bg-primary', 'notch-task-dot').replaceAll('bg-info', 'notch-task-dot'));
  }
  if (source.includes('function LiveVoiceOverlaySurface(')) source = patchVoiceOverlayArtwork(source);
  if (source.includes('function TaskMonitorConversationRecapCard(')) source = patchFunction(source, 'TaskMonitorConversationRecapCard', body => {
    if(body.includes('className:"notch-recap-mark"'))return body.replace(/[Nn]otchSymbol,\{size:24,className:"notch-recap-mark"/, 'notchNotesWordmark,{width:62,className:"notch-recap-mark"');
    const spans=[];
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&node.arguments?.[0]?.value==='span'&&body.slice(node.start,node.end).includes('notchQuillPenAiLine')){spans.push(node);return;}
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);
    }
    visit(parse(body,{ecmaVersion:'latest'}));
    if(spans.length!==1)throw new Error('Recap artwork anchor changed.');
    const span=spans[0];
    return body.slice(0,span.start)+'jsxRuntimeExports.jsx(notchNotesWordmark,{width:62,className:"notch-recap-mark","aria-hidden":!0})'+body.slice(span.end);
  });
  if (source.includes('function QuickNoteCreateButton(')) source = patchFunction(source, 'QuickNoteCreateButton', body => {
    body = body.replace(/jsxRuntimeExports\.jsx\([Nn]otchSymbol,/g, 'jsxRuntimeExports.jsx(notchDot,');
    if (!body.includes('"data-quick-note-create-raster"')) return body;
    body = replaceOnce(body, 'jsxRuntimeExports.jsx("img",{"data-quick-note-create-raster":!0,src:t1,alt:"",className:`pointer-events-none absolute left-1/2 top-1/2 size-14 max-w-none -translate-x-1/2 -translate-y-1/2 object-cover ${n1?"brightness-[1.08] saturate-[0.92]":""}`})', 'null');
    return body.replace('className:"relative size-10 overflow-hidden"', 'className:"relative size-10 overflow-hidden notch-quick-note-create"').replace('className:"text-white"', 'className:"notch-quick-note-mark"');
  });
  for (const icon of ['notchQuillPenAiLine', 'notchQuillPenLine', 'FeatherIcon', 'CustomInputWritingPen']) {
    source = source.replaceAll(`jsxRuntimeExports.jsx(${icon},`, 'jsxRuntimeExports.jsx(notchDot,');
  }
  source = source.replace(/jsxRuntimeExports\.jsx\([Nn]otchSymbol,\{className:"size-3\.5",/g, 'jsxRuntimeExports.jsx(notchDot,{className:"size-3.5",');
  source=source.replaceAll('https://github.com/simpleending/notch-desktop/commits/main/','https://github.com/simpleending/notch-desktop/releases');
  for(const name of ['emptyIllustrationRaw','renderErrorIllustrationRaw','liveVoiceEmptyIllustration','emptyTimelineIllustration','failedMarkRaw','applePromptTitleRaw','workspaceFilesEmptyIllustrationRaw']) {
    const expression=new RegExp(`\\b${name}=\x60([\\s\\S]*?)\x60`,'g');
    const matches=[...source.matchAll(expression)];
    if(!matches.length) {
      if(source.includes(`${name}=`) && !source.includes(`${name}=${JSON.stringify(symbolMarkup)}`)) {
        const previous=readFileSync(new URL('../assets/notch-symbol.svg',import.meta.url),'utf8');
        if(source.includes(`${name}=${JSON.stringify(previous)}`)){source=source.replace(`${name}=${JSON.stringify(previous)}`,`${name}=${JSON.stringify(symbolMarkup)}`);continue;}
        throw new Error(`Artwork declaration changed: ${name}`);
      }
      continue;
    }
    if(matches.length!==1 || matches[0][1].includes('${'))throw new Error(`Artwork declaration is ambiguous: ${name}`);
    source=source.replace(expression,()=>`${name}=${JSON.stringify(symbolMarkup)}`);
  }
  source=source.replace('children:applicationIconOptions.map(',"children:applicationIconOptions.filter(style=>style==='notch').map(");
  if(source.includes('function DesktopPetSurface('))source=patchFunction(source,'DesktopPetSurface','function DesktopPetSurface(){return null;}');
  if(source.includes('function ProfileStickerCanvas('))source=patchFunction(source,'ProfileStickerCanvas','function ProfileStickerCanvas(){return null;}');
  if(source.includes('function ProfileStickerExperience('))source=patchFunction(source,'ProfileStickerExperience','function ProfileStickerExperience({children}){return children;}');
  if(source.includes('function GeneralSettings('))source=patchFunction(source,'GeneralSettings',body=>{
    const spans=[];
    function visit(node){
      if(!node || typeof node!=='object')return;
      if(node.type==='CallExpression' && node.arguments?.[0]?.name==='SettingsItem' && node.arguments[1]?.properties?.some(prop=>prop.key.name==='title' && prop.value.arguments?.[0]?.value==='settings.homeGame'))spans.push(node);
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);
    }
    visit(parse(body,{ecmaVersion:'latest'}));
    for(const span of spans.sort((a,b)=>b.start-a.start))body=body.slice(0,span.start)+'null'+body.slice(span.end);
    return body;
  });
  return source;
}

export function patchVoiceOverlayArtwork(source) {
  return patchFunction(source, 'LiveVoiceOverlaySurface', body => {
    const previousBrand='jsxRuntimeExports.jsxs("span",{className:"notch-voice-brand",style:{display:"flex",alignItems:"center",gap:6,fontSize:20,fontWeight:600,letterSpacing:"-.6px"},children:[jsxRuntimeExports.jsx(NotchSymbol,{size:22}),"notch"]})';
    const brand='jsxRuntimeExports.jsx("span",{className:"notch-voice-brand","aria-label":"notch",children:jsxRuntimeExports.jsx(NotchSymbol,{size:36})})';
    body=body.replace(previousBrand,brand).replace('width:132,height:56,display:"flex",flexDirection:"column"','width:72,height:64,display:"flex",flexDirection:"column"');
    if (body.includes('id:"notch-voice-colors"')) return body;
    if (!body.includes('className:"notch-voice-brand"')) {
    body = replaceOnce(body, '[s1,o1]=reactExports.useState(0),', '');
    const start = body.indexOf('const x1=t1?resolveQoduckFrameSetName(t1):"normal",');
    const stop = body.indexOf('reactExports.useEffect(()=>{const j1=c1.current;', start);
    if (start < 0 || stop <= start) throw new Error('Voice sprite animation differs from the inspected baseline.');
    body = body.slice(0, start) + body.slice(stop);
    body = replaceOnce(body, 'jsxRuntimeExports.jsx("span",{id:"orb-halo"})', 'null');
    const images = 'jsxRuntimeExports.jsx("img",{id:"qoduck-voice-frame",src:w1,alt:"",width:104,height:104,draggable:!1}),jsxRuntimeExports.jsx("img",{id:"qoduck-voice-glass-light",className:"qoduck-voice-glass",src:qoduckVoiceGlassLightSrc,alt:"",width:120,height:120,draggable:!1}),jsxRuntimeExports.jsx("img",{id:"qoduck-voice-glass-dark",className:"qoduck-voice-glass",src:qoduckVoiceGlassDarkSrc,alt:"",width:120,height:120,draggable:!1})';
    body = replaceOnce(body, images, brand+',jsxRuntimeExports.jsx("span",{style:{fontSize:11,lineHeight:1.3,opacity:.75},children:M1})');
    body = replaceOnce(body, 'id:"orb-core",children:', 'id:"orb-core",style:{top:"40%",width:72,height:64,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,border:"1px solid var(--qcac38d)",borderRadius:12,background:"var(--q715358)",color:"var(--qec21c5)"},children:');
    }
    body = replaceOnce(body, 'border:"1px solid var(--qcac38d)"', 'border:"1px solid var(--notch-voice-border)"');
    body = replaceOnce(body, 'background:"var(--q715358)",color:"var(--qec21c5)"', 'background:"var(--notch-voice-background)",color:"var(--notch-voice-text)"');
    const colors = '#orb-root{--notch-voice-background:#f7f6f8;--notch-voice-text:#242128;--notch-voice-border:#d3cfd5}html[data-theme$="-dark"] #orb-root,html[data-theme="dark"] #orb-root{--notch-voice-background:#242228;--notch-voice-text:#f4f1f5;--notch-voice-border:#504b55}';
    return replaceOnce(body, 'children:[jsxRuntimeExports.jsx(FloatingCaptionBubble,', 'children:[jsxRuntimeExports.jsx("style",{id:"notch-voice-colors",children:'+JSON.stringify(colors)+'}),jsxRuntimeExports.jsx(FloatingCaptionBubble,');
  });
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Workbench skin anchor changed: ${before.slice(0, 70)}`);
  return source.replace(before, after);
}
export function patchThemeBroadcast(source) {
  if(!source.includes('function ThemeProvider('))return source;
  return patchFunction(source,'ThemeProvider',body=>{
    if(body.includes('"notch-appearance"'))return body;
    const effect='reactExports.useEffect(()=>{const channel=new BroadcastChannel("notch-appearance"),secondary=new URLSearchParams(window.location.search).has("surface");channel.onmessage=({data})=>{if(data==="get-theme"){if(!secondary)channel.postMessage(normalizeThemeMode(n1))}else if(secondary&&["light","dark","auto"].includes(data)){r1(data);s1(readColorMode(data))}};channel.postMessage(secondary?"get-theme":normalizeThemeMode(n1));return()=>channel.close()},[n1]);';
    return replaceOnce(body,'const m1=reactExports.useMemo(',effect+'const m1=reactExports.useMemo(');
  });
}
const gitHubAppearance = 'function AppearanceSettings(){const preferences=useWorkbenchPreferences(),{i18n}=useTranslation(),{localWorkspaceService}=useServices(),navigation=useNavigation();const onOpenProject=path=>openClonedProject(path,localWorkspaceService,navigation);return reactExports.createElement(NotchAppearance,{preferences,language:resolveInterfaceLanguage(i18n.resolvedLanguage??i18n.language),setLanguage:setInterfaceLanguage,onOpenProject});}';

export function patchWorkbenchRenderer(source) {
  source = source.replaceAll('workbenchClient.openExternalUrl("https://freesyntax.dev")', 'workbenchClient.openExternalUrl("https://github.com/simpleending/notch-desktop")');
  source = patchLocalOnlyRenderer(source);
  source = patchThemeBroadcast(source);
  // Keep extension management on its existing local installer, away from the retired account marketplace.
  if (source.includes('function ExtensionsView(')) source = patchFunction(source, 'ExtensionsView', 'function ExtensionsView({initialKind="plugin"}){return jsxRuntimeExports.jsx(InstalledExtensionsSettings,{initialKind});}');
  if (source.includes('/* notch workbench skin */')) {
    if (source.includes('function AppearanceSettings(')) {
      source = patchFunction(source, 'AppearanceSettings', gitHubAppearance);
      source = source.replace(/import\s*\{([^}]+)\}\s*from\s*(['"])\.\/workbench-skin\.mjs\2/, (match, names) => names.split(',').some(name => name.trim() === 'openClonedProject') ? match : match.replace('{', '{openClonedProject,'));
    }
    return patchEnglishRenderer(patchSecondaryArtwork(source));
  }
  source = patchFunction(source, 'preloadDoodleAssets', 'function preloadDoodleAssets(){}');
  for (const name of ['AgentGreetingMark', 'AppleTreeDoodle', 'ImageDoodle', 'PartnerPlanGreetingMark', 'MobileAppDownloadPromo', 'NewChatCursorGrid', 'FeedbackFloatingButton', 'FeedbackDialog']) {
    source = patchFunction(source, name, `function ${name}(){return null;}`);
  }
  source = patchFunction(source, 'WorkbenchModeThemeSync', 'function WorkbenchModeThemeSync(){return null;}');
  source = patchFunction(source, 'WorkbenchSidebarModeSwitch', 'function WorkbenchSidebarModeSwitch(props){return reactExports.createElement(NotchModeSwitch,props);}');
  source = patchFunction(source, 'WorkspaceTabsEmptyState', 'function WorkspaceTabsEmptyState(props){return reactExports.createElement(NotchPanelLauncher,props);}');
  source = patchFunction(source, 'ChatComposerModelMenu', 'function ChatComposerModelMenu(props){return reactExports.createElement(NotchModelMenu,props);}');
  source = patchFunction(source, 'isChatComposerVoiceHoldPlaceholderPhaseAvailable', 'function isChatComposerVoiceHoldPlaceholderPhaseAvailable(){return false;}');
  source = patchFunction(source, 'normalizeThemeMode', 'function normalizeThemeMode(value){return value==="auto"?"auto":value==="dark"||value?.endsWith("-dark")?"dark":"light";}');
  source = patchFunction(source, 'readInitialThemeMode', 'function readInitialThemeMode(){return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY)||window.localStorage.getItem("notch.setup.theme")||"dark");}');
  source = patchFunction(source, 'readColorMode', 'function readColorMode(mode){return mode==="auto"?"auto":mode==="dark"?"dark":"light";}');
  source = patchFunction(source, 'ThemeProvider', section => replaceOnce(section,
    'document.documentElement.setAttribute("data-theme",d1)',
    'document.documentElement.setAttribute("data-theme",d1);if(!new URLSearchParams(window.location.search).has("surface")){document.documentElement.dataset.notchWorkbench="true";document.documentElement.dataset.notchAppearance=d1.endsWith("-dark")?"dark":"light";document.documentElement.style.colorScheme=d1.endsWith("-dark")?"dark":"light"}'));
  source = patchFunction(source, 'NewChatHomeContent', section => {
    const start = section.indexOf('jsxRuntimeExports.jsx(PartnerPlanGreetingMark,'), stop = section.indexOf('jsxRuntimeExports.jsx("div",{className:"mt-7 w-full max-w-[924px]"');
    if (start < 0 || stop <= start) throw new Error('Workbench welcome layout changed.');
    section = section.slice(0, start) + 'jsxRuntimeExports.jsx(NotchWelcome,{workspace:S1?.label,executor:L1?jsxRuntimeExports.jsx(NewChatExecutorPromptPicker,{...L1}):null}),' + section.slice(stop);
    section = replaceOnce(section, 'NewChatWelcomeDashboard,{attentionEnabled:t1,attentionCount:n1,activity:r1,loadCreditsHeatmap:i1,onActivityPlaygroundEvent:s1,gameEntryDismissRequestId:h2}', 'NotchQuickStart,{onCreateWorkspace:B1}');
    section = replaceOnce(section, 'placeholder:i2("newChat.placeholder")', 'placeholder:"Describe what you want to build or change…"');
    return replaceOnce(section, '"data-new-chat-b1-content":!0', '"data-new-chat-b1-content":!0,"data-notch-home":!0');
  });
  source = patchFunction(source, 'AppearanceSettings', gitHubAppearance);
  source = patchFunction(source, 'SettingsView', section => {
    section = replaceOnce(section, 'const H2=M2.flatMap(D3=>D3.items)', 'const H2=M2.flatMap(D3=>D3.items).filter(item=>!["pet","mobile","playground"].includes(item.id))');
    return replaceOnce(section, 'N2=p1?void 0:w2===', 'N2=p1?void 0:["pet","mobile","playground"].includes(w2)?"appearance":w2===');
  });
  source = patchFunction(source, 'ProfileSettingsForm', 'function ProfileSettingsForm({user}){return reactExports.createElement(NotchLocalProfile,{name:user?.nickname||user?.name||"Local workspace"});}');
  source = patchFunction(source, 'ProfileMenu', `function ProfileMenu({username,avatarUrl}){
    const nav=useNavigation(),{workbenchClient}=useServices(),{resolvedTheme,setThemeMode}=useTheme();
    const item=(label,onSelect)=>jsxRuntimeExports.jsx(DropdownMenuItem,{className:"notch-user-menu-item",onSelect,children:label},label);
    return jsxRuntimeExports.jsxs(DropdownMenu,{children:[
      jsxRuntimeExports.jsx(DropdownMenuTrigger,{asChild:true,children:jsxRuntimeExports.jsx(AccountMenuTrigger,{username,avatarImage:avatarUrl,"aria-label":"Open user menu",className:"notch-account-trigger"})}),
      jsxRuntimeExports.jsxs(DropdownMenuContent,{align:"end",side:"top",className:"notch-user-menu",children:[
        jsxRuntimeExports.jsx("div",{className:"notch-user-menu-label",children:"notch / WORKSPACE"}),
        item("Settings",()=>nav.push({kind:"settings",section:"appearance",query:""})),
        item("Local workspace",()=>nav.push({kind:"settings",section:"profile",query:""})),
        item(resolvedTheme.endsWith("-dark")?"Light appearance":"Dark appearance",()=>setThemeMode(resolvedTheme.endsWith("-dark")?"light":"dark")),
        jsxRuntimeExports.jsx(DropdownMenuSeparator,{}),
        item("Release notes",()=>workbenchClient.openExternalUrl("https://github.com/simpleending/notch-desktop/releases")),
        item("About notch",()=>workbenchClient.openExternalUrl("https://github.com/simpleending/notch-desktop"))
      ]})
    ]});
  }`);
  source = replaceOnce(source, '"data-layout-window-titlebar":!0,className:', '"data-layout-window-titlebar":!0,"data-notch-titlebar":!0,className:');
  source = replaceOnce(source, 'style:{WebkitAppRegion:"no-drag"},children:K2}', 'style:{WebkitAppRegion:"no-drag"},children:jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment,{children:[jsxRuntimeExports.jsx(NotchWindowBrand,{}),K2]})}');
  source = replaceOnce(source, 'style:{WebkitAppRegion:"drag"}})]}):jsxRuntimeExports.jsx("div",{className:"absolute left-4', 'style:{WebkitAppRegion:"drag"}}),jsxRuntimeExports.jsx(NotchThemeControls,{})]}):jsxRuntimeExports.jsx("div",{className:"absolute left-4');
  const logo = source.includes('function notchLogoLoader(') ? 'notchLogoLoader' : 'QoderLogoLoader';
  source = patchFunction(source, logo, `function ${logo}(){return reactExports.createElement(NotchSymbol);}`);
  const providerLogo = source.includes('function notchLogo(') ? 'notchLogo' : 'QoderLogo';
  source = patchFunction(source, providerLogo, `function ${providerLogo}(props){return reactExports.createElement(NotchSymbol,props);}`);
  source = replaceOnce(source, 'dangerouslySetInnerHTML:{__html:workspaceFilesEmptyIllustrationRaw}', 'children:jsxRuntimeExports.jsx(NotchSymbol,{size:56})');
  source = replaceOnce(source, 'const NotchSetup=createNotchSetup(reactExports);', 'const {Brand:NotchWindowBrand,ThemeControls:NotchThemeControls,ModeSwitch:NotchModeSwitch,Welcome:NotchWelcome,QuickStart:NotchQuickStart,PanelLauncher:NotchPanelLauncher,Appearance:NotchAppearance,LocalProfile:NotchLocalProfile,Symbol:NotchSymbol}=createNotchWorkbench(reactExports,useTheme);const NotchSetup=createNotchSetup(reactExports);');
  // Initialize after the bundle's house components, before React renders.
  source = source.replace('const NotchSetup=createNotchSetup(reactExports);','const NotchModelMenu=createModelMenu(reactExports,{Popover,PopoverTrigger,PopoverContent},useTheme);const NotchSetup=createNotchSetup(reactExports);');
  return patchEnglishRenderer(patchSecondaryArtwork('/* notch workbench skin */\nimport {createModelMenu} from "./model-menu.mjs";\nimport {createNotchWorkbench,openClonedProject} from "./workbench-skin.mjs";\n' + source));
}

export async function verifyWorkbenchImports(assets, checkExports = true) {
  const visited = new Set();
  const modules = new Map();
  async function body(file) {
    if (!modules.has(file)) modules.set(file, parse(await readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }).body);
    return modules.get(file);
  }
  async function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    for (const node of await body(file)) {
      if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), node.source.value);
      await visit(target);
      if (checkExports && target.endsWith('.mjs')) {
        const exports = new Set((await body(target)).flatMap(statement => statement.type === 'ExportNamedDeclaration'
          ? [...(statement.specifiers ?? []).map(item => item.exported.name), ...(statement.declaration?.declarations?.map(item => item.id.name) ?? []), statement.declaration?.id?.name].filter(Boolean) : []));
        for (const item of node.specifiers) if (item.type === 'ImportSpecifier' && !exports.has(item.imported.name)) throw new Error(`Renderer export missing: ${item.imported.name} in ${path.basename(target)}`);
      }
    }
  }
  await visit(path.join(assets, 'workbench-skin.mjs')); await visit(path.join(assets, 'model-menu.mjs'));
  for (const name of await readdir(assets)) if (/^index-.*\.js$/.test(name)) await visit(path.join(assets, name));
}

export async function installWorkbenchAssets(application, root) {
  const renderer = path.join(application, 'out/renderer'), assets = path.join(renderer, 'assets');
  for (const name of ['workbench-skin.mjs', 'workbench-skin.css', 'model-menu.mjs', 'model-policy.mjs', 'colibri-panel.mjs', 'web-settings-view.mjs', 'phone-settings-view.mjs', 'update-settings-view.mjs', 'github-settings-view.mjs', 'notes-branding.mjs', 'voice-model-picker.mjs']) await cp(path.join(root, 'src', name), path.join(assets, name));
  await verifyWorkbenchImports(assets, false);
  await cp(path.join(root,'assets/providers'),path.join(assets,'providers'),{recursive:true});
  await cp(path.join(root, 'assets/fonts'), path.join(assets, 'fonts'), { recursive: true });
  await cp(path.join(root, 'assets/notices'), path.join(assets, 'notices'), { recursive: true });
  await cp(path.join(root, 'assets/notch-symbol.png'), path.join(assets, 'notch-symbol.png'));
  const symbol = await readFile(path.join(root, 'assets/notch-symbol.svg'));
  for (const name of await readdir(assets)) if (/^notch(?:CnIdeLogo|DoorLogo|IdeLogo|Logo|workCnLogo|workLogo|worklogo)-[\w-]+\.svg$/.test(name)) await writeFile(path.join(assets, name), symbol);
  const cards = {}, symbols = {};
  for (const extension of ['svg', 'png', 'webp']) { cards[extension] = await readFile(path.join(root, `assets/notch-brand-card.${extension}`)); symbols[extension] = await readFile(path.join(root, `assets/notch-symbol.${extension}`)); }
  for (const name of await readdir(assets)) {
    const extension = path.extname(name).slice(1);
    if (legacyBrandAsset.test(name) && cards[extension]) await writeFile(path.join(assets, name), /^(?:duck|Qoduck|(?:bird|crocodile|dog|gorilla)-|planAgentAvatar|userCard(?:Duck|SilverDuck))/.test(name) ? symbols[extension] : cards[extension]);
  }
  const htmlFile = path.join(renderer, 'index.html'), html = await readFile(htmlFile, 'utf8');
  if (!html.includes('href="./assets/workbench-skin.css"')) await writeFile(htmlFile, html.replace('</head>', '<link rel="stylesheet" href="./assets/workbench-skin.css">\n</head>'));
  const icon = await readFile(path.join(root, 'assets/notch-symbol.png'));
  const icons = path.join(application, '../resources/application-icons');
  for (const name of await readdir(icons)) if (/^(?:notch|qoder|qoduck)-(?:light|dark)(?:-windows)?\.png$/.test(name)) await writeFile(path.join(icons, name), icon);
  const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(icon.length, 14); header.writeUInt32LE(22, 18);
  await writeFile(path.join(application, '../resources/app-icon.ico'), Buffer.concat([header, icon]));
}
