import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { patchLocalOnlyMain, patchLocalOnlyRenderer } from '../src/local-only-patch.mjs';

const methods = {
  Mae:['initialize','capabilities'],gae:['getOrganizationContext','getAccountPlan','readAccountUsage','getAccountCreditsHeatmap','getAccountProfileMetrics','requestOpenApi'],
  vne:['ensureReady','refreshOrThrow','getValue'],DAe:['initialize','listConfigs'],Mne:['request'],one:['ensureReady','refreshViewOnce','execute'],
  qAe:['initialize','configure','refresh','requestWithToken'],VAe:['initialize','setEnabled','start'],nde:['start','sendAudio','stop','shutdown'],Ade:['startSession','withVoiceprintConnection','getCapabilities','waitUntilReady','sendAudio','completeToolCall','sendContext','cancelResponse','setMicrophoneEnabled','setPlaybackEnabled','stopSession','drainAndStop','hasVoiceprint','deleteVoiceprint'],
  loe:['constructor','getAvailability','connectHost','connectLocalAgent','connect'],
  uue:['initialize'],eAe:['upload'],eue:['marketplaceProfiles','prepareMarketplaceConnector'],gce:['listMarket','getMarketDetail','listEducationRecommendations','refreshSkillMarketMetadata','queueMarketplaceIconHydration','install'],Yde:['initialize'],OZ:['fetchAssignment'],Eue:['listCategories','list','get'],Rne:['run'],wne:['target'],
};
const fixture='function bg(){return Vn().features;}'+Object.entries(methods).map(([name,names])=>`class ${name}{${names.map(method=>`${method==='constructor'?'':'async '}${method}(${name==='loe'&&method==='connectLocalAgent'?'t':'t,e'}){${method==='constructor'?'':'throw Error("legacy authentication was read");'}}`).join('')} ${name==='one'?'acceptIdentity(){const t="local",e=null,r="old",i=!Av()&&!!t&&!!r;this.available=i;}':''}}`).join('\n');
const load = () => new Function('Vn','Av',patchLocalOnlyMain(fixture)+`;return {bg,${Object.keys(methods).join(',')}};`)(()=>({features:{cloudAutomations:true,cloudCollaborationEnabled:true,issuesEnabled:true}}),()=>false);

test('retired services cannot read credentials, send requests, or revive persisted remote-control settings',async()=>{
  const types=load(),context={publish(){},getSnapshot(){return {enabled:this.enabled};},currentIdentity(){return 'local';},defaults:{},value:{set(value){assert.equal(value.cloudCollaborationEnabled,false);}}};
  await types.Mae.prototype.initialize.call(context);
  assert.equal((await types.Mae.prototype.capabilities.call(context)).cloudCollaborationEnabled,false);
  assert.equal(types.bg().cloudAutomations,false); assert.equal(types.bg().issuesEnabled,false);
  assert.equal(await types.gae.prototype.getOrganizationContext(),null);
  assert.equal((await types.Mne.prototype.request()).shareEnabled,false);
  assert.equal(await types.vne.prototype.getValue(),undefined); await types.vne.prototype.ensureReady();
  assert.deepEqual(await types.eue.prototype.marketplaceProfiles(),[]);
  assert.equal((await types.loe.prototype.getAvailability()).supported,true);
  await assert.rejects(types.loe.prototype.connectHost(),/unavailable in the local edition/);
  await assert.rejects(types.gce.prototype.install({source:'market'}),/unavailable in the local edition/);
  await assert.rejects(types.gce.prototype.install({source:'local'}),/legacy authentication was read/);
  await types.VAe.prototype.initialize.call(context);assert.equal(context.enabled,false);
  await assert.rejects(types.VAe.prototype.setEnabled.call(context,true),/unavailable in the local edition/);
  for(const [name,method]of [['Ade','withVoiceprintConnection'],['qAe','configure'],['qAe','requestWithToken'],['eAe','upload'],['OZ','fetchAssignment'],['Rne','run'],['gae','requestOpenApi']])await assert.rejects(types[name].prototype[method](),/unavailable in the local edition/);
  const automation=new types.one();automation.acceptIdentity();assert.equal(automation.available,false);
  assert.equal(await types.wne.prototype.target(),'https://openrouter.ai/api/v1/models');
  assert.equal(patchLocalOnlyMain(patchLocalOnlyMain(fixture)),patchLocalOnlyMain(fixture));
  assert.throws(()=>patchLocalOnlyMain(fixture.replace('i=!Av()&&!!t&&!!r','i=changed')),/anchor changed/);
});

test('local edition restores voice controls while removing account actions',()=>{
  const source=`function VoiceSettings(){readVoiceprint();} function DataPrivacySettings(){readCloudPolicy();}
    function NetworkDiagnosticsSettings(){probeRetiredServices();} function authorizedErrorActions(){return [];} function notchCloudAccountSettings(){readCloudToken();}
    function ChatComposer(){const {voiceInputEnabled:P3,experimentalRecordingNoteEnabled:U8,}=useWorkbenchPreferences(),_8={canStartLiveVoice:!d1&&!H3&&!!s1&&!K9};return {P3,U8,..._8};}
    let VoiceInputService=class{setConfiguration(e1){readMicrophone();}async start(e1){const i1=++this.operation;try{if(await this.client.prepareVoiceInput(),i1!==this.operation)return;}catch{}}}; let LiveVoiceService=class{async startSession(e1,t1,n1,r1,i1="live",s1){captureMicrophone();}}; let RecordingNoteService=class{async start(e1){captureMicrophone();}};
    let KeybindingService=class{registerKeybinding(e1){const t1={commandId:e1.command};return this.keybindings.push(t1);}};`;
  const patched=patchLocalOnlyRenderer(source);parse(patched,{ecmaVersion:'latest'});
  assert.doesNotMatch(patched,/readCloud|readVoiceprint|probeRetired|captureMicrophone|readMicrophone/);
  const types=new Function('useWorkbenchPreferences','d1','H3','s1','K9',patched+';return {ChatComposer,authorizedErrorActions,VoiceInputService,LiveVoiceService,KeybindingService};')(()=>({voiceInputEnabled:true,experimentalRecordingNoteEnabled:true}),false,false,true,false);
  assert.deepEqual(types.ChatComposer(),{P3:true,U8:true,canStartLiveVoice:true});
  assert.deepEqual(types.authorizedErrorActions(null,[{id:'relogin'},{id:'openPricing'},{id:'retry'}]),[{id:'retry'}]);
  const voice=new types.VoiceInputService();voice.hardwareTriggerController={configureSingleShortcut(){},configureComboShortcut(){}};voice.setConfiguration({enabled:true});assert.equal(voice.configuration.enabled,true);
  const keys=new types.KeybindingService();keys.keybindings=[];keys.registerKeybinding({command:'chat.startLiveVoice'});keys.registerKeybinding({command:'app.feedback'});keys.registerKeybinding({command:'app.newTask'});assert.equal(keys.keybindings.length,2);
  assert.equal(patchLocalOnlyRenderer(patched),patched);
});

test('Live Voice starts without credentials and persists final transcripts through the native task store',async t=>{
  const previous=globalThis.__notchHost;t.after(()=>{globalThis.__notchHost=previous});let listener,persisted;
  globalThis.__notchHost={voice:{async ensureReady(){}},createLiveVoice(_voice,options,emit){assert.equal(options.chatSessionId,'task');listener=emit;return {stop(){}};}};
  const types=load(),context={chatSessionService:{async ensureLiveVoiceSession(){return {voiceSessionId:'local-voice'}}},eventEmitter:{fire(){}},persistTranscript(session,entry){persisted={session,entry}}};
  assert.equal(await types.Ade.prototype.startSession.call(context,{chatSessionId:'task'}),'local-voice');
  const entry={id:'speech',role:'user',text:'local request',final:true};listener({type:'transcript',entry});
  assert.equal(persisted.session.chatSessionId,'task');assert.deepEqual(persisted.entry,entry);
});

test('marketplace and remote automation controls are removed; local recording notes remain',()=>{
  const source=`function InstalledExtensionsSettings(){return jsx.jsxs(Header,{action:jsx.jsx(Button,{children:t('settings.installed.browseMarket'),onClick:cloudMarket}),children:jsx.jsx(Button,{children:'Add',onClick:localInstall})});}
    function ExperimentsSettings(){return jsx.jsxs(Group,{children:[jsx.jsx(SettingsItem,{title:t('settings.experimentalRecordingNote'),control:cloudRecord}),jsx.jsx(SettingsItem,{title:'Local notes',control:localNote})]});}
    function AutomationTasksView(){const state=reactExports.useState("all"),tabs=["tasks","templates","logs"].map(draw);return jsx.jsxs(Group,{children:[jsx.jsx(TabsTrigger,{value:'all'}),jsx.jsx(TabsTrigger,{value:'cloud'}),jsx.jsx(TabsTrigger,{value:'local'})]});}`;
  const patched=patchLocalOnlyRenderer(source);parse(patched,{ecmaVersion:'latest'});
  assert.doesNotMatch(patched,/cloudMarket|cloudRecord|value:'cloud'|value:'all'/);
  assert.match(patched,/"templates"/);
  assert.match(patched,/localInstall/);assert.match(patched,/settings.experimentalRecordingNote/);assert.match(patched,/value:'local'/);assert.match(patched,/useState\("local"\)/);
  assert.equal(patchLocalOnlyRenderer(patched),patched);
});
