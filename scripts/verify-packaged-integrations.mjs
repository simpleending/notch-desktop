import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';
import { parse } from 'acorn';

const app=path.resolve(process.argv[2]),report=path.resolve(process.argv[3]),archive=path.join(app,'resources/app.asar');
const read=file=>extractFile(archive,path.join(...file.split('/'))).toString();
const main=read('out/main/index.js'),preload=read('out/preload/index.cjs');
assert(main.includes('if(Q.defaultPrevented||n)return;'),'Native close respects background mode');
assert(main.includes('"Knowledge"'),'Knowledge is in the default tool catalog');
const ipc=parse(read('notch/src/model-ipc.mjs'),{ecmaVersion:'latest',sourceType:'module'});let handlers;
function visit(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id?.name==='handlers')handlers=node.init.properties.map(row=>row.key.name);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}visit(ipc);
const methods=[...preload.matchAll(/invoke\(['"]notch-models:([\w-]+)/g)].map(match=>match[1]);for(const method of methods)assert(handlers.includes(method),'Missing IPC handler: '+method);
const profile=await fs.mkdtemp(path.join(path.dirname(report),'packaged-integration-')),script=path.join(profile,'verify.cjs');
await fs.writeFile(script,`const {pathToFileURL}=require('node:url');const path=require('node:path');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
(async()=>{
const base=${JSON.stringify(archive)},load=file=>import(pathToFileURL(path.join(base,...file.split('/'))).href);
const core=await load('notch/vendor/notch-core/desktop-harness.js');
assert.equal(core.COLIBRI_VERSION,'2.1.0');assert.equal(core.STRATA_VERSION,'0.2.13');assert.equal(core.STRATA_CONTROL,'0.1.59');
const sdk=await load('node_modules/@notch-ai/notch-agent-sdk/dist/index.js');
const instance=sdk.createSdkMcpServer({name:'packaged',version:'1',tools:[{name:'echo',description:'Echo fixture',inputSchema:{},handler:async()=>({content:[{type:'text',text:'PACKAGED_MCP_OK'}]})}]});
const mcp=await core.connectDesktopMcp({cwd:${JSON.stringify(profile)},servers:{packaged:instance},signal:new AbortController().signal,approve:async()=>true});
try{assert.equal(mcp.tools.length,1);assert.equal((await mcp.tools[0].execute({},{})).content,'PACKAGED_MCP_OK');}finally{await mcp.close();}
const {createKnowledge}=await load('notch/src/knowledge.mjs');assert.deepEqual(await createKnowledge(${JSON.stringify(profile)})({}),{documents:[]});
const {createHost}=await load('notch/src/notch-host.mjs');const host=createHost(${JSON.stringify(profile)});await host.workspaceSearch.shutdown();
console.log(JSON.stringify({passed:true,electron:process.versions.electron,nativeMcpBridge:true,knowledge:true,hostImports:true,colibri:core.COLIBRI_VERSION,strata:core.STRATA_VERSION}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});`);
let output='';
const child=spawn(path.join(app,'Notch.exe'),[script],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
const timer=setTimeout(()=>child.kill(),60000);
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
await fs.writeFile(report,JSON.stringify({code,handlers:handlers.length,methods:methods.length,output},null,2));
assert.equal(code,0,output);console.log(output.trim());console.log('Installed bridge coverage: '+methods.length+'/'+handlers.length);
