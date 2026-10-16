import { readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { patchFunction } from './bundle-patch.mjs';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { patchLocalOnlyRenderer } from './local-only-patch.mjs';
import { patchEnglishRenderer } from './english-renderer-patch.mjs';

const symbolMarkup = readFileSync(new URL('../assets/notch-symbol.svg',import.meta.url),'utf8').replace('<svg ','<svg width="48" height="48" style="max-width:48px;max-height:48px;margin:auto" ');
export function patchSecondaryArtwork(source) {
  if (source.includes('function LiveVoiceOverlaySurface(')) source = patchVoiceOverlayArtwork(source);
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
    if (body.includes('id:"notch-voice-colors"')) return body;
    if (!body.includes('className:"notch-voice-brand"')) {
    body = replaceOnce(body, '[s1,o1]=reactExports.useState(0),', '');
    const start = body.indexOf('const x1=t1?resolveQoduckFrameSetName(t1):"normal",');
    const stop = body.indexOf('reactExports.useEffect(()=>{const j1=c1.current;', start);
    if (start < 0 || stop <= start) throw new Error('Voice sprite animation differs from the inspected baseline.');
    body = body.slice(0, start) + body.slice(stop);
    body = replaceOnce(body, 'jsxRuntimeExports.jsx("span",{id:"orb-halo"})', 'null');
    const images = 'jsxRuntimeExports.jsx("img",{id:"qoduck-voice-frame",src:w1,alt:"",width:104,height:104,draggable:!1}),jsxRuntimeExports.jsx("img",{id:"qoduck-voice-glass-light",className:"qoduck-voice-glass",src:qoduckVoiceGlassLightSrc,alt:"",width:120,height:120,draggable:!1}),jsxRuntimeExports.jsx("img",{id:"qoduck-voice-glass-dark",className:"qoduck-voice-glass",src:qoduckVoiceGlassDarkSrc,alt:"",width:120,height:120,draggable:!1})';
    body = replaceOnce(body, images, 'jsxRuntimeExports.jsxs("span",{className:"notch-voice-brand",style:{display:"flex",alignItems:"center",gap:6,fontSize:20,fontWeight:600,letterSpacing:"-.6px"},children:[jsxRuntimeExports.jsx(NotchSymbol,{size:22}),"notch"]}),jsxRuntimeExports.jsx("span",{style:{fontSize:11,lineHeight:1.3,opacity:.75},children:M1})');
    body = replaceOnce(body, 'id:"orb-core",children:', 'id:"orb-core",style:{top:"40%",width:132,height:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,border:"1px solid var(--qcac38d)",borderRadius:12,background:"var(--q715358)",color:"var(--qec21c5)"},children:');
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
export function patchWorkbenchRenderer(source) {
  source = patchLocalOnlyRenderer(source);
  // Keep extension management on its existing local installer, away from the retired account marketplace.
  if (source.includes('function ExtensionsView(')) source = patchFunction(source, 'ExtensionsView', 'function ExtensionsView({initialKind="plugin"}){return jsxRuntimeExports.jsx(InstalledExtensionsSettings,{initialKind});}');
  if (source.includes('/* notch workbench skin */')) return patchEnglishRenderer(patchSecondaryArtwork(source));
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
  source = patchFunction(source, 'AppearanceSettings', 'function AppearanceSettings(){const preferences=useWorkbenchPreferences(),{i18n}=useTranslation();return reactExports.createElement(NotchAppearance,{preferences,language:resolveInterfaceLanguage(i18n.resolvedLanguage??i18n.language),setLanguage:setInterfaceLanguage});}');
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
        item("About notch",()=>workbenchClient.openExternalUrl("https://freesyntax.dev"))
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
  return patchEnglishRenderer(patchSecondaryArtwork('/* notch workbench skin */\nimport {createModelMenu} from "./model-menu.mjs";\nimport {createNotchWorkbench} from "./workbench-skin.mjs";\n' + source));
}

export async function verifyWorkbenchImports(assets) {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    const source = await readFile(file, 'utf8');
    for (const node of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
      if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.')) await visit(path.resolve(path.dirname(file), node.source.value));
    }
  }
  await visit(path.join(assets, 'workbench-skin.mjs')); await visit(path.join(assets, 'model-menu.mjs'));
}

export async function installWorkbenchAssets(application, root) {
  const renderer = path.join(application, 'out/renderer'), assets = path.join(renderer, 'assets');
  for (const name of ['workbench-skin.mjs', 'workbench-skin.css', 'model-menu.mjs', 'web-settings-view.mjs']) await cp(path.join(root, 'src', name), path.join(assets, name));
  await verifyWorkbenchImports(assets);
  await cp(path.join(root,'assets/providers'),path.join(assets,'providers'),{recursive:true});
  await cp(path.join(root, 'assets/fonts'), path.join(assets, 'fonts'), { recursive: true });
  await cp(path.join(root, 'assets/notices'), path.join(assets, 'notices'), { recursive: true });
  await cp(path.join(root, 'assets/notch-symbol.png'), path.join(assets, 'notch-symbol.png'));
  const htmlFile = path.join(renderer, 'index.html'), html = await readFile(htmlFile, 'utf8');
  if (!html.includes('href="./assets/workbench-skin.css"')) await writeFile(htmlFile, html.replace('</head>', '<link rel="stylesheet" href="./assets/workbench-skin.css">\n</head>'));
  const icon = await readFile(path.join(root, 'assets/notch-symbol.png'));
  const icons = path.join(application, '../resources/application-icons');
  for (const name of await readdir(icons)) if (/^(?:notch|qoder|qoduck)-(?:light|dark)(?:-windows)?\.png$/.test(name)) await writeFile(path.join(icons, name), icon);
  const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(icon.length, 14); header.writeUInt32LE(22, 18);
  await writeFile(path.join(application, '../resources/app-icon.ico'), Buffer.concat([header, icon]));
}
