import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createColibriPanel} from '../src/colibri-panel.mjs';

test('Colibri shows memory and fit reasons before download, blocks insufficient RAM and refreshes stale results',async()=>{
  let state=[],cursor=0;const calls=[];
  const refs=[];let refCursor=0;
  const React={useState(value){const index=cursor++;if(!(index in state))state[index]=value;return[state[index],v=>state[index]=v];},useRef(value){return refs[refCursor++]??={current:value};},useEffect(){},createElement(type,props,...children){return{type,props:props||{},children};}};
  const rows=[{id:'large',name:'Large model',fits:false,fitLabel:'Not enough free RAM',reason:'Close applications and refresh memory before downloading.',download_gb:19.4,ram_min_gb:8,ram_good_gb:18,memory:{availableBytes:6e9,totalBytes:16e9,reserveBytes:1.5*2**30}}];
  const catalog={installed:true,version:'2.0.0',models:rows,backend:'vulkan',selectionReason:'VULKAN Â· 12,288 tokens Â· fastest measured working backend Â· AMD Radeon 8060S'};
  const props={cached:catalog,api:{async colibri(action){calls.push(action);return{...catalog,models:[{...rows[0],fits:true,fitLabel:'Meets RAM precheck'}]};}},onCatalog(){},onStatus(){},async onInstalled(){}};
  const Panel=createColibriPanel(React),render=()=>{cursor=0;refCursor=0;return Panel(props);};
  const all=node=>[node,...node.children.flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(all)];
  const text=node=>node.children.flat(Infinity).map(x=>typeof x==='object'&&x?text(x):x).join(' ');
  const button=(tree,label)=>all(tree).find(n=>n.type==='button'&&text(n)===label);
  let tree=render();assert.match(text(tree),/6.0 GB available of 16.0 GB usable RAM/);assert.match(text(tree),/Not enough free RAM/);assert.match(text(tree),/Available memory is checked again before loading/);
  assert.match(text(tree),/VULKAN Â· 12,288 tokens/);assert.match(text(tree),/AMD Radeon 8060S/);
  all(tree).find(n=>n.props.role==='option').props.onClick();tree=render();assert.equal(button(tree,'Download and validate').props.disabled,true);assert.match(text(tree),/Close applications/);assert.deepEqual(calls,[]);
  await button(tree,'Refresh memory').props.onClick();tree=render();assert.deepEqual(calls,['catalog']);assert.match(text(tree),/Meets RAM precheck/);
  all(tree).find(n=>n.props.role==='option').props.onClick();tree=render();assert.equal(button(tree,'Download and validate').props.disabled,false);
});

test('all GPU options stay visible and unsupported choices are disabled with reasons',()=>{
  const React={Fragment:'fragment',useState:v=>[v,()=>{}],useRef:()=>({current:null}),useEffect(){},createElement:(type,props,...children)=>({type,props:props||{},children})};
  const backends=[{backend:'cpu',label:'CPU',available:true,reason:'Supported CPU'}, {backend:'vulkan',label:'Vulkan · AMD / Intel / NVIDIA',available:true,reason:'Compatible Vulkan GPU'}, {backend:'cuda',label:'CUDA · NVIDIA',available:false,reason:'No NVIDIA GPU; AMD uses Vulkan'}, {backend:'metal',label:'Metal · Apple',available:false,reason:'Apple only'}];
  const tree=createColibriPanel(React)({cached:{installed:true,backends,gpu:'AMD Radeon 8060S',benchmarkEnabled:false,models:[]},api:{},onCatalog(){}});
  const all=n=>[n,...n.children.flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(all)];
  const inputs=all(tree).filter(n=>n.type==='input'&&n.props.type==='radio');
  assert.deepEqual(inputs.map(n=>[n.props.value,!!n.props.disabled]),[['auto',false],['cpu',false],['vulkan',false],['cuda',true],['metal',true]]);
  assert.equal(all(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
  assert.match(JSON.stringify(tree),/No NVIDIA GPU; AMD uses Vulkan/);
});
