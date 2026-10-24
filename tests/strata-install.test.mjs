import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source=await readFile(new URL('../vendor/notch-cli/src/providers/strata.ts',import.meta.url),'utf8');
const body=stripTypeScriptTypes(source.slice(source.indexOf('export async function installStrata('),source.indexOf('\nexport async function stopStrata(')).replace(/^export /,''));
for(const previous of [undefined,{id:'previous',profile:'previous-profile',contextWindow:8192}]){
 test(`Strata cancellation during selection commit restores ${previous?'the prior model':'an empty selection'} before releasing its lease`,async()=>{
  const controller=new AbortController();let selected=previous,leased=false,finish,enter;
  const entered=new Promise(resolve=>enter=resolve),pending=new Promise(resolve=>finish=resolve);
  const deps={
   withLocalInference:async fn=>{leased=true;try{return await fn();}finally{leased=false;}},
   strataStatus:async()=>({running:false,selected:previous}),
   strataCatalog:async()=>({models:[{id:'next',fits:true,contextWindow:8192,contexts:[8192,16384]}],dataDirectory:'/models'}),
   bridge:async()=>({id:'next',profile:'next-profile',config:'/models/config.json'}),selection:()=>'/selected.json',
   atomic:async(_file,value)=>{assert(leased);selected=value;if(value.id==='next'){enter();await pending;}},
   unlink:async()=>{assert(leased);selected=undefined;},
  };
  const install=new Function(...Object.keys(deps),body+';return installStrata;')(...Object.values(deps));
  const result=install('next',{},controller.signal);await entered;controller.abort();finish();
  await assert.rejects(result,{name:'AbortError'});assert.deepEqual(selected,previous);assert.equal(leased,false);
 });
}
