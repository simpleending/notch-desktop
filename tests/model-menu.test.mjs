import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isModelSelectable, fallbackCandidates, readyModels, modelSource, createModelMenu, needsLocalModelSetup} from '../src/model-menu.mjs';
import {createLoadingSkeleton} from '../src/loading-skeleton.mjs';
import {createUpdateSettings} from '../src/update-settings-view.mjs';
import {createVoiceModels} from '../src/voice-model-picker.mjs';

test('freshly discovered models wait for the composer catalog instead of selecting missing keys',()=>{
  const row={key:'ollama/new-model',enabled:true},options=[{value:row.key,disabled:false}];
  assert.equal(isModelSelectable(row,[]),false);
  assert.equal(isModelSelectable(row,options,true),false);
  assert.equal(isModelSelectable(row,options),true);
  assert.equal(isModelSelectable(row,[{value:row.key,disabled:true}]),false);
  assert.equal(isModelSelectable({...row,enabled:false},options),false);
});
test('OpenRouter fallback candidates omit the primary, the current chain, and models without tools',()=>{
  const rows=[
    {key:'openrouter/lab/primary',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/fast',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/floor',provider:'openrouter',enabled:true,tools:true},
    {key:'openrouter/lab/chat',provider:'openrouter',enabled:true,tools:false},
    {key:'ollama/local',provider:'ollama',enabled:true},
  ];
  assert.deepEqual(fallbackCandidates(rows,'openrouter/lab/primary',['openrouter/lab/fast']).map(row=>row.key),['openrouter/lab/floor']);
});

const local={key:'ollama/local',displayName:'Local coder',provider:'ollama',enabled:true,bytes:2**30,defaultContextWindow:8192,availableContextWindows:[8192]};
const cloud={...local,key:'openrouter/lab/cloud',displayName:'Cloud coder',provider:'openrouter',bytes:undefined};
const colibri={...local,key:'colibri/coder',displayName:'Disk coder',provider:'colibri'};
const options=[local,cloud,colibri].map(row=>({value:row.key}));

test('model setup waits for discovery and offers setup when no usable local model was found',()=>{
  assert.equal(needsLocalModelSetup(null),false);
  assert.equal(needsLocalModelSetup({models:[],discoveryWarning:'offline'}),false);
  assert.equal(needsLocalModelSetup({models:[cloud]}),true);
  assert.equal(needsLocalModelSetup({models:[local]}),false);
  assert.equal(needsLocalModelSetup({models:[{...local,enabled:false}]}),true);
});

test('ready models combine engines and cloud, exclude unavailable choices, and search names and sources',()=>{
  const rows=[local,cloud,colibri,{...local,key:'ollama/missing'},{...cloud,key:'openrouter/disconnected',enabled:false},{...local,key:'ollama/chat',tools:false}];
  assert.deepEqual(readyModels(rows,[...options,{value:'ollama/chat'}]).map(row=>row.key),options.map(row=>row.value));
  assert.deepEqual(readyModels(rows,options,{query:'openrouter'}),[cloud]);
  assert.deepEqual(readyModels(rows,options,{query:' disk '}),[colibri]);
  assert.deepEqual(readyModels(rows,[{value:local.key,disabled:true}]),[]);
  assert.equal(modelSource(colibri),'Local · Colibri (experimental)');
});

test('current and recent models come first without changing inventory order',()=>{
  const rows=[local,cloud,colibri];
  assert.deepEqual(readyModels(rows,options,{current:colibri.key,recent:[cloud.key,colibri.key,'retired']}).map(row=>row.key),[colibri.key,cloud.key,local.key]);
  assert.deepEqual(rows,[local,cloud,colibri]);
});

// Exercise hook state and event callbacks without launching or controlling the user's desktop.
function renderHooks(factory,props={}) {
  const slots=[],pending=[];let cursor=0,dirty=true,tree;
  const React={
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    Fragment:'fragment',
    useState(initial){const slot=slots[cursor++]??= {value:typeof initial==='function'?initial():initial};return [slot.value,value=>{const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;dirty=true;}}];},
    useRef(value){return slots[cursor++]??= {current:value};},
    useId(){return this.useRef('model-test').current;},
    useEffect(effect,deps){const index=cursor++,previous=slots[index];if(!previous||!deps||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]))){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[index].cleanup?.();slots[index].cleanup=effect();});}},
  };
  const Component=factory(React);
  const render=()=>{cursor=0;dirty=false;tree=Component(props);while(pending.length)pending.shift()();return tree;};
  return {
    render,
    async settle(){for(let i=0;i<12;i++){render();await new Promise(resolve=>setImmediate(resolve));if(!dirty)return tree;}throw Error('Render did not settle');},
    find(predicate){const found=[];const visit=node=>{if(!node||typeof node!=='object')return;if(predicate(node))found.push(node);for(const child of node.children||[])visit(child);};visit(tree);return found;},
    dispose(){for(const slot of slots)slot?.cleanup?.();},
  };
}
const content=node=>typeof node==='string'?node:(node?.children||[]).map(content).join('');
const button=(ui,label)=>ui.find(node=>node.type==='button'&&content(node)===label)[0];
function menu(t,api={},props={}) {
  const previousWindow=globalThis.window,previousStorage=globalThis.localStorage;
  const saved=new Map();
  globalThis.localStorage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  globalThis.window={notchModels:{state:async()=>({models:[local,cloud,colibri],openrouter:true}),runtime:async()=>({models:[local,cloud,colibri],openrouter:true,loaded:true}),cloud:async()=>[cloud],...api}};
  const ui=renderHooks(React=>createModelMenu(React,{Popover:'popover',PopoverTrigger:'trigger',PopoverContent:'content'},()=>({resolvedTheme:'notch-dark'})),{open:true,value:cloud.key,options,onSelect(){},...props});
  t.after(()=>{ui.dispose();globalThis.window=previousWindow;globalThis.localStorage=previousStorage;});
  return {ui,saved};
}

test('empty local inventory automatically opens Manage models once and respects dismissal',async t=>{
  const {ui}=menu(t,{state:async()=>({models:[]})},{open:undefined});
  await ui.settle();
  assert.equal(ui.find(node=>node.type==='popover')[0].props.open,true);
  assert(ui.find(node=>node.type==='strong'&&content(node)==='Manage models').length);
  assert.equal(ui.find(node=>node.props.role==='tab'&&node.props['aria-selected'])[0].props.id,'model-test-installed');
  ui.find(node=>node.type==='popover')[0].props.onOpenChange(false);
  await ui.settle();
  assert.equal(ui.find(node=>node.type==='popover')[0].props.open,false);
});

test('composer opens one ready list, selects a model, and remembers it without loading remote catalogs',async t=>{
  let catalogs=0,selected,closed;
  const {ui,saved}=menu(t,{cloud:async()=>{catalogs++;return [cloud];}},{onSelect:key=>selected=key,onOpenChange:open=>closed=open});
  await ui.settle();
  assert.equal(ui.find(node=>node.props.role==='tab').length,0);
  const rows=ui.find(node=>node.props.role==='option');
  assert.deepEqual(rows.map(node=>node.props.title),[cloud.key,local.key,colibri.key]);
  assert.equal(rows[0].props['aria-selected'],true);
  assert.equal(ui.find(node=>node.props.className==='notch-model-source').length,3);
  assert.equal(catalogs,0);
  rows[1].props.onClick();
  await ui.settle();
  assert.equal(selected,local.key);assert.equal(closed,false);
  assert.deepEqual(JSON.parse(saved.get('notch.models.recent')),[local.key]);
});

test('management preserves tabs and context controls, and Back clears the search',async t=>{
  const {ui}=menu(t);
  await ui.settle();button(ui,'Manage models…').props.onClick();await ui.settle();
  assert.deepEqual(ui.find(node=>node.props.role==='tab').map(content),['Installed','Hugging Face','OpenRouter','Colibri','Strata']);
  button(ui,'OpenRouter').props.onClick();await ui.settle();
  assert.equal(ui.find(node=>node.props['aria-label']==='Context limit').length,1);
  ui.find(node=>node.type==='input'&&node.props.type==='search')[0].props.onChange({target:{value:'no match'}});await ui.settle();
  assert.equal(ui.find(node=>node.props.role==='option').length,0);
  button(ui,'← Back to models').props.onClick();await ui.settle();
  assert.equal(ui.find(node=>node.props.role==='tab').length,0);
  assert.equal(ui.find(node=>node.props.role==='option').length,3);
});

test('local selection waits for loading, and selecting a loaded model ejects without changing the selected model',async t=>{
 let resolve,selected;const calls=[];
 const {ui}=menu(t,{runtime:async(action,key)=>{calls.push([action,key]);return new Promise(done=>{resolve=done;});}},{onSelect:key=>selected=key});
 await ui.settle();ui.find(node=>node.props.title===local.key&&node.props.role==='option')[0].props.onClick();await ui.settle();
 assert.equal(selected,undefined);assert.deepEqual(calls,[['toggle',local.key]]);assert(button(ui,'Refresh').props.disabled);
 resolve({models:[{...local,running:true},cloud,colibri],loaded:true});await ui.settle();assert.equal(selected,local.key);
});

test('eject controls appear in the picker and management, preserve selection, and report load failures',async t=>{
 let selected;const calls=[],mounted={...local,running:true};
 const {ui}=menu(t,{state:async()=>({models:[mounted,cloud,colibri]}),runtime:async(action,key)=>{calls.push([action,key]);return{models:[local,cloud,colibri],loaded:false};}},{onSelect:key=>selected=key});
 await ui.settle();assert.equal(ui.find(node=>node.props['aria-label']==='Eject Local coder').length,1);
  ui.find(node=>node.props.role==='option'&&node.props.title===local.key)[0].props.onClick();await ui.settle();
  assert.deepEqual(calls,[['toggle',local.key]]);assert.equal(selected,undefined);
  button(ui,'Refresh').props.onClick();await ui.settle();
 button(ui,'Manage models…').props.onClick();await ui.settle();assert.equal(ui.find(node=>node.props['aria-label']==='Eject Local coder').length,1);
 ui.find(node=>node.props['aria-label']==='Eject Local coder')[0].props.onClick();await ui.settle();
  assert.deepEqual(calls,[['toggle',local.key],['eject',local.key]]);assert.equal(selected,undefined);assert.equal(ui.find(node=>node.props['aria-label']==='Eject Local coder').length,0);
});

test('a failed load keeps the previous selection and makes the error and retry controls available',async t=>{
 let selected;const {ui}=menu(t,{runtime:async()=>{throw Error('The model did not finish loading.');}},{onSelect:key=>selected=key});
 await ui.settle();ui.find(node=>node.props.role==='option'&&node.props.title===local.key)[0].props.onClick();await ui.settle();
 assert.equal(selected,undefined);assert.equal(button(ui,'Refresh').props.disabled,false);assert(ui.find(node=>node.props.role==='alert').length);
});

test('management settings still open directly on the existing tabs',async t=>{
  const {ui}=menu(t,{}, {manageOnly:true});await ui.settle();
  assert.equal(ui.find(node=>node.props.role==='tab').length,5);
  assert.equal(button(ui,'← Back to models'),undefined);
});

test('initial failure removes skeletons and keeps Refresh and management available',async t=>{
  const {ui}=menu(t,{state:async()=>{throw Error('Discovery failed');}});
  ui.render();assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,1);
  await ui.settle();
  assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,0);
  assert.equal(ui.find(node=>node.props.role==='alert').length,1);
  assert.equal(button(ui,'Refresh').props.disabled,false);
  assert.ok(button(ui,'Manage models…'));
});

test('refresh preserves existing rows instead of replacing them with skeletons',async t=>{
  let resolve,refresh=false;
  const {ui}=menu(t,{state:async()=>refresh?new Promise(done=>resolve=done):{models:[local,cloud,colibri]}});
  await ui.settle();refresh=true;button(ui,'Refresh').props.onClick();await ui.settle();
  assert.equal(ui.find(node=>node.props.role==='option').length,3);
  assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,0);
  assert.equal(ui.find(node=>node.props.role==='listbox')[0].props['aria-busy'],true);
  resolve({models:[local,cloud,colibri]});await ui.settle();
  assert.equal(button(ui,'Refresh').props.disabled,false);
});

test('skeletons reserve rows immediately, delay their appearance, and cancel on unmount',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const ui=renderHooks(createLoadingSkeleton,{label:'Loading models…',rows:3});
  assert.equal(ui.render().props['data-visible'],false);
  assert.equal(ui.find(node=>node.props['aria-hidden']===true).length,3);
  t.mock.timers.tick(179);assert.equal(ui.render().props['data-visible'],false);
  t.mock.timers.tick(1);assert.equal(ui.render().props['data-visible'],true);
  ui.dispose();
  const cancelled=renderHooks(createLoadingSkeleton);cancelled.render();cancelled.dispose();
  t.mock.timers.tick(180);assert.equal(cancelled.render().props['data-visible'],false);
});

test('update settings remove their initial skeleton after a failed request',async t=>{
  const previous=globalThis.window;globalThis.window={notchModels:{updates:async()=>{throw Error('Offline');}}};
  const ui=renderHooks(createUpdateSettings);t.after(()=>{ui.dispose();globalThis.window=previous;});
  ui.render();assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,1);
  await ui.settle();assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,0);
  assert.equal(ui.find(node=>node.props.role==='alert').length,1);
});

test('speech settings show unavailable models instead of leaving an endless skeleton',async t=>{
  const previous=globalThis.window;
  globalThis.window={notchModels:{voice:async()=>({stt:null,tts:null,selection:{stt:{provider:'local'},tts:{provider:'local'}}}),voiceModels:async()=>({})}};
  const ui=renderHooks(React=>createVoiceModels(React).Settings);
  t.after(()=>{ui.dispose();globalThis.window=previous;});
  ui.render();assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,2);
  await ui.settle();assert.equal(ui.find(node=>node.type.name==='LoadingSkeleton').length,0);
  assert.equal(ui.find(node=>node.type==='small'&&content(node)==='Unavailable').length,2);
});
