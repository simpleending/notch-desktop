import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchFunction } from '../src/bundle-patch.mjs';
import { patchSetupRenderer, patchSetupDocument, patchVoiceHardwareShutdown } from '../src/renderer-patch.mjs';

test('function replacement handles destructured defaults, regex and templates', () => {
  const source = 'function target({x=next({a:1})}={}){const r=/[{}]/;return `hi ${ {x}.x }`;}function other(){return 1;}';
  assert.equal(patchFunction(source, 'target', 'function target(){return 2;}'), 'function target(){return 2;}function other(){return 1;}');
  assert.throws(() => patchFunction(source, 'missing', ''), /Expected one/);
  assert.throws(() => patchFunction(source + source, 'target', ''), /Expected one/);
});
test('startup uses the notch wordmark and removes the inherited animated splash', () => {
  const html = '<head><style>.old-logo{animation:spin}</style></head><body><div id="notch-boot-splash"><div class="old-logo"></div></div><div id="root"></div></body>';
  const result = patchSetupDocument(html);
  assert.doesNotMatch(result, /old-logo|animation:spin/);
  assert.match(result, /notch-wordmark-dark\.svg/);
  assert.match(result, /notch-wordmark-light\.svg/);
  assert.equal(patchSetupDocument(result), result);
  assert.throws(() => patchSetupDocument('<div>changed</div>'), /document differs/);
});

const voiceController=`class VoiceHardwareTriggerController {
 constructor(client){this.client=client;const state=()=>({value:{enabled:false},get(){return this.value},set(value){this.value=value}});this.djiMicButtonValue=state();this.voiceFnShortcutValue=state();}
 syncTarget(){this.synced=true;}
 async reconcileDjiMicConfiguration(t1){const r1=t1,s1=t1;const o1=await this.client.configureDjiMicButton({enabled:r1,userAction:s1});return s1&&!o1.enabled&&(this.djiMicPermissionRequestAttempted=!1),this.djiMicButtonValue.set(o1,void 0),o1.enabled?this.syncTarget():await this.client.setDjiMicButtonTarget({scopeId:null}),o1}
 async configureVoiceFnShortcut(t1,n1){const r1=await this.client.configureVoiceFnShortcut({enabled:t1,userAction:n1});return this.voiceFnShortcutValue.set(r1,void 0),t1?this.syncTarget():await this.client.setVoiceFnShortcutTarget({scopeId:null}),r1}
}`;

test('hardware controls retain their last snapshot when shutdown cancels IPC, while real errors propagate',async()=>{
 const source=patchVoiceHardwareShutdown(voiceController);
 assert.equal(patchVoiceHardwareShutdown(source),source);
 const Controller=new Function(source+';return VoiceHardwareTriggerController;')();
 for(const [method,request,observable]of [['reconcileDjiMicConfiguration','configureDjiMicButton','djiMicButtonValue'],['configureVoiceFnShortcut','configureVoiceFnShortcut','voiceFnShortcutValue']]){
  const client={[request]:async()=>undefined},controller=new Controller(client),previous=controller[observable].get();
  assert.equal(await controller[method](true,true),previous);
  assert.equal(controller[observable].get(),previous);assert.equal(controller.synced,undefined);
  client[request]=async()=>({enabled:true});
  assert.deepEqual(await controller[method](true,true),{enabled:true});assert.equal(controller.synced,true);
  client[request]=async()=>{throw Error('hardware failure')};
  await assert.rejects(controller[method](true,true),/hardware failure/);
 }
});

const renderer = `${voiceController}function OnboardingOverlaySurface(){oldCloudSignup();}
let WorkbenchNotificationService=class{stateObs={value:{revision:0},get(){return this.value},set(value){this.value=value}};accept(e1){e1.revision<this.stateObs.get().revision||this.stateObs.set(e1,void 0)}};
function FirstLaunchOnboardingSurface({onComplete}={}){playOnboardingSoundEffect('opening');}
function getAudioElement(key){return new Audio(key);}
function preloadOnboardingSoundEffects(){getAudioElement('opening').load();}
function playOnboardingSoundEffect(key){getAudioElement(key).play();}
const urls=[${['Opening','Typing','Send','FinalSend'].map(name => `new URL("onboarding${name}-hash.wav",import.meta.url).href`).join(',')}];`;
test('setup replaces the old entry points and removes sound loading/playback', () => {
  const result = patchSetupRenderer(renderer);
  assert.match(result, /createNotchSetup\(reactExports\)/);
  assert.match(result, /createElement\(NotchSetup\)/);
  assert.doesNotMatch(result, /new Audio|\.play\(|\.load\(|oldCloudSignup|\.wav/);
  assert.equal(patchSetupRenderer(result), result);
  assert.throws(() => patchSetupRenderer(renderer.replace('onboardingOpening-hash.wav', 'different.wav')), /audio assets differ/);
  const notification = result.slice(result.indexOf('let WorkbenchNotificationService='), result.indexOf('function FirstLaunchOnboardingSurface'));
  const service = new Function(notification.replace(/const NotchSetup=[\s\S]*$/, '') + ';return new WorkbenchNotificationService;')();
  service.accept(undefined);
  service.accept({ revision: 2, current: null });
  service.accept({ revision: 1 });
  assert.equal(service.stateObs.get().revision, 2);
});
