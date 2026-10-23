import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import vm from'node:vm';
import{patchWebSourceProjection}from'../src/web-tools-patch.mjs';
const fixture=await fs.readFile(new URL('./fixtures/native-web-sources.js',import.meta.url),'utf8');
function project(source,tools,messages){
 const scope=vm.createContext({URL,qK:v=>v&&typeof v==='object',w0:(kind,label,detail,target)=>({kind,label,target}),h3:u=>new URL(u).hostname,GSt(){},zSt:()=>null,$St:()=>null});
 vm.runInContext(source,scope);return scope.LSt({turnId:'turn',messages:messages||[{id:'answer',role:'assistant',status:'completed',text:'Answer without inline URLs.',tools}]},{},null,null);
}
test('native Sources projection includes completed search results even when the answer omits citations',()=>{
 const tools=[{id:'search',name:'WebSearch',status:'completed',input:{query:'fixture'},response:'**[1]** [Official result](https://example.org/one)\n**[2]** [More](https://example.org/two)'}];
 assert.equal(project(fixture,tools).length,0,'Reproduce the missing Sources panel entries');
 const patched=patchWebSourceProjection(fixture);
 assert.equal(patchWebSourceProjection(patched),patched);
 assert.deepEqual(Array.from(project(patched,tools),row=>row.target.url),['https://example.org/one','https://example.org/two']);
 assert(project(patched,tools).every(row=>row.kind==='source'),'Search results must reach Source, rather than the separately configurable Browser section.');
 assert(patched.includes('const UQe=22,'),'Previously cached empty Sources lists must be rebuilt.');
});
test('Wikipedia citations survive a later answer that has no inline URL',()=>{
 const url='https://en.wikipedia.org/wiki/Sha%27Carri_Richardson';
 const messages=[{id:'first',role:'assistant',status:'completed',text:`[Wikipedia](${url})`,tools:[]},{id:'second',role:'assistant',status:'completed',text:'Here is more detail.',tools:[]}];
 const rows=project(patchWebSourceProjection(fixture),[],messages);
 assert.deepEqual(Array.from(rows,row=>({kind:row.kind,url:row.target.url})),[{kind:'source',url}]);
});
test('fetch sources retain safe URL handling and failed tools do not become sources',()=>{
 const tools=[{id:'fetch',name:'WebFetch',status:'completed',input:{url:'https://user:pass@example.org/page#section'},response:'file:///private/document'},
  {id:'failed',name:'WebSearch',status:'failed',input:{query:'fixture'},response:'https://example.org/failed'}];
 assert.deepEqual(Array.from(project(patchWebSourceProjection(fixture),tools),row=>row.target.url),['https://example.org/page']);
 assert.throws(()=>patchWebSourceProjection('changed upstream code'),/differs/);
});
