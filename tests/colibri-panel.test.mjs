import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createColibriPanel} from '../src/colibri-panel.mjs';

test('Colibri shows memory and fit reasons before download, blocks insufficient RAM and refreshes stale results',async()=>{
  let state=[],cursor=0;const calls=[];
  const refs=[];let refCursor=0;
  const React={useState(value){const index=cursor++;if(!(index in state))state[index]=value;return[state[index],v=>state[index]=v];},useRef(value){return refs[refCursor++]??={current:value};},useEffect(){},createElement(type,props,...children){return{type,props:props||{},children};}};
  const rows=[{id:'large',name:'Large model',fits:false,fitLabel:'Not enough free RAM',reason:'Close applications and refresh memory before downloading.',download_gb:19.4,ram_min_gb:8,ram_good_gb:18,memory:{availableBytes:6e9,totalBytes:16e9,reserveBytes:1.5*2**30}}];
  const catalog={installed:true,version:'2.0.0',models:rows};
  const props={cached:catalog,api:{async colibri(action){calls.push(action);return{...catalog,models:[{...rows[0],fits:true,fitLabel:'Meets RAM precheck'}]};}},onCatalog(){},onStatus(){},async onInstalled(){}};
  const Panel=createColibriPanel(React),render=()=>{cursor=0;refCursor=0;return Panel(props);};
  const all=node=>[node,...node.children.flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(all)];
  const text=node=>node.children.flat(Infinity).map(x=>typeof x==='object'&&x?text(x):x).join(' ');
  const button=(tree,label)=>all(tree).find(n=>n.type==='button'&&text(n)===label);
  let tree=render();assert.match(text(tree),/6.0 GB available of 16.0 GB usable RAM/);assert.match(text(tree),/Not enough free RAM/);assert.match(text(tree),/Exact model\/context checks/);
  all(tree).find(n=>n.props.role==='option').props.onClick();tree=render();assert.equal(button(tree,'Download and validate').props.disabled,true);assert.match(text(tree),/Close applications/);assert.deepEqual(calls,[]);
  await button(tree,'Refresh memory').props.onClick();tree=render();assert.deepEqual(calls,['catalog']);assert.match(text(tree),/Meets RAM precheck/);
  all(tree).find(n=>n.props.role==='option').props.onClick();tree=render();assert.equal(button(tree,'Download and validate').props.disabled,false);
});
