import {test} from 'node:test';
import assert from 'node:assert/strict';
import {patchPersistedContextUsage} from '../src/bundle-patch.mjs';

const source='class jnr{async getContextUsage(e){const r=this.options.store.getSession(e);if(!r)return null;const i=this.options.resolveRuntimeDescriptor(r);if(i?.placement==="cloud"||i?.protocolFamily!=="notch")return null;const n=this.options.runtimeManager.getContextUsageReader(e),a=this.revision(e),s=n?await n.read():void 0;if(this.revision(e)!==a)return this.readContextUsageSnapshot(e);const o=s?.usage??null,A=gM(s?.model)??r.model,c=pee(o,this.readContextUsageSnapshot(e),A);return c.shouldPersist&&c.usage&&this.persistContextUsage(e,c.usage),c.usage}}';
const patched=patchPersistedContextUsage(source);
const Service=new Function('u7t','gM','pee',patched+';return jnr;')(
  value=>value??null,value=>value?.trim()||undefined,
  (usage,_saved,model)=>({usage:usage?.model===model||model==='auto'?usage:null,shouldPersist:true}),
);
function fixture(reader){
  const service=new Service(),session={cwd:'fixture-project',model:'ollama/gemma'};let revision=0;
  service.options={store:{getSession:()=>session},resolveRuntimeDescriptor:()=>({protocolFamily:'notch',placement:'local'}),runtimeManager:{getContextUsageReader:()=>reader}};
  service.revision=()=>revision;service.readContextUsageSnapshot=()=>null;service.persistContextUsage=(_id,usage)=>{service.saved=usage;};
  return {service,session,advance:()=>revision++};
}
const usage={model:'ollama/gemma',totalTokens:1250,maxTokens:8192};

test('retired runtimes recover final counts without relabeling another model',async()=>{
  assert.equal(patchPersistedContextUsage(patched),patched);
  const old=globalThis.__notchHost;let stored=usage,reads=0;
  globalThis.__notchHost={loadSession:async(id,cwd)=>{assert.equal(id,'session');assert.equal(cwd,'fixture-project');reads++;return {contextUsage:stored};}};
  try{
    const {service,session}=fixture();assert.deepEqual(await service.getContextUsage('session'),usage);assert.deepEqual(service.saved,usage);
    stored={...usage,model:'ollama/qwen'};assert.equal(await service.getContextUsage('session'),null);
    session.model='auto';assert.equal((await service.getContextUsage('session')).model,'ollama/qwen');
    stored=undefined;assert.equal(await service.getContextUsage('session'),null);assert.equal(reads,4);
  }finally{globalThis.__notchHost=old;}
});

test('a live runtime retains ownership of context reads, including pending results',async()=>{
  const old=globalThis.__notchHost;globalThis.__notchHost={loadSession:()=>{throw Error('Must not bypass a live reader');}};
  try{const {service}=fixture({read:async()=>({usage:null,model:'ollama/gemma'})});assert.equal(await service.getContextUsage('session'),null);}
  finally{globalThis.__notchHost=old;}
});

test('a model change while saved counts load invalidates the old result',async()=>{
  const old=globalThis.__notchHost;let complete;globalThis.__notchHost={loadSession:()=>new Promise(resolve=>{complete=resolve;})};
  try{const {service,advance}=fixture(),reading=service.getContextUsage('session');advance();complete({contextUsage:usage});assert.equal(await reading,null);assert.equal(service.saved,undefined);}
  finally{globalThis.__notchHost=old;}
});
