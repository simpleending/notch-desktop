import { readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { patchFunction } from './bundle-patch.mjs';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Workbench skin anchor changed: ${before.slice(0, 70)}`);
  return source.replace(before, after);
}
export function patchWorkbenchRenderer(source) {
  if (source.includes('/* notch workbench skin */')) return source;
  source = patchFunction(source, 'preloadDoodleAssets', 'function preloadDoodleAssets(){}');
  for (const name of ['AgentGreetingMark', 'AppleTreeDoodle', 'ImageDoodle', 'PartnerPlanGreetingMark', 'MobileAppDownloadPromo', 'NewChatCursorGrid']) {
    source = patchFunction(source, name, `function ${name}(){return null;}`);
  }
  source = patchFunction(source, 'WorkbenchModeThemeSync', 'function WorkbenchModeThemeSync(){return null;}');
  source = patchFunction(source, 'WorkbenchSidebarModeSwitch', 'function WorkbenchSidebarModeSwitch(props){return reactExports.createElement(NotchModeSwitch,props);}');
  source = patchFunction(source, 'WorkspaceTabsEmptyState', 'function WorkspaceTabsEmptyState(props){return reactExports.createElement(NotchPanelLauncher,props);}');
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
        item("Release notes",()=>workbenchClient.openExternalUrl("https://github.com/simpleending/notch-desktop/commits/main/")),
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
  return '/* notch workbench skin */\nimport {createNotchWorkbench} from "./workbench-skin.mjs";\n' + source;
}

export async function installWorkbenchAssets(application, root) {
  const renderer = path.join(application, 'out/renderer'), assets = path.join(renderer, 'assets');
  for (const name of ['workbench-skin.mjs', 'workbench-skin.css']) await cp(path.join(root, 'src', name), path.join(assets, name));
  await cp(path.join(root, 'assets/notch-symbol.png'), path.join(assets, 'notch-symbol.png'));
  const htmlFile = path.join(renderer, 'index.html'), html = await readFile(htmlFile, 'utf8');
  if (!html.includes('href="./assets/workbench-skin.css"')) await writeFile(htmlFile, html.replace('</head>', '<link rel="stylesheet" href="./assets/workbench-skin.css">\n</head>'));
  const icon = await readFile(path.join(root, 'assets/notch-symbol.png'));
  const icons = path.join(application, '../resources/application-icons');
  for (const name of await readdir(icons)) if (/^(?:notch|qoder|qoduck)-(?:light|dark)(?:-windows)?\.png$/.test(name)) await writeFile(path.join(icons, name), icon);
  const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(icon.length, 14); header.writeUInt32LE(22, 18);
  await writeFile(path.join(application, '../resources/app-icon.ico'), Buffer.concat([header, icon]));
}
