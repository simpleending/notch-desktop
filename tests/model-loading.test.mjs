import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {patchModelLoading} from '../src/model-loading-patch.mjs';
import {withModelActivity,modelActivityBusy,useModelActivity,createModelLoadingDots} from '../src/model-activity.mjs';

const original=await fs.readFile(new URL('./fixtures/composer-model-loading.js',import.meta.url),'utf8');
const patched=patchModelLoading(original).replace(/^import .*$/m,'');
function selector({enabled=false,missing=false,loading=false,error=null,busy=false,key='colibri/test',host='local',source=patched}={}) {
  const model={key,enabled},state={models:missing?[]:[model],selectedModel:key,isLoading:loading,error};
  const service={modelForRuntime:()=>state,modelPreferencesObs:{preferences:[]},loadModels(){},loadModelPreferences(){},refresh(){}};
  return vm.runInNewContext(source+';useChatModelSelector({modelPreferencesConfigurable:false,executionHostKind:'+JSON.stringify(host)+'})',{
    reactExports:{useMemo:fn=>fn(),useCallback:fn=>fn,useEffect(){},createElement:(type,props)=>({type,props})},
    useTranslation:()=>({t:key=>key,i18n:{}}),useServices:()=>({chatComposerService:service}),useOptionalObservableValue:()=>({}),EMPTY_DYNAMIC_TEXT_STATE:{},resolveDynamicTextLanguage$1:()=> 'en',useObservableValue:v=>v,
    useModelActivity:()=>busy,createModelLoadingDots:()=>function Dots(){},chatModelToSelectorOption:row=>({value:row.key}),
  });
}

test('a disabled cached model is pending during discovery instead of prematurely unavailable',()=>{
  assert.equal(selector({source:original,loading:true}).modelError,'composer.model.sessionUnavailable');
  for(const missing of [false,true]){
    const result=selector({loading:true,missing});
    assert.equal(result.modelLoading,true);assert.equal(result.modelError,null);assert.equal(result.canSend,false);
  }
  assert.equal(patchModelLoading(patchModelLoading(original)),patchModelLoading(original));
});

test('all local engines show pending during mount, remount, eject and switching; cloud and remote stay independent',()=>{
  for(const provider of ['ollama','colibri','strata','mlx']){
    const result=selector({key:provider+'/test',busy:true,enabled:true});
    assert.equal(result.modelLoading,true);assert.equal(result.modelError,null);assert.equal(result.canSend,false);
  }
  assert.equal(selector({key:'openrouter/test',busy:true,enabled:true}).modelLoading,false);
  assert.equal(selector({host:'ssh',busy:true,enabled:true}).modelLoading,false);
});

test('settled discovery and mount failures still show errors, while a ready model can send',()=>{
  assert.equal(selector().modelError,'composer.model.sessionUnavailable');
  assert.equal(selector({missing:true,error:'discovery failed'}).modelError,'composer.model.loadFailed');
  assert.equal(selector({missing:true,error:'discovery failed',busy:true}).modelError,null);
  const ready=selector({enabled:true});assert.equal(ready.modelLoading,false);assert.equal(ready.modelError,null);assert.equal(ready.canSend,true);
});

test('background revalidation preserves readiness only for an enabled selected model',()=>{
  const probe='function preserve(s1){return {preserveReadyState:s1.get().models.length>0}}';
  const source=patchModelLoading(original+'\n'+probe).replace(/^import .*$/m,'');
  for(const enabled of [false,true]){
    const s1={get:()=>({selectedModel:'ollama/test',models:[{key:'ollama/test',enabled}]})};
    assert.equal(vm.runInNewContext(source+';preserve(s1)',{s1,createModelLoadingDots:()=>null,reactExports:{}}).preserveReadyState,enabled);
  }
});

test('activity stays pending through catalog reconciliation and clears on failure, including refresh failure',async()=>{
  let finish,unsubscribe;const events=[],cleanups=[];
  const React={useEffect:fn=>cleanups.push(fn()),useSyncExternalStore:(subscribe,snapshot)=>{unsubscribe=subscribe(()=>events.push(snapshot()));return snapshot();}};
  useModelActivity(React,()=>new Promise(resolve=>finish=resolve));
  const result=withModelActivity(async()=>42);await new Promise(resolve=>setImmediate(resolve));assert.equal(modelActivityBusy(),true);
  finish();assert.equal(await result,42);assert.equal(modelActivityBusy(),false);assert.deepEqual(events,[true,false]);
  cleanups.forEach(fn=>fn?.());unsubscribe();
  useModelActivity({...React,useSyncExternalStore:(_subscribe,snapshot)=>snapshot()},()=>{throw Error('refresh failed');});
  await assert.rejects(withModelActivity(async()=>{throw Error('engine failed');}),/engine failed/);
  assert.equal(modelActivityBusy(),false);cleanups.forEach(fn=>fn?.());
});

test('loading dots are accessible and replace the warning above the composer only while pending',()=>{
  const React={createElement:(type,props,...children)=>({type,props,children})};
  const dots=createModelLoadingDots(React)();assert.equal(dots.props.role,'status');assert.equal(dots.props['aria-label'],'Preparing model');assert.equal(dots.children.length,3);assert(dots.children.every(dot=>dot.props['aria-hidden']));
  const context={reactExports:React,createModelLoadingDots,jsxRuntimeExports:{jsx:React.createElement},SuggestionBanner:'warning'};
  const component=patched.slice(patched.indexOf('function ChatComposer('));
  assert.equal(vm.runInNewContext(component+';ChatComposer({modelLoading:true,modelError:"unavailable"})',context).type.name,'ModelLoadingDots');
  assert.equal(vm.runInNewContext(component+';ChatComposer({modelLoading:false,modelError:"unavailable"})',{...context}).type,'warning');
});
