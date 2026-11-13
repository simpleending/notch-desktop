import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parse} from 'acorn';
import {createUpdateIndicator} from '../src/update-indicator.mjs';
import {patchSecondaryArtwork} from '../src/workbench-patch.mjs';
test('footer shows a progress arrow, becomes Update, and invokes the guarded restart action',async()=>{
 let states=[{supported:true,canInstall:true,phase:'downloading',progress:42},false,''],index=0;const calls=[],refs=[];let ref=0;
 const React={useState(){const at=index++;return[states[at],v=>states[at]=v];},useRef(value){return refs[ref++]??={current:value};},useEffect(){},createElement(type,props,...children){return{type,props:props||{},children};}};
 const Component=createUpdateIndicator(React),render=()=>{index=0;ref=0;return Component();},all=node=>node?[node,...node.children.flat(Infinity).filter(n=>n&&typeof n==='object').flatMap(all)]:[];
 const previous=globalThis.window;globalThis.window={notchModels:{updates:async action=>{calls.push(action);return states[0];}}};
 try{
  let nodes=all(render());assert(nodes.some(n=>n.type==='svg'));assert(nodes.some(n=>n.props['aria-label']==='Downloading update: 42%'));assert(!nodes.some(n=>n.type==='button'));
  states[0]={...states[0],phase:'ready'};const button=all(render()).find(n=>n.type==='button');assert.deepEqual(button.children,['Update']);await button.props.onClick();assert.deepEqual(calls,['quit']);
  states[0]={...states[0],phase:'current'};assert.equal(render(),null);
  states[0]={...states[0],phase:'ready',canInstall:false};assert.equal(render(),null);
 }finally{globalThis.window=previous;}
});
test('update indicator is inserted beside the sidebar profile once and keeps the existing menu',()=>{
 const source='function ProfileMenu(){return jsxRuntimeExports.jsxs(DropdownMenu,{children:[existingMenu]});}';
 const patched=patchSecondaryArtwork(source);parse(patched,{ecmaVersion:'latest',sourceType:'module'});assert.match(patched,/notch-profile-updates/);assert.match(patched,/existingMenu/);assert.equal(patchSecondaryArtwork(patched),patched);
});
test('download arrow respects reduced motion and uses the theme gray',async()=>{
 const css=await fs.readFile(new URL('../src/workbench-skin.css',import.meta.url),'utf8');assert.match(css,/notch-update-indicator\{[^}]*color:var\(--notch-muted\)/);assert.match(css,/@media\(prefers-reduced-motion:reduce\).*notch-update-download svg\{animation:none\}/s);
});
