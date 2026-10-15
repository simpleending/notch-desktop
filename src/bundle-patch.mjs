import { tokenizer } from 'acorn';

function closingBrace(source, start) {
  const tokens = tokenizer(source.slice(start), { ecmaVersion: 'latest', sourceType: 'module' }); let depth = 0;
  while (true) {
    const token = tokens.getToken(), kind = token.type.label;
    if (kind === 'eof') throw new Error('Unclosed upstream method/class.');
    if (kind === '{' || kind === '${') depth++;
    if (kind === '}' && --depth === 0) return start + token.end;
  }
}
export function patchClassMethod(source, className, methodName, body) {
  const classPattern = new RegExp(`\\b${className}=class(?:\\s+extends\\s+[\\w$]+)?\\s*\\{`, 'g');
  const classes = [...source.matchAll(classPattern)];
  if (classes.length !== 1) throw new Error(`Expected one upstream class ${className}.`);
  const first = classes[0].index + classes[0][0].length - 1, end = closingBrace(source, first);
  const section = source.slice(first, end), scanner = tokenizer(section, { ecmaVersion: 'latest', sourceType: 'module' });
  const methods = []; let depth = 0;
  while (true) {
    const token = scanner.getToken(), kind = token.type.label;
    if (kind === 'eof') break;
    if (kind === '{' || kind === '${') depth++;
    else if (kind === '}') depth--;
    if (depth !== 1 || token.value !== methodName) continue;
    if (scanner.getToken().type.label !== '(') throw new Error(`Unsupported ${className}.${methodName} signature.`);
    let parameters = 1;
    while (parameters) { const part = scanner.getToken().type.label; if (part === '(') parameters++; else if (part === ')') parameters--; else if (part === 'eof') throw new Error('Unclosed parameters.'); }
    const bodyToken = scanner.getToken();
    if (bodyToken.type.label !== '{') throw new Error('Expected method body.');
    depth++; methods.push(first + bodyToken.start);
  }
  if (methods.length !== 1) throw new Error(`Expected one ${className}.${methodName} method.`);
  const start = methods[0], stop = closingBrace(source, start);
  return source.slice(0, start) + `{${body}}` + source.slice(stop);
}
export function patchFunction(source, name, replacement) {
  const matches = [...source.matchAll(new RegExp(`\\bfunction ${name}\\(`, 'g'))];
  if (matches.length !== 1) throw new Error(`Expected one upstream function ${name}.`);
  const start = matches[0].index, scanner = tokenizer(source.slice(start), { ecmaVersion: 'latest', sourceType: 'module' });
  scanner.getToken(); scanner.getToken(); scanner.getToken();
  let depth = 1;
  while (depth) {
    const kind = scanner.getToken().type.label;
    if (kind === '(') depth++;
    else if (kind === ')') depth--;
    else if (kind === 'eof') throw new Error('Unclosed upstream function parameters.');
  }
  const body = scanner.getToken();
  if (body.type.label !== '{') throw new Error('Expected upstream function body.');
  const end = closingBrace(source, start + body.start);
  const next = typeof replacement === 'function' ? replacement(source.slice(start, end)) : replacement;
  return source.slice(0, start) + next + source.slice(end);
}
export function patchWorkbench(source) {
  const changes = [
    ['moe', 'searchSessionFiles', 'const {target,rootPath}=this.requireSessionRoot(e.sessionId,e.rootId);if(target.host.kind!=="local")return Promise.resolve(null);return globalThis.__notchHost.workspaceSearch.search(t,rootPath,e.generation,e.query).catch(error=>{if(error.message==="WORKSPACE_FILE_SEARCH_CANCELLED")throw error;return this.nativeSearchService?this.nativeSearchService.search(t,rootPath,e.generation,e.query):Promise.reject(error);});'],
    ['moe', 'cancelFileSearch', 'globalThis.__notchHost.workspaceSearch.cancel(t);this.nativeSearchService?.cancel(t);'],
    ['moe', 'shutdownFileSearch', 'return Promise.all([globalThis.__notchHost.workspaceSearch.shutdown(),this.nativeSearchService?.shutdown()]);'],
    ['gae', 'initializeState', 'this.cache=null;this.setState(globalThis.__notchHost.identity);'],
    ['gae', 'createAccountIdentity', 'return "notch:local";'],
    ['gae', 'getAccessToken', 'return null;'],
    ['gae', 'getAccessTokenInfo', 'return null;'],
    ['gae', 'getJobToken', 'return null;'],
    ['gae', 'login', 'return this.getState();'],
    ['gae', 'logout', 'return this.getState();'],
    ['gae', 'getAccountAchievements', 'return {achievements:[]};'],
    ['Uae', 'initialize', 'this.initialized=true;'],
    ['Uae', 'getCurrent', 'return Promise.resolve(null);'],
    ['hue', 'getCatalog', 'this.catalog={version:1,modes:{coding:[],general:[]}};return this.catalog;'],
    ['Xle', 'getLimitedNumber', 'return {hasNumber:false,number:null};'],
    ['NAe', 'createSession', 'return globalThis.__notchHost.query(t);'],
    ['NAe', 'prepareSession', 'return globalThis.__notchHost.prepare(t);'],
    ['NAe', 'sessionExists', 'return globalThis.__notchHost.hasSession(t);'],
    ['NAe', 'listModels', 'return globalThis.__notchHost.listModels(t);'],
    ['NAe', 'getCachedModels', 'return globalThis.__notchHost.getCachedModels();'],
    ['ZAe', 'listModels', 'return globalThis.__notchHost.listModels(e);'],
    ['ZAe', 'listComposerModels', 'return globalThis.__notchHost.listModels(e==="live");'],
    ['SAe', 'initialize', 'this.initialized=true;this.accountIdentity="notch:local";this.snapshot={accountId:"local-notch",revision:1,state:"ready",platformModels:globalThis.__notchHost.getCachedModels(),byokModels:[],preferences:[],fetchedAt:Date.now()};'],
    ['SAe', 'refreshNow', 'return globalThis.__notchHost.listModels(e).then(models=>{this.snapshot={...this.snapshot,platformModels:models,state:"ready",revision:this.snapshot.revision+1};this.changeEmitter.fire(this.snapshot);return {modelCount:models.length};});'],
    ['SAe', 'listModels', 'return globalThis.__notchHost.listModels(t);'],
    ['hAe', 'initialize', 'this.initialized=true;'],
    ['vae', 'initialize', 'return Promise.resolve();'],
    ['vae', 'track', 'return false;'],
    ['vae', 'trackImmediate', 'return false;'],
    ['ZAe', 'refresh', 'const rows=this.dataService.getSnapshot().runtimeEngines;for(const row of rows){if(row.placement==="local"&&(!t||row.id===t))await this.dataService.updateRuntime({...row,status:"ready",error:null,executablePath:null,pathSource:null,version:"0.7.0",updatedAt:new Date().toISOString()});}return this.dataService.getSnapshot().runtimeEngines;'],
    ['Ude', 'windowOptions', 'return {...t,title:"notch setup",show:false,frame:false,transparent:false,backgroundColor:"#141416",hasShadow:true,resizable:true,movable:true,minWidth:Math.min(640,t.width),minHeight:Math.min(460,t.height),minimizable:false,maximizable:false,fullscreenable:false,acceptFirstMouse:true,webPreferences:{preload:this.options.preloadPath,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,devTools:this.options.developerToolsEnabled}};'],
    ['Ude', 'dialogBounds', 'const width=Math.min(960,Math.max(1,t.width-48)),height=Math.min(660,Math.max(1,t.height-48));return {x:t.x+Math.round((t.width-width)/2),y:t.y+Math.round((t.height-height)/2),width,height};'],
  ];
  for (const [className, method, body] of changes) source = patchClassMethod(source, className, method, body);
  source = patchUndoIntegration(source);
  const reporting = 'enabled:GF&&(ot.isPackaged||process.env.QODER_RUM_DEV_REPORT==="1")';
  if (!source.includes(reporting)) throw new Error('Upstream RUM initialization differs from the inspected baseline.');
  source = source.replace(reporting, 'enabled:false');
  source = source.replace('Ev.startReporter();', 'void 0;');
  const overlayBounds = 'const a=r==="immersive"?n.bounds:this.dialogBounds(n.workArea)';
  if (!source.includes(overlayBounds)) throw new Error('Upstream setup window bounds differ from the baseline.');
  source = source.replace(overlayBounds, 'const a=this.dialogBounds(n.workArea)');
  const prepareProfile = 'H3r=ws.measureSync("user_data_prepared",!0,()=>{';
  if (!source.includes(prepareProfile)) throw new Error('Upstream profile preparation differs from the baseline.');
  source = source.replace(prepareProfile, prepareProfile + 'if(globalThis.__notchProfileOverride){const p=globalThis.__notchProfileOverride,s={userDataPath:p.directory,requestedPath:p.directory,temporary:false,dispose(){}};return {applicationDataRoot:p.directory,applicationProfileExistedAtStartup:p.existed,preparedUserData:s,preparedApplicationData:s,preparedAuthenticationData:s};}');
  const registration = 'function Z9t(t){';
  if (!source.includes(registration)) throw new Error('Upstream runtime validation differs from the baseline.');
  source = source.replace(registration, registration + 'if(t.runtime?.provider==="qoder"&&globalThis.__notchHost){t={...t,runtime:{...t.runtime,status:"ready"},registration:{...t.registration,id:t.registration?.id??"notch-builtin",status:"ready"}};}');
  return { source, changes: changes.map(([className, method]) => `${className}.${method}`) };
}
export function rebrandWorkbenchText(source) {
  // Disabled upstream endpoints must never turn into requests to unrelated domains.
  source = source.replace(/https?:\/\/(?:[a-z0-9-]+\.)*qoder\.(?:com\.cn|com|ai|sh)(?=[:/"'`\s]|$)/gi, 'https://disabled.notch.invalid');
  return source.replace(/qoder/gi, 'notch').replace(/Notch/g, 'notch')
    .replace(/\bQoduck\b|Q\s?达鸭/g,'notch')
    .replaceAll('/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u', '/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/iu');
}

export function patchDirectStartup(source) {
  // The notch installer launches the app directly and does not ship the legacy update launcher.
  return patchFunction(source,'aBt','function aBt(){return "current";}');
}

export function patchUndoIntegration(source) {
  const access = 'if(n){const c=this.dependencies.runtimeManager.acquireRewindSession(e);';
  const replacement = 'if(globalThis.__notchHost)return globalThis.__notchHost.acquireRewind(e);' + access;
  if (!source.includes(access)) throw new Error('File undo access differs from the inspected baseline.');
  if (!source.includes(replacement)) source = source.replace(access, replacement);
  source = source.replace('e.validatorVersion??"agent-sdk"', 'e.validatorVersion??"notch-0.1.0"');
  source = patchFunction(source, 'bPe', 'function bPe(t){return _Ke.has(t.toLowerCase())||t.toLowerCase()==="apply_patch";}');
  source = patchFunction(source, 'cnr', original => original.replace('(?:Add|Update|Delete) File:', '(?:(?:Add|Update|Delete) File|Move to):'));
  return patchFunction(source, 'Xme', 'function Xme(){return target=>globalThis.__notchHost.validatePlugin(target);}');
}
