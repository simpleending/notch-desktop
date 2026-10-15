import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import assert from 'node:assert/strict';
import { extractAll, createPackageWithOptions } from '@electron/asar';
import { installSetupRenderer } from '../src/renderer-patch.mjs';
import { verifyRendererBranding } from '../src/branding-verification.mjs';
import { rebrandTree } from '../src/rebrand-tree.mjs';
import { patchDirectStartup, patchUndoIntegration, patchPersistedContextUsage, patchStartupShutdown } from '../src/bundle-patch.mjs';
import { rebuildPluginCatalog, verifyPluginCatalog } from '../src/plugin-integrity.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)), version=process.argv[2] || '0.1.0-preview.1';
if(process.platform!=='win32' || process.arch!=='x64')throw new Error('Build this installer on Windows x64.');
if(!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version))throw new Error('Use a release version such as 0.1.0 or 0.1.0-preview.1.');
const preview = version.includes('-preview.'), productName = preview ? 'notch preview' : 'notch';
const appId = `com.freesyntax.notch.desktop${preview ? '.preview' : ''}`;
if(!process.env.npm_execpath)throw new Error('Run npm run package:windows.');
const source=path.join(root,'release/Notch-prototype');await fs.access(path.join(source,'Notch.exe'));
const staging=await fs.mkdtemp(path.join(root,'release/windows-preview-')), app=path.join(staging,'app'), unpacked=path.join(app,'build-app');
const ripgrepVersion='15.2.0', ripgrepName=`ripgrep-${ripgrepVersion}-x86_64-pc-windows-msvc`;
const ripgrepArchive=path.join(root,'release',`${ripgrepName}.zip`);
let ripgrepBytes;
try { ripgrepBytes=await fs.readFile(ripgrepArchive); }
catch(error) {
  if(error.code!=='ENOENT')throw error;
  const response=await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${ripgrepName}.zip`,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`Cannot download official ripgrep: HTTP ${response.status}.`);
  ripgrepBytes=Buffer.from(await response.arrayBuffer());
}
assert.equal(createHash('sha256').update(ripgrepBytes).digest('hex'),'71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5','Official ripgrep archive checksum mismatch; remove the cached release archive and retry.');
await fs.writeFile(ripgrepArchive,ripgrepBytes);
const ripgrepExtracted=path.join(staging,'ripgrep');
await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:NOTCH_RG_ARCHIVE -DestinationPath $env:NOTCH_RG_DESTINATION'],{windowsHide:true,env:{...process.env,NOTCH_RG_ARCHIVE:ripgrepArchive,NOTCH_RG_DESTINATION:ripgrepExtracted}});
const ripgrepSource=path.join(ripgrepExtracted,ripgrepName);
assert.equal(createHash('sha256').update(await fs.readFile(path.join(ripgrepSource,'rg.exe'))).digest('hex'),'14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680','Extracted ripgrep executable checksum mismatch.');
await fs.cp(source,app,{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).some(name=>name==='build-app' || name==='prototype-build.json' || name.startsWith('app-feedback-'))});
await rebuildPluginCatalog(path.join(app, 'resources/extensions'));
console.log(JSON.stringify({ pluginIntegrity: await verifyPluginCatalog(path.join(app, 'resources/extensions')) }));
await fs.mkdir(path.join(app,'resources/bin'),{recursive:true});
await fs.copyFile(path.join(ripgrepSource,'rg.exe'),path.join(app,'resources/bin/notch-rg.exe'));
assert.match((await promisify(execFile)(path.join(app,'resources/bin/notch-rg.exe'),['--version'],{windowsHide:true})).stdout,/^ripgrep 15\.2\.0[\s\S]*PCRE2 10\.45 is available/,'Packaged ripgrep must support the pinned PCRE2 engine.');
extractAll(path.join(app,'resources/app.asar'),unpacked);
const mainFile=path.join(unpacked,'out/main/index.js');
await fs.writeFile(mainFile,patchStartupShutdown(patchPersistedContextUsage(patchUndoIntegration(patchDirectStartup(await fs.readFile(mainFile,'utf8'))))));
await fs.cp(path.join(root,'src'),path.join(unpacked,'notch/src'),{recursive:true});
await fs.cp(path.join(root,'vendor/notch-core'),path.join(unpacked,'notch/vendor/notch-core'),{recursive:true});
const cliSource=path.join(root,'node_modules/@freesyntax/notch-cli'), cliTarget=path.join(unpacked,'notch/node_modules/@freesyntax/notch-cli');
if(!path.resolve(cliTarget).startsWith(path.resolve(staging)+path.sep))throw new Error('Invalid embedded CLI target.');
await fs.rm(cliTarget,{recursive:true,force:true});
await fs.cp(cliSource,cliTarget,{recursive:true});
assert.equal(JSON.parse(await fs.readFile(path.join(cliTarget,'package.json'),'utf8')).version,JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).dependencies['@freesyntax/notch-cli'],'The packaged CLI must match the pinned tested version.');
await installSetupRenderer(unpacked,root);
for(const folder of ['out/main','out/renderer','out/preload'])await rebrandTree(path.join(unpacked,folder));
console.log(JSON.stringify({branding:await verifyRendererBranding(unpacked)}));
const manifest=path.join(unpacked,'package.json'), metadata=JSON.parse(await fs.readFile(manifest,'utf8'));
metadata.version=version;metadata.description='notch by freesyntax.dev';metadata.author='freesyntax.dev';await fs.writeFile(manifest,JSON.stringify(metadata,null,2));
await createPackageWithOptions(unpacked,path.join(app,'resources/app.asar'),{unpack:'**/*.{node,dll,exe,so,dylib}',unpackDir:'**/{@ff-labs,ffi-rs,@yuuang}'});
const extracted=path.join(staging,'build-app');
if(!unpacked.startsWith(staging+path.sep) || !extracted.startsWith(staging+path.sep))throw new Error('Invalid packaging directory.');
await fs.rename(unpacked,extracted);
const notices=path.join(app,'resources/notices');await fs.mkdir(notices,{recursive:true});
for(const [source,name] of [['LICENSE','notch-AGPL-3.0.txt'],['vendor/notch-cli/LICENSE','notch-cli-Apache-2.0.txt'],['docs/third-party-notices.md','THIRD-PARTY-NOTICES.md'],['docs/windows-preview.md','WINDOWS-PREVIEW.md'],['assets/notices/fff-LICENSE.txt','fff-LICENSE.txt']])await fs.copyFile(path.join(root,source),path.join(notices,name));
for(const name of ['COPYING','LICENSE-MIT','UNLICENSE'])await fs.copyFile(path.join(ripgrepSource,name),path.join(notices,`ripgrep-${name}.txt`));
for(const name of ['ripgrep-PCRE2-LICENSE.txt','ripgrep-PCRE2-COPYING.txt'])await fs.copyFile(path.join(root,'assets/notices',name),path.join(notices,name));
await fs.copyFile(path.join(root,'assets/notices/sharp-win32-x64-LICENSE.txt'),path.join(notices,'sharp-win32-x64-LICENSE.txt'));
const buildManifest=path.join(app,'resources/build-manifest.json'), build=JSON.parse(await fs.readFile(buildManifest,'utf8'));
build.productVersion=version;await fs.writeFile(buildManifest,JSON.stringify(build,null,2));
const productFile=path.join(app,'resources/product.json'),product=JSON.parse(await fs.readFile(productFile,'utf8'));
Object.assign(product,{channel:preview?'preview':'stable',appId,dataDirectoryName:appId,protocolScheme:preview?'notch-preview':'notch',windowsLauncherDirectory:`${preview?'notch-preview':'notch'}/Launcher`,windowsLauncherMutexName:preview?'Local/notchPreviewDesktopLauncher':'Local/notchDesktopLauncher'});
await fs.writeFile(productFile,JSON.stringify(product,null,2));
// The prepackaged builder skips executable metadata; reuse its cached resource editor.
const cache=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/winCodeSign');
let editor;
for(const folder of await fs.readdir(cache)){const candidate=path.join(cache,folder,'rcedit-x64.exe');try{await fs.access(candidate);editor=candidate;break;}catch{}}
if(!editor)throw new Error('The electron-builder Windows resource editor is missing from its cache.');
await promisify(execFile)(editor,[path.join(app,'Notch.exe'),'--set-icon',path.join(app,'resources/app-icon.ico'),
  '--set-file-version',version.split('-')[0],'--set-product-version',version,
  '--set-version-string','ProductName','notch','--set-version-string','FileDescription','notch by freesyntax.dev',
  '--set-version-string','CompanyName','freesyntax.dev','--set-version-string','InternalName','notch',
  '--set-version-string','OriginalFilename','Notch.exe','--set-version-string','LegalCopyright','Copyright 2026 Driftrail'],{windowsHide:true});
const configuration={appId,productName,executableName:'Notch',copyright:'Copyright 2026 Driftrail',
  directories:{output:path.join(staging,'installer')},extraMetadata:{version},npmRebuild:false,publish:null,
  win:{target:[{target:'nsis',arch:['x64']}],icon:path.join(app,'resources/app-icon.ico')},
  nsis:{artifactName:`notch-${version}-setup-x64.exe`,oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,
    createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:productName,uninstallDisplayName:productName,deleteAppDataOnUninstall:false,runAfterFinish:false,differentialPackage:false,license:path.join(root,'LICENSE')}};
const config=path.join(staging,'electron-builder.json');await fs.writeFile(config,JSON.stringify(configuration,null,2));
await new Promise((resolve,reject)=>{
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|^csc_/i.test(key))),CSC_IDENTITY_AUTO_DISCOVERY:'false'};
  const child=spawn(process.execPath,[process.env.npm_execpath,'exec','--yes','--package=electron-builder@26.15.3','--','electron-builder','--prepackaged',app,'--win','nsis','--x64','--config',config,'--publish','never'],{cwd:root,env,stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Installer build exited ${code}.`)));
});
const installer=path.join(staging,'installer',`notch-${version}-setup-x64.exe`), hash=createHash('sha256');
for await(const chunk of createReadStream(installer))hash.update(chunk);
await fs.writeFile(path.join(staging,'installer/SHA256SUMS.txt'),`${hash.digest('hex')}  ${path.basename(installer)}\n`);
await fs.writeFile(path.join(root,preview?'release/windows-preview-latest.json':'release/windows-stable-latest.json'),JSON.stringify({version,installer,application:app},null,2));
console.log(JSON.stringify({version,installer,application:app}));
