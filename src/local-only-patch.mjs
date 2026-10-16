import { parse } from 'acorn';
import { patchClassMethod, patchFunction } from './bundle-patch.mjs';

const unavailable = 'throw new Error("This hosted feature is unavailable in the local edition of notch.");';
const localCapabilities = 'cloudCollaborationEnabled:false,cloudAutomations:false,issuesEnabled:false,discussionsEnabled:false,agentTeamsEnabled:false,squadEnabled:false,partnerPlan:false';

/** Retire hosted services at their shared boundaries, including restored preferences and direct IPC callers. */
export function patchLocalOnlyMain(source) {
  source = patchFunction(source, 'bg', `function bg(){return {...Vn().features,${localCapabilities}};}`);
  const methods = [
    ['Mae', 'initialize', 'this.initialized=true;'],
    ['Mae', 'capabilities', `return {...this.defaults,${localCapabilities}};`],
    ['gae', 'getOrganizationContext', 'return null;'],
    ['gae', 'getAccountPlan', 'return {isPersonalVersion:true};'],
    ['gae', 'readAccountUsage', unavailable],
    ['gae', 'getAccountCreditsHeatmap', unavailable],
    ['gae', 'getAccountProfileMetrics', unavailable],
    ['gae', 'requestOpenApi', unavailable],
    ['vne', 'ensureReady', 'return;'],
    ['vne', 'refreshOrThrow', 'return;'],
    ['vne', 'getValue', 'return undefined;'],
    ['DAe', 'initialize', 'this.initialized=true;'],
    ['DAe', 'listConfigs', unavailable],
    ['Mne', 'request', 'return {shareEnabled:false,canUpdate:false,restrictionReason:null,policyUrl:null};'],
    ['one', 'acceptIdentity', body => replace(body, 'i=!Av()&&!!t&&!!r', 'i=false')],
    ['one', 'ensureReady', 'return Promise.resolve();'],
    ['one', 'refreshViewOnce', 'e.value=JU(this.state,e.request);this.publish({});'],
    ['one', 'execute', unavailable],
    ['qAe', 'initialize', 'this.initialized=true;'],
    ['qAe', 'configure', unavailable],
    ['qAe', 'refresh', unavailable],
    ['qAe', 'requestWithToken', unavailable],
    ['VAe', 'initialize', 'this.initialized=true;this.enabled=false;this.publish("disabled");'],
    ['VAe', 'setEnabled', `if(t){${unavailable}}this.enabled=false;this.publish("disabled");return this.getSnapshot();`],
    ['VAe', 'start', unavailable],
    ['loe', 'getAvailability', 'return {supported:false};'],
    ['loe', 'connectHost', unavailable],
    ['loe', 'connectLocalAgent', unavailable],
    ['nde', 'start', unavailable],
    ['Ade', 'startSession', unavailable],
    ['Ade', 'withVoiceprintConnection', unavailable],
    ['Ade', 'getCapabilities', 'return {aoqAvailable:false};'],
    ['uue', 'initialize', 'return Promise.resolve();'],
    ['eAe', 'upload', unavailable],
    ['eue', 'marketplaceProfiles', 'return [];'],
    ['eue', 'prepareMarketplaceConnector', unavailable],
    ['gce', 'listMarket', unavailable],
    ['gce', 'getMarketDetail', unavailable],
    ['gce', 'listEducationRecommendations', 'return Promise.resolve({items:[]});'],
    ['gce', 'refreshSkillMarketMetadata', 'return;'],
    ['gce', 'queueMarketplaceIconHydration', 'return;'],
    ['gce', 'install', body => {
      const guard=`if(t.source!=="local"){${unavailable}}`;
      return body.startsWith(guard)?body:guard+body;
    }],
    ['Yde', 'initialize', 'this.initialized=true;'],
    ['OZ', 'fetchAssignment', unavailable],
    ['Eue', 'listCategories', 'return Promise.resolve([]);'],
    ['Eue', 'list', 'return Promise.resolve({items:[],hasMore:false});'],
    ['Eue', 'get', unavailable],
    ['Rne', 'run', unavailable],
    ['wne', 'target', 'return "https://openrouter.ai/api/v1/models";'],
  ];
  for (const [name, method, body] of methods) source = patchClassMethod(source, name, method, body);
  return source;
}

function replace(source, before, after) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) throw new Error(`Local-only renderer anchor changed: ${before}`);
  return source.replace(before, after);
}

// Remove the whole control, including its callback, rather than hiding an active hosted action with CSS.
function removeControls(source, labels) {
  const spans = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && /^(?:SettingsItem|Button|TabsTrigger)$/.test(node.arguments?.[0]?.name)) {
      const props = node.arguments[1];
      if (props?.type === 'ObjectExpression' && props.properties.some(prop => ['title','children','value'].includes(prop.key?.name) && labels.includes(prop.value?.arguments?.[0]?.value ?? prop.value?.value))) { spans.push(node); return; }
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(parse(source, { ecmaVersion: 'latest' }));
  for (const span of spans.sort((a,b) => b.start-a.start)) source = source.slice(0,span.start)+'null'+source.slice(span.end);
  return source;
}

export function patchLocalOnlyRenderer(source) {
  for (const [name, replacement] of [
    ['VoiceSettings', 'function VoiceSettings(){return jsxRuntimeExports.jsx(SettingsContentHeader,{title:"Voice",description:"Voice input, live voice, and recording transcription are unavailable in this local build."});}'],
    ['RemoteSshSettings', 'function RemoteSshSettings(){return jsxRuntimeExports.jsx(SettingsContentHeader,{title:"Connections",description:"SSH task execution is unavailable in this local build. Open a project on this device to work locally."});}'],
    ['ModelsSettings', 'function ModelsSettings(){const [model,setModel]=reactExports.useState("auto");return jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment,{children:[jsxRuntimeExports.jsx(SettingsContentHeader,{title:"Models",description:"Browse installed models, download public Hugging Face weights, or connect an optional OpenRouter key. Choose a model here to adjust its context; choose the model for a task in its composer."}),jsxRuntimeExports.jsx(NotchModelMenu,{manageOnly:true,value:model,onSelect:setModel,ariaLabel:"Browse and manage models",align:"start",side:"bottom"})]});}'],
    ['DataPrivacySettings', 'function DataPrivacySettings(){return jsxRuntimeExports.jsx(SettingsSection,{title:"Privacy",children:jsxRuntimeExports.jsx(SettingsItem,{title:"Stored on this device",description:"Tasks, notes, and site drafts are stored locally. Account telemetry and automatic diagnostic uploads are disabled. Optional model providers and web tools receive data only when you use them."})});}'],
    ['NetworkDiagnosticsSettings', 'function NetworkDiagnosticsSettings(){return jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment,{children:[jsxRuntimeExports.jsx(SettingsContentHeader,{title:"Network",description:"Configure the proxy used by optional providers and web tools."}),jsxRuntimeExports.jsx(NetworkProxySettings,{})]});}'],
    ['ComposerVoiceTool', 'function ComposerVoiceTool(){return null;}'],
    ['notchCloudAccountSettings', 'function notchCloudAccountSettings(){return null;}'],
    ['authorizedErrorActions', 'function authorizedErrorActions(e1,t1){return t1.filter(action=>!["relogin","openPricing","openUsage"].includes(action.id));}'],
  ]) if (source.includes(`function ${name}(`)) source = patchFunction(source,name,replacement);
  if (source.includes('function ChatComposer(')) source = patchFunction(source,'ChatComposer',body => {
    body = replace(body,'voiceInputEnabled:P3,','voiceInputEnabled:notchUnusedVoiceInput,');
    body = replace(body,'experimentalRecordingNoteEnabled:U8,','experimentalRecordingNoteEnabled:notchUnusedRecording,');
    body = replace(body,'}=useWorkbenchPreferences(),_8=','}=useWorkbenchPreferences(),P3=false,U8=false,_8=');
    return replace(body,'canStartLiveVoice:!d1&&!H3&&!!s1&&!K9','canStartLiveVoice:false');
  });
  if (source.includes('function InstalledExtensionsSettings(')) source = patchFunction(source,'InstalledExtensionsSettings',body => removeControls(body,['settings.installed.browseMarket']).replace('t1("extensions.noInstalledDescription")','"Extensions installed from local files appear here."'));
  if (source.includes('function ExperimentsSettings(')) source = patchFunction(source,'ExperimentsSettings',body => removeControls(body,['settings.experimentalRecordingNote','settings.experimentalVoiceDiscussion']));
  if (source.includes('function AutomationTasksView(')) source = patchFunction(source,'AutomationTasksView',body => {
    body = replace(body,'reactExports.useState("all")','reactExports.useState("local")');
    body = replace(body,'["tasks","templates","logs"].map','["tasks","logs"].map');
    return removeControls(body,['all','cloud']);
  });
  if (source.includes('class VoiceInputService') || source.includes('VoiceInputService=class')) source = patchClassMethod(source,'VoiceInputService','setConfiguration','this.configuration={...e1,enabled:false};');
  if (source.includes('class LiveVoiceService') || source.includes('LiveVoiceService=class')) source = patchClassMethod(source,'LiveVoiceService','startSession',unavailable);
  if (source.includes('class RecordingNoteService') || source.includes('RecordingNoteService=class')) source = patchClassMethod(source,'RecordingNoteService','start',unavailable);
  if (source.includes('class KeybindingService') || source.includes('KeybindingService=class')) source = patchClassMethod(source,'KeybindingService','registerKeybinding',body => {
    return replace(body,'return this.keybindings.push(t1)','if(/voice|recording|remoteControl|feedback/i.test(t1.commandId))return {dispose(){}};return this.keybindings.push(t1)');
  });
  return source;
}
