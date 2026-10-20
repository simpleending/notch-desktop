import { isPrimaryModelSender } from './model-policy.mjs';
import { createGitHubAuth } from './github-auth.mjs';
import { githubRepository } from './github-repository.mjs';
import { originRepository } from './origin-repository.mjs';
import path from 'node:path';
import { detectLocalHardware } from '../vendor/notch-core/desktop-harness.js';

export function registerModelIpc(ipcMain, host) {
  const manager = host.modelManager;
  const state = async (refresh = false, refreshModels = refresh) => {
    const status = await manager.status();
    if (refresh && status.openrouter) await manager.cloudCatalog(true);
    const models = (await host.listModels(refreshModels)).filter(row=>row.key!=='auto');
    return { ...status, models, defaultModel: host.getDefaultModel(), discoveryWarning:host.getModelDiscoveryWarning(), hardware: await detectLocalHardware(), fallbacks: manager.allFallbacks() };
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
    phone: (action = 'status', value) => {
      const phone = host.phone;
      if (!phone) throw new Error('Phone access is unavailable.');
      if (action === 'status') return phone.status();
      if (action === 'update') return phone.update(value);
      if (action === 'revoke') return phone.revoke(value);
      if (action === 'rotate') return phone.rotate();
      throw new Error('Choose a supported phone action.');
    },
    workspace: async mode => mode === undefined ? manager.getWorkspaceMode() : manager.setWorkspaceMode(mode),
    state: refresh => state(refresh === true),
    connect: async (provider,key) => { await manager.connect(provider,key); return state(false,true); },
    disconnect: async provider => { await manager.disconnect(provider); return state(false,true); },
    context: async (model,tokens) => { await manager.setContext(model,tokens,await host.listModels(true)); return state(false,true); },
    fallbacks: async (model,ids) => {
      if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || id.length > 256)) throw new Error('Choose up to three OpenRouter fallback models.');
      const catalog = await manager.cloudCatalog(false, true);
      const listed = await host.listModels(true);
      await manager.setFallbacks(model, ids, [...new Map([...listed, ...catalog].map(row => [row.key, row])).values()]);
      return state(false, true);
    },
    hub: (runner,options) => manager.hubCatalog(runner,options),
    cloud: force => manager.cloudCatalog(force===true,true),
    colibri: (action,model) => manager.colibri(action,model),
    install: (repo,runner) => manager.startInstall(repo,runner),
    cancel: () => manager.cancelInstall(),
    status: () => manager.status(),
    queue: () => host.getQueueStatus(),
    origin: (action, value) => {
      if (!['status', 'login', 'cancel', 'logout', 'namespaces', 'repos', 'remember', 'openRepo', 'clone'].includes(action)) throw Error('Choose a supported Origin action.');
      if (['clone', 'openRepo'].includes(action) && !originRepository(value)) throw Error('Choose an Origin repository.');
      if (action === 'remember' && (!Array.isArray(value) || value.length > 1000 || value.some(directory => typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)))) throw Error('Choose valid local project folders.');
      if (action === 'repos' && (!value || typeof value.owner !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value.owner) || ['.', '..'].includes(value.owner) || value.owner.length > 256 || value.pageToken !== undefined && (typeof value.pageToken !== 'string' || value.pageToken.length > 4096))) throw Error('Choose a valid Origin namespace and page.');
      if (['status', 'login', 'cancel', 'logout', 'namespaces'].includes(action) && value !== undefined) throw Error('Invalid Origin request.');
      return host.origin[action](value);
    },
    github: (action, value) => {
      if (!['status', 'install', 'login', 'cancel', 'repos', 'clone', 'pickLocal', 'remember', 'openRepo'].includes(action)) throw new Error('Choose a supported GitHub action.');
      if (['clone', 'openRepo'].includes(action) && !githubRepository(value)) throw new Error('Choose a repository from the list or enter a GitHub repository URL.');
      if (action === 'remember' && (!Array.isArray(value) || value.length > 1000 || value.some(directory => typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)))) throw new Error('Choose valid local project folders.');
      if (action === 'repos' && value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Choose a valid repository page.');
      if (!['clone', 'repos', 'remember', 'openRepo'].includes(action) && value !== undefined) throw new Error('Invalid GitHub request.');
      return host.github[action](value);
    },
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
  fallbacks:(model,ids)=>ipcRenderer.invoke('notch-models:fallbacks',model,ids),
  hub:(runner,options)=>ipcRenderer.invoke('notch-models:hub',runner,options),
  cloud:force=>ipcRenderer.invoke('notch-models:cloud',force),
  colibri:(action,model)=>ipcRenderer.invoke('notch-models:colibri',action,model),
  install:(repo,runner)=>ipcRenderer.invoke('notch-models:install',repo,runner),
  cancel:()=>ipcRenderer.invoke('notch-models:cancel'),
  status:()=>ipcRenderer.invoke('notch-models:status'),
  queue:()=>ipcRenderer.invoke('notch-models:queue'),
  web:patch=>ipcRenderer.invoke('notch-models:web',patch),
  webInstall:()=>ipcRenderer.invoke('notch-models:webInstall'),
  phone:(action,value)=>ipcRenderer.invoke('notch-models:phone',action,value),
  github:(action,value)=>ipcRenderer.invoke('notch-models:github',action,value),
  origin:(action,value)=>ipcRenderer.invoke('notch-models:origin',action,value),
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
  if(!source.includes("phone:(action,value)=>"))source=source.replace("webInstall:()=>ipcRenderer.invoke('notch-models:webInstall')","webInstall:()=>ipcRenderer.invoke('notch-models:webInstall'),\n  phone:(action,value)=>ipcRenderer.invoke('notch-models:phone',action,value)");
  if(!source.includes("github:(action,value)=>"))source=source.replace("phone:(action,value)=>ipcRenderer.invoke('notch-models:phone',action,value)","phone:(action,value)=>ipcRenderer.invoke('notch-models:phone',action,value),\n  github:(action,value)=>ipcRenderer.invoke('notch-models:github',action,value)");
  if(!source.includes("origin:(action,value)=>"))source=source.replace("github:(action,value)=>ipcRenderer.invoke('notch-models:github',action,value)","github:(action,value)=>ipcRenderer.invoke('notch-models:github',action,value),\n  origin:(action,value)=>ipcRenderer.invoke('notch-models:origin',action,value)");
  if(!source.includes('voiceInstall:()=>'))source=source.replace("workspace:mode=>", "voice:()=>ipcRenderer.invoke('notch-models:voice'),voiceInstall:()=>ipcRenderer.invoke('notch-models:voiceInstall'),voiceCancel:()=>ipcRenderer.invoke('notch-models:voiceCancel'),\n  workspace:mode=>");
  if(!source.includes('voiceModels:(action,input)=>')){
    if(source.split('voiceInstall:()=>').length!==2)throw new Error('The speech model bridge differs from the expected version.');
    source=source.replace('voiceInstall:()=>',"voiceModels:(action,input)=>ipcRenderer.invoke('notch-models:voiceModels',action,input),voiceInstall:()=>");
  }
  if(!source.includes("fallbacks:(model,ids)=>"))source=source.replace("context:(model,tokens)=>ipcRenderer.invoke('notch-models:context',model,tokens)","context:(model,tokens)=>ipcRenderer.invoke('notch-models:context',model,tokens),\n  fallbacks:(model,ids)=>ipcRenderer.invoke('notch-models:fallbacks',model,ids)");
  return source;
}
