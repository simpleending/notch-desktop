import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateSettings} from '../src/update-settings-view.mjs';
test('update settings expose status, opt out, manual download and normal quit actions',async()=>{
 const calls=[];let state=[{supported:true,canInstall:true,automatic:true,currentVersion:'0.1.18',phase:'available',message:'New release available'},false,''],cursor=0;
 const React={useState(){const index=cursor++;return[state[index],value=>state[index]=value];},useEffect(){},createElement(type,props,...children){return{type,props:props||{},children};}};
 const previous=globalThis.window;globalThis.window={notchModels:{async updates(action,value){calls.push([action,value]);return{...state[0],phase:action==='download'?'ready':state[0].phase};}}};
 const Component=createUpdateSettings(React),render=()=>{cursor=0;return Component();},all=node=>[node,...node.children.flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(all)];
 const button=(tree,name)=>all(tree).find(n=>n.type==='button'&&n.children.includes(name));
 try{
  let tree=render();assert.equal(all(tree).find(n=>n.type==='a').props.href,'https://github.com/simpleending/notch-desktop/releases/latest');
  await all(tree).find(n=>n.type==='input').props.onChange({target:{checked:false}});assert.deepEqual(calls.at(-1),['automatic',false]);
  await button(render(),'Check for updates').props.onClick();assert.equal(calls.at(-1)[0],'check');
  await button(render(),'Download update').props.onClick();assert.equal(calls.at(-1)[0],'download');
  tree=render();await button(tree,'Quit and install').props.onClick();assert.equal(calls.at(-1)[0],'quit');
  state[0]={...state[0],canInstall:false};assert.equal(button(render(),'Quit and install').props.disabled,true);
 }finally{globalThis.window=previous;}
});
