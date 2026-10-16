import originals from './local-service-originals.json' with { type: 'json' };
import { patchClassMethod, patchFunction } from './bundle-patch.mjs';

const body = method => method.slice(method.indexOf('{') + 1, -1);
function replaceAnchor(source,before,after){if(source.includes(after))return source;if(source.split(before).length!==2)throw Error('Local service integration anchor changed.');return source.replace(before,after);}

const voiceSettings = `function VoiceSettings(){
 const [status,setStatus]=reactExports.useState(null),[error,setError]=reactExports.useState(null);
 const prefs=useWorkbenchPreferences();const {liveVoiceService}=useServices();
 const [rate,setRate]=reactExports.useState(()=>liveVoiceService.getSettings().speechRate);
 reactExports.useEffect(()=>{let closed=false;const poll=()=>window.notchModels.voice().then(value=>{if(!closed)setStatus(value)}).catch(error=>{if(!closed)setError(error.message)});poll();const timer=setInterval(poll,1000);return()=>{closed=true;clearInterval(timer)}},[]);
 const install=async()=>{try{setError(null);setStatus(await window.notchModels.voiceInstall())}catch(error){setError(error.message)}};
 return jsxRuntimeExports.jsxs("div",{children:[
 jsxRuntimeExports.jsx(SettingsContentHeader,{title:"Voice",description:"Dictation, recording notes, and Live Voice run on this device. Whisper transcribes microphone audio locally. Live Voice uses the task's selected model and permissions; choose a local model to keep inference on this device."}),
 jsxRuntimeExports.jsx(SettingsSection,{title:"Local speech engine",children:jsxRuntimeExports.jsx(SettingsItem,{title:status?.ready?"Whisper is ready":"Install local voice",description:error||status?.error||(status?.phase==="downloading"?"Downloading verified speech runtime and model: "+Math.round(status.bytes/1000000)+" MB":"One download of about 157 MB from GitHub and Hugging Face. After setup, transcription works offline. Speech output uses the Windows voice installed on this device."),control:status?.ready?jsxRuntimeExports.jsx("span",{role:"status",children:"Ready — no account required"}):status?.phase==="downloading"?jsxRuntimeExports.jsx(Button,{onClick:()=>window.notchModels.voiceCancel().then(setStatus),children:"Cancel download"}):jsxRuntimeExports.jsx(Button,{onClick:install,disabled:!status?.supported,children:"Install speech engine"})})}),
 jsxRuntimeExports.jsx(SettingsSection,{title:"Dictation",children:jsxRuntimeExports.jsx(SettingsItem,{title:"Voice input",description:"Use the microphone in the composer. The transcript appears when you stop, with updates during longer recordings.",control:jsxRuntimeExports.jsx(Switch,{"aria-label":"Enable voice input",checked:prefs.voiceInputEnabled,onCheckedChange:prefs.setVoiceInputEnabled})})}),
 jsxRuntimeExports.jsx(VoiceInputRecognitionSettings,{section:"general"}),
 jsxRuntimeExports.jsx(SettingsSection,{title:"Recognition and history",children:jsxRuntimeExports.jsx(VoiceInputRecognitionSettings,{section:"recognition"})}),
 jsxRuntimeExports.jsx(SettingsSection,{title:"Live Voice",children:jsxRuntimeExports.jsx(SettingsItem,{title:"Speech speed",description:"Speak a request, pause, and hear the task's reply. Tool approvals remain in the task. Use the microphone toggle to pause listening.",control:jsxRuntimeExports.jsx("select",{"aria-label":"Local speech speed",value:rate,onChange:event=>{setRate(event.target.value);liveVoiceService.updateSettings({speechRate:event.target.value})},children:["slow","normal","fast"].map(value=>jsxRuntimeExports.jsx("option",{value,children:value},value))})})}),
 jsxRuntimeExports.jsx(RecordingNoteSettingsSection,{})]});}`;

export function patchLocalServicesRenderer(source) {
  for (const [name, implementation] of Object.entries(originals.renderer.functions)) if (source.includes(`function ${name}(`)) source = patchFunction(source, name, implementation);
  if (source.includes('function VoiceSettings(')) source = patchFunction(source, 'VoiceSettings', voiceSettings);
  for (const [name, methods] of Object.entries(originals.renderer.methods)) if (source.includes(`class ${name}`) || source.includes(`${name}=class`)) {
    for (const [method, implementation] of Object.entries(methods)) source = patchClassMethod(source, name, method, body(implementation));
  }
  if(source.includes('class ChatSessionService')||source.includes('ChatSessionService=class'))source=patchClassMethod(source,'ChatSessionService','upsertLiveVoiceTranscript',text=>text.replace('if(this.sessionIdValue.get()!==e1||this.summaryValue.get()?.conversationMode!=="voice")','if(this.sessionIdValue.get()!==e1)'));
  if (source.includes('function ChatComposer(')) source = patchFunction(source, 'ChatComposer', text => text
    .replace('liveVoiceTarget:s1,', 'liveVoiceTarget:s1=t1?{chatSessionId:t1}:undefined,')
    .replace('voiceInputEnabled:notchUnusedVoiceInput,', 'voiceInputEnabled:P3,')
    .replace('experimentalRecordingNoteEnabled:notchUnusedRecording,', 'experimentalRecordingNoteEnabled:U8,')
    .replace('}=useWorkbenchPreferences(),P3=false,U8=false,_8=', '}=useWorkbenchPreferences(),_8=')
    .replace('canStartLiveVoice:false', 'canStartLiveVoice:!d1&&!H3&&!!s1&&!K9'));
  if (source.includes('class KeybindingService') || source.includes('KeybindingService=class')) source = patchClassMethod(source, 'KeybindingService', 'registerKeybinding', text => text.replace('/voice|recording|remoteControl|feedback/i', '/remoteControl|feedback/i'));
  return source;
}
export function patchLocalServicesMain(source) {
  if(source.includes('function hv('))source=patchFunction(source,'hv','function hv(t){return t.host.kind==="ssh"?"ssh-local-agent":t.mode??"local";}');
  if(source.includes('class yLt')||source.includes('yLt=class'))source=patchClassMethod(source,'yLt','run',text=>replaceAnchor(text,'r.once("exit",p=>','r.once("close",p=>'));
  if(source.includes('class Nnr')||source.includes('Nnr=class')){
    source=patchClassMethod(source,'Nnr','ensureLiveVoiceSession',text=>replaceAnchor(text,'if(i){if(i.conversationMode!=="voice")throw new Error("普通会话不能升级为实时语音会话，请从 New Chat 创建语音会话。");return{summary:this.options.withRuntime(i)','if(i){return{summary:this.options.withRuntime(i)'));
    source=patchClassMethod(source,'Nnr','appendLiveVoiceTranscript',text=>replaceAnchor(text,'if(!r||r.conversationMode!=="voice")throw new Error("实时语音会话不存在。");','if(!r)throw new Error("实时语音会话不存在。");'));
  }
  for (const [name, method, implementation] of [
    ['loe', 'constructor', text => text.includes('globalThis.__notchHost.remoteSsh=this') ? text : text + ';this.forcePreferredThin=true;globalThis.__notchHost.remoteSsh=this;'],
    ['loe', 'getAvailability', 'return {supported:true};'],
    ['loe', 'connectLocalAgent', body(originals.main.loe.connectLocalAgent)],
    ['loe', 'connect', 'return this.connectLocalAgent(t);'],
    ['nde', 'start', 'if(this.notchSessionId)await this.stop(this.notchSessionId,false);const id=await globalThis.__notchHost.voice.startRecognition(event=>this.eventEmitter.fire(event),t);this.notchSessionId=id;return id;'],
    ['nde', 'sendAudio', 'return globalThis.__notchHost.voice.sendRecognition(t,e);'],
    ['nde', 'stop', 'await globalThis.__notchHost.voice.stopRecognition(t,e);if(this.notchSessionId===t)this.notchSessionId=undefined;'],
    ['nde', 'shutdown', 'if(this.notchSessionId)await this.stop(this.notchSessionId,false);'],
    ['Ade', 'startSession', 'await globalThis.__notchHost.voice.ensureReady();if(this.notchLocalVoice)await this.stop(this.activeSession.voiceSessionId);if(t.mode==="discussion")throw new Error("Start local Live Voice from a task.");const {voiceSessionId:id}=await this.chatSessionService.ensureLiveVoiceSession(t.chatSessionId,t.createSession);const context={voiceSessionId:id,chatSessionId:t.chatSessionId,mode:"live",transport:"legacy"};this.activeSession=context;this.notchLocalVoice=globalThis.__notchHost.createLiveVoice(globalThis.__notchHost.voice,{...t,voiceSessionId:id},event=>{this.eventEmitter.fire(event);if(event.type==="transcript"&&event.entry.final)this.persistTranscript(context,event.entry);});return id;'],
    ['Ade', 'waitUntilReady', 'if(this.activeSession?.voiceSessionId!==t)throw new Error("Local voice session ended.");return "legacy";'],
    ['Ade', 'sendAudio', 'return this.activeSession?.voiceSessionId===t?this.notchLocalVoice?.sendAudio(e)??false:false;'],
    ['Ade', 'completeToolCall', 'return this.activeSession?.voiceSessionId===t.voiceSessionId?this.notchLocalVoice?.completeToolCall(t)??false:false;'],
    ['Ade', 'sendContext', 'return this.activeSession?.voiceSessionId===t.voiceSessionId?this.notchLocalVoice?.sendContext(t)??false:false;'],
    ['Ade', 'cancelResponse', 'return this.activeSession?.voiceSessionId===t?this.notchLocalVoice?.cancelResponse()??false:false;'],
    ['Ade', 'setMicrophoneEnabled', 'return this.activeSession?.voiceSessionId===t.voiceSessionId?this.notchLocalVoice?.setMicrophoneEnabled(t.enabled)??false:false;'],
    ['Ade', 'setPlaybackEnabled', 'return this.activeSession?.voiceSessionId===t.voiceSessionId?this.notchLocalVoice?.setPlaybackEnabled(t.enabled)??false:false;'],
    ['Ade', 'stopSession', 'if(this.activeSession?.voiceSessionId===t){this.notchLocalVoice?.stop();this.notchLocalVoice=undefined;this.activeSession=undefined;}'],
    ['Ade', 'drainAndStop', 'await this.stopSession(t,"user");'],
    ['Ade', 'hasVoiceprint', 'return false;'],
    ['Ade', 'deleteVoiceprint', 'return;'],
  ]) source = patchClassMethod(source, name, method, implementation);
  return source;
}
