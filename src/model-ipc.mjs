import { isPrimaryModelSender } from './model-policy.mjs';
import { detectLocalHardware } from '../vendor/notch-core/desktop-harness.js';

export function registerModelIpc(ipcMain, host) {
  const manager = host.modelManager;
  const state = async (refresh = false, refreshModels = refresh) => {
    const status = await manager.status();
    if (refresh && status.openrouter) await manager.cloudCatalog(true);
    const models = (await host.listModels(refreshModels)).filter(row=>row.key!=='auto');
    return { ...status, models, defaultModel: host.getDefaultModel(), discoveryWarning:host.getModelDiscoveryWarning(), hardware: await detectLocalHardware() };
  };
  const handlers = {
    updates: (action='status',value) => {
      if(!['status','check','automatic','download','quit'].includes(action))throw new Error('Choose a supported update action.');
      return host.updates[action](value);
    },
    voice: () => host.voice.status(),
    voiceInstall: () => host.voice.install(),
    voiceCancel: () => host.voice.cancelInstall(),
    voiceModels: (action,input) => host.voice.models(action,input),
    web: patch => patch === undefined ? host.webResearch.status() : host.webResearch.update(patch),
    webInstall: () => host.webResearch.install(),
    workspace: async mode => mode === undefined ? manager.getWorkspaceMode() : manager.setWorkspaceMode(mode),
    state: refresh => state(refresh === true),
    connect: async (provider,key) => { await manager.connect(provider,key); return state(false,true); },
    disconnect: async provider => { await manager.disconnect(provider); return state(false,true); },
    context: async (model,tokens) => { await manager.setContext(model,tokens,await host.listModels(true)); return state(false,true); },
    hub: (runner,options) => manager.hubCatalog(runner,options),
    cloud: force => manager.cloudCatalog(force===true,true),
    colibri: (action,model) => manager.colibri(action,model),
    install: (repo,runner) => manager.startInstall(repo,runner),
    cancel: () => manager.cancelInstall(),
    status: () => manager.status(),
    queue: () => host.getQueueStatus(),
  };
  for (const [method,handle] of Object.entries(handlers)) ipcMain.handle(`notch-models:${method}`, (event,...args) => {
    if (!isPrimaryModelSender(event)) throw new Error('Model settings are available only in the primary notch window.');
    if (args.length > 2 || args.some(arg=>typeof arg==='string' && arg.length>4096)) throw new Error('Invalid model settings request.');
    return handle(...args);
  });
}

export const modelPreload = `\n/* notch model settings bridge */
if(window.location.protocol==='notch-app:'&&!new URLSearchParams(window.location.search).has('surface')){
 const {contextBridge,ipcRenderer}=require('electron');
 contextBridge.exposeInMainWorld('notchModels',Object.freeze({
  updates:(action,value)=>ipcRenderer.invoke('notch-models:updates',action,value),
  state:refresh=>ipcRenderer.invoke('notch-models:state',refresh),
  connect:(provider,key)=>ipcRenderer.invoke('notch-models:connect',provider,key),
  disconnect:provider=>ipcRenderer.invoke('notch-models:disconnect',provider),
  context:(model,tokens)=>ipcRenderer.invoke('notch-models:context',model,tokens),
  hub:(runner,options)=>ipcRenderer.invoke('notch-models:hub',runner,options),
  cloud:force=>ipcRenderer.invoke('notch-models:cloud',force),
  colibri:(action,model)=>ipcRenderer.invoke('notch-models:colibri',action,model),
  install:(repo,runner)=>ipcRenderer.invoke('notch-models:install',repo,runner),
  cancel:()=>ipcRenderer.invoke('notch-models:cancel'),
  status:()=>ipcRenderer.invoke('notch-models:status'),
  queue:()=>ipcRenderer.invoke('notch-models:queue'),
  web:patch=>ipcRenderer.invoke('notch-models:web',patch),
  webInstall:()=>ipcRenderer.invoke('notch-models:webInstall'),
  workspace:mode=>ipcRenderer.invoke('notch-models:workspace',mode)
  ,voice:()=>ipcRenderer.invoke('notch-models:voice'),voiceInstall:()=>ipcRenderer.invoke('notch-models:voiceInstall'),voiceCancel:()=>ipcRenderer.invoke('notch-models:voiceCancel'),voiceModels:(action,input)=>ipcRenderer.invoke('notch-models:voiceModels',action,input)
 }));
}\n`;

export function patchModelPreload(source) {
  if(!source.includes('/* notch model settings bridge */'))return source+modelPreload;
  if(!source.includes('updates:(action,value)=>'))source=source.replace('state:refresh=>','updates:(action,value)=>ipcRenderer.invoke(\'notch-models:updates\',action,value),\n  state:refresh=>');
  const current="hub:(runner,options)=>ipcRenderer.invoke('notch-models:hub',runner,options)",previous="hub:runner=>ipcRenderer.invoke('notch-models:hub',runner)";
  if(!source.includes(current)){
    if(source.split(previous).length!==2)throw new Error('The model search bridge differs from the expected version.');
    source=source.replace(previous,current);
  }
  const cloud="cloud:force=>ipcRenderer.invoke('notch-models:cloud',force)";
  if(!source.includes(cloud))source=source.replace(current,current+",\n  "+cloud);
  const queue="queue:()=>ipcRenderer.invoke('notch-models:queue')";
  if(!source.includes("colibri:(action,model)=>"))source=source.replace(cloud,cloud+",\n  colibri:(action,model)=>ipcRenderer.invoke('notch-models:colibri',action,model)");
  if(!source.includes(queue))source=source.replace("status:()=>ipcRenderer.invoke('notch-models:status')","status:()=>ipcRenderer.invoke('notch-models:status'),\n  "+queue);
  if(!source.includes("workspace:mode=>"))source=source.replace(queue,queue+",\n  workspace:mode=>ipcRenderer.invoke('notch-models:workspace',mode)");
  if(!source.includes("web:patch=>"))source=source.replace("workspace:mode=>", "web:patch=>ipcRenderer.invoke('notch-models:web',patch),\n  webInstall:()=>ipcRenderer.invoke('notch-models:webInstall'),\n  workspace:mode=>");
  if(!source.includes('voiceInstall:()=>'))source=source.replace("workspace:mode=>", "voice:()=>ipcRenderer.invoke('notch-models:voice'),voiceInstall:()=>ipcRenderer.invoke('notch-models:voiceInstall'),voiceCancel:()=>ipcRenderer.invoke('notch-models:voiceCancel'),\n  workspace:mode=>");
  if(!source.includes('voiceModels:(action,input)=>')){
    if(source.split('voiceInstall:()=>').length!==2)throw new Error('The speech model bridge differs from the expected version.');
    source=source.replace('voiceInstall:()=>',"voiceModels:(action,input)=>ipcRenderer.invoke('notch-models:voiceModels',action,input),voiceInstall:()=>");
  }
  return source;
}
