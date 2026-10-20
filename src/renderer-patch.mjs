import { readFile, writeFile, readdir, cp, unlink } from 'node:fs/promises';
import path from 'node:path';
import { patchFunction, patchClassMethod } from './bundle-patch.mjs';
import { verifyProductMessages } from './ui-message-verification.mjs';
import { patchWorkbenchRenderer, installWorkbenchAssets } from './workbench-patch.mjs';
import { patchModelPreload } from './model-ipc.mjs';

export function patchVoiceHardwareShutdown(source) {
  for (const [method,variable,observable,anchor] of [
    ['reconcileDjiMicConfiguration','o1','djiMicButtonValue','return s1&&!o1.enabled'],
    ['configureVoiceFnShortcut','r1','voiceFnShortcutValue','return this.voiceFnShortcutValue.set(r1,void 0)'],
  ]) source=patchClassMethod(source,'VoiceHardwareTriggerController',method,body=>{
    // Shutdown can cancel IPC without returning a hardware-control snapshot.
    const guard=`if(${variable}===undefined)return this.${observable}.get();`;
    if(body.includes(guard))return body;
    if(body.split(anchor).length!==2)throw new Error(`Voice hardware response changed: ${method}`);
    return body.replace(anchor,guard+anchor);
  });
  return source;
}

export function patchSetupRenderer(source) {
  source=patchVoiceHardwareShutdown(source);
  if (source.includes('/* notch setup renderer */')) return source;
  source = patchFunction(source, 'OnboardingOverlaySurface', 'function OnboardingOverlaySurface(){return reactExports.createElement(NotchSetup);}');
  source = patchFunction(source, 'FirstLaunchOnboardingSurface', 'const NotchSetup=createNotchSetup(reactExports);function FirstLaunchOnboardingSurface(props){return reactExports.createElement(NotchSetup,props);}');
  // The native notification bridge can resolve without a snapshot during window shutdown.
  source = patchClassMethod(source, 'WorkbenchNotificationService', 'accept', 'if(!e1)return;e1.revision<this.stateObs.get().revision||this.stateObs.set(e1,void 0);');
  for (const name of ['getAudioElement', 'preloadOnboardingSoundEffects', 'playOnboardingSoundEffect']) {
    source = patchFunction(source, name, `function ${name}(){return null;}`);
  }
  const sounds = /new URL\("onboarding(?:Opening|Typing|Send|FinalSend)-[^"/]+\.wav",import\.meta\.url\)\.href/g;
  if ([...source.matchAll(sounds)].length !== 4) throw new Error('Upstream onboarding audio assets differ from the baseline.');
  source = source.replace(sounds, '""');
  return '/* notch setup renderer */\nimport {createNotchSetup} from "./notch-setup.mjs";\n' + source;
}

export function patchSetupDocument(html) {
  html=html.replace('<html lang="zh-CN"','<html lang="en"');
  if (html.includes('<!-- notch quiet startup -->')) return html;
  const style = '<style>html,body,#root{width:100%;height:100%;margin:0}#notch-boot-splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;gap:24px;background:#141416;color:#aeb9c2;text-align:center;font:12px/1.5 system-ui,sans-serif;-webkit-app-region:drag}#notch-boot-splash img{width:168px;height:50px;margin:auto}#notch-boot-splash .light{display:none}#notch-boot-splash[data-hidden="true"]{pointer-events:none;opacity:0}@media(prefers-color-scheme:light){#notch-boot-splash{background:#f5f4f6;color:#655b6c}#notch-boot-splash .dark{display:none}#notch-boot-splash .light{display:block}}</style>';
  const splash = '<!-- notch quiet startup --><div id="notch-boot-splash" role="status" aria-label="Opening notch"><img class="dark" src="./assets/notch-wordmark-dark.svg" alt="notch"><img class="light" src="./assets/notch-wordmark-light.svg" alt="notch"><span>Opening your workspace…</span></div>';
  const oldSplash = /<div id="notch-boot-splash"[\s\S]*?(?=\s*<div id="root")/;
  if (!oldSplash.test(html) || !/<style>[\s\S]*?<\/style>/.test(html)) throw new Error('Upstream startup document differs from the baseline.');
  return html.replace(/<style>[\s\S]*?<\/style>/, style).replace(oldSplash, splash);
}

export async function installSetupRenderer(application, root) {
  const preloadFile = path.join(application,'out/preload/index.cjs'), preload = await readFile(preloadFile,'utf8');
  const patchedPreload=patchModelPreload(preload);
  if(patchedPreload!==preload)await writeFile(preloadFile,patchedPreload);
  const renderer = path.join(application, 'out/renderer'), assets = path.join(renderer, 'assets');
  const candidates = [];
  for (const name of await readdir(assets)) {
    if (!/^index-.*\.js$/.test(name)) continue;
    const source = await readFile(path.join(assets, name), 'utf8');
    if (source.includes('function OnboardingOverlaySurface(')) candidates.push({ name, source });
  }
  if (candidates.length !== 1) throw new Error('Expected one setup renderer bundle.');
  await writeFile(path.join(assets, candidates[0].name), patchWorkbenchRenderer(patchSetupRenderer(candidates[0].source)));
  for (const name of ['notch-setup.mjs', 'notch-setup.css']) await cp(path.join(root, 'src', name), path.join(assets, name));
  for (const name of ['notch-wordmark-dark.svg', 'notch-wordmark-light.svg']) await cp(path.join(root, 'assets', name), path.join(assets, name));
  const htmlFile = path.join(renderer, 'index.html');
  let html = patchSetupDocument(await readFile(htmlFile, 'utf8'));
  if (!html.includes('href="./assets/notch-setup.css"')) {
    if (!html.includes('</head>')) throw new Error('Expected renderer document head.');
    html = html.replace('</head>', '<link rel="stylesheet" href="./assets/notch-setup.css">\n</head>');
  }
  await writeFile(htmlFile, html);
  await installWorkbenchAssets(application, root);
  await verifyProductMessages(application);
  for (const name of await readdir(assets)) {
    if (/^onboarding(?:Opening|Typing|Send|FinalSend)-[^/]+\.wav$/.test(name)) await unlink(path.join(assets, name));
  }
}
