import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function createAppUpdater({app,updater,directory,platform=process.platform,arch=process.arch,profileOverride=false,startupDelay=8000}) {
  const currentVersion=app.getVersion();
  const supported=app.isPackaged&&platform==='win32'&&arch==='x64'&&/^\d+\.\d+\.\d+$/.test(currentVersion);
  const file=path.join(directory,'app-updates.json');
  let timer,pending,closed=false,shutdown=false;
  const state={supported,canInstall:supported&&!profileOverride,automatic:true,currentVersion,phase:'idle',message:'Updates are checked on startup and downloaded in the background.'};
  const snapshot=()=>({...state});
  const fail=()=>{state.phase='error';state.message='Could not check or download the update. Your current version is unchanged. Try again or visit GitHub releases.';};
  updater.allowPrerelease=false;updater.allowDowngrade=false;updater.disableDifferentialDownload=true;
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;
  updater.on('checking-for-update',()=>{state.phase='checking';state.message='Checking GitHub releases…';});
  updater.on('update-not-available',()=>{state.phase='current';state.message='No newer stable release is available.';});
  updater.on('update-available',info=>{state.latestVersion=info.version;state.phase='available';state.message=`notch ${info.version} is available.`;});
  updater.on('download-progress',info=>{state.phase='downloading';state.progress=Math.max(0,Math.min(100,Math.round(info.percent)));state.message=`Downloading notch ${state.latestVersion}… ${state.progress}%`;});
  updater.on('update-downloaded',info=>{state.latestVersion=info.version;state.phase='ready';state.progress=100;state.message=`notch ${info.version} is ready. ${updater.autoInstallOnAppQuit?'It will install when you quit the application.':'Choose Quit and install when you are ready.'}`;});
  updater.on('error',fail);
  const ready=(async()=>{
    try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(typeof saved.automatic==='boolean')state.automatic=saved.automatic;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))fail();}
    if(!supported){state.message='Automatic installation is available for stable installed Windows x64 releases. Download other builds from GitHub.';return;}
    if(profileOverride)state.message='Automatic installation is paused in this separate profile. You can still check releases.';
    updater.autoDownload=state.automatic&&!profileOverride&&!shutdown;
    updater.autoInstallOnAppQuit=state.automatic&&!profileOverride&&!shutdown;
    if(state.automatic&&!profileOverride&&!closed&&!shutdown){timer=setTimeout(()=>void service.check(),startupDelay);timer.unref?.();}
  })();
  const service={
    async status(){await ready;return snapshot();},
    async check(){await ready;if(closed||shutdown||!supported)return snapshot();if(state.phase==='ready'||state.phase==='downloading')return snapshot();
      if(!pending)pending=(async()=>{try{const result=await updater.checkForUpdates();if(result?.downloadPromise)void result.downloadPromise.catch(fail);}catch{fail();}finally{pending=null;}})();
      await pending;return snapshot();
    },
    async automatic(value){await ready;if(typeof value!=='boolean')throw new Error('Choose whether automatic updates are enabled.');
      const temp=file+'.'+randomUUID()+'.tmp';try{await fs.mkdir(directory,{recursive:true});await fs.writeFile(temp,JSON.stringify({automatic:value}),{flag:'wx',mode:0o600,flush:true});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
      state.automatic=value;updater.autoDownload=!shutdown&&value&&!profileOverride;updater.autoInstallOnAppQuit=!shutdown&&value&&!profileOverride;
      if(!value)clearTimeout(timer);else if(supported&&!profileOverride&&!closed)void service.check();return snapshot();
    },
    async download(){await ready;if(!supported||profileOverride||shutdown||state.phase!=='available')throw new Error('Check for an available update in the installed application first.');
      updater.autoInstallOnAppQuit=!shutdown;try{await updater.downloadUpdate();}catch{fail();}return snapshot();
    },
    async quit(){await ready;if(!supported||profileOverride||state.phase!=='ready')throw new Error('Download an update before installing it.');updater.autoInstallOnAppQuit=!shutdown;app.quit();return snapshot();},
    deferForShutdown(){shutdown=true;updater.autoDownload=false;updater.autoInstallOnAppQuit=false;if(state.phase==='ready')state.message='The update is cached. Installation waits for a later launch and normal quit.';},
    close(){closed=true;clearTimeout(timer);},
  };
  return service;
}
