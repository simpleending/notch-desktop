import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {extractFile} from '@electron/asar';
import {patchFunction,patchClassMethod,patchMcpShutdownBudget} from '../src/bundle-patch.mjs';
import {processSnapshot,ownedProcessIds,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const source=extractFile(path.join(path.dirname(executable),'resources/app.asar'),path.join('out','main','index.js')).toString(),updated=patchMcpShutdownBudget(source);
function declaration(name,input=source){let code;patchFunction(input,name,value=>{code=value;return value;});const start=input.indexOf(`function ${name}(`);return (input.slice(start-6,start)==='async '?'async ':'')+code;}
function method(name,member){let code;patchClassMethod(source,name,member,body=>{code=body;return body;});return code;}
assert.match(source,/\bmOr=3e3,FVe=[12]e3\b/);assert.match(source,/\bqZ=1e4\b/);assert.match(source,/\bf2r=7e3\b/);
const helpers=['o1e','I2r','E2r','B8e','SD','y2r','C2r','qW','Vue','Gz','Q2r','CIe','Oue','B2r','S3r','yo'].map(name=>declaration(name)).join('\n');
const plan=declaration('D3r',updated),originalPlan=plan.replace('yo("mcp.shutdown","critical",6e3,','yo("mcp.shutdown","critical",4e3,');
const WindowsProcess=new Function(`return class{constructor(taskkill){this.taskkill=taskkill;}async terminate(e,r,i){${method('GPt','terminate')}}}`)();
const Pool=new Function(`return class{activeHandles=new Set;async forceTerminateAll(){${method('zUr','forceTerminateAll')}}}`)();
function service(pool,confirmation,events){const Service=new Function(declaration('Mre')+`;const mOr=3000,FVe=${confirmation};return class{async finishShutdown(t){${method('eue','finishShutdown')}}}`)(),value=new Service();value.processService=pool;value.logger={info:()=>events.push('force-confirmed')};return value;}
async function run(plan,service,pending){service.shutdown=()=>service.completion??=service.finishShutdown([pending]);const empty=new Proxy({},{get:()=>()=>Promise.resolve()}),services=new Proxy({mcpService:service},{get:(target,key)=>target[key]??empty});const execute=new Function('const Crt=()=>Promise.resolve();\n'+helpers+'\n'+plan+';return D3r;')();const start=performance.now();return execute(services,{globalDeadlineMs:start+10000,resourceWaveDeadlineMs:start+7000,signal:new AbortController().signal});}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function controlled(kind,selectedPlan,confirmation,fail=false){
  let release,termination;const pending=new Promise(resolve=>{release=resolve;}),events=[],pool=new Pool();
  const platform=new WindowsProcess(async args=>{assert.deepEqual(args,['/PID','777888','/T','/F']);await delay(1200);events.push('tree-command-completed');if(fail)throw Error('controlled taskkill failure');});
  pool.activeHandles.add({terminate:()=>termination??=platform.terminate(777888,()=>events.push('parent-fallback'),async()=>{events.push('exit-confirmed');return !fail;}).finally(release)});
  const current=service(pool,confirmation,events),start=performance.now(),outcome=await run(selectedPlan,current,pending);await current.completion.catch(()=>{});await termination.catch(()=>{});
  const mcp=outcome.outcomes.find(row=>row.name==='mcp.shutdown');
  if(kind==='old-outer')assert.equal(mcp.status,'timedOut');
  else if(kind==='old-force'){assert.equal(mcp.status,'failed');assert.equal(mcp.failureCode,'MCP_SHUTDOWN_FORCE_TIMEOUT');}
  else if(fail){assert.equal(mcp.status,'failed');assert.equal(mcp.failureCode,'MCP_SHUTDOWN_FORCE_FAILED');assert.equal(outcome.resourceSafe,false);}
  else{assert.equal(mcp.status,'graceful');assert.equal(outcome.completed,true);assert.equal(outcome.resourceSafe,true);assert.equal(outcome.stateSafe,true);assert.equal(current.shutdownForcedProcessCount,1);assert.deepEqual(events,['tree-command-completed','exit-confirmed','force-confirmed']);}
  return {kind,elapsedMs:Math.round(performance.now()-start),outcome:mcp,events};
}

async function realChild(){
  const root=spawn(process.execPath,['-e',`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(child.pid);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore'],windowsHide:true});let before;
  try{
    let output='';for await(const chunk of root.stdout){output+=chunk;if(output.includes('\n'))break;}const descendant=Number(output.trim());assert.ok(Number.isSafeInteger(descendant)&&descendant>0);
    before=await processSnapshot();const owned=ownedProcessIds(root.pid,before),raw=new Set([root.pid]);let changed=true;while(changed){changed=false;for(const row of before)if(raw.has(row.ParentProcessId)&&!raw.has(row.ProcessId)){raw.add(row.ProcessId);changed=true;}}
    assert.deepEqual([...raw].sort(),[...owned].sort(),'A reused parent PID must not authorize killing an older process');assert.ok(owned.has(descendant));
    const events=[],platform=new WindowsProcess(async args=>{assert.equal(args[1],String(root.pid));await promisify(execFile)('taskkill.exe',args,{windowsHide:true});events.push('tree-command-completed');});
    const waitForExit=new Function(declaration('a_t')+';return a_t;')(),pool=new Pool(),pending=new Promise(resolve=>root.once('exit',resolve));
    pool.activeHandles.add({terminate:()=>platform.terminate(root.pid,root.kill.bind(root),async()=>{const exited=await waitForExit(root);if(exited)events.push('exit-confirmed');return exited;})});
    const current=service(pool,2000,events),outcome=await run(plan,current,pending);assert.equal(outcome.resourceSafe,true,JSON.stringify(outcome));assert.equal(outcome.stateSafe,true);assert.equal(current.shutdownForcedProcessCount,1);assert.deepEqual(events,['tree-command-completed','exit-confirmed','force-confirmed']);
    const after=await processSnapshot();assert.deepEqual(after.filter(row=>owned.has(row.ProcessId)&&before.some(old=>old.ProcessId===row.ProcessId&&old.CreationDate===row.CreationDate)),[]);
    return {kind:'actual-windows-process-tree',ownedProcesses:owned.size,outcome:outcome.outcomes.find(row=>row.name==='mcp.shutdown'),events};
  }finally{if(root.exitCode===null){if(before)await stopOwnedProcesses(root.pid,before);else root.kill();}}
}
const keepAlive=setInterval(()=>{},1000);let checks;
try{checks=await Promise.all([controlled('old-outer',originalPlan,1000),controlled('old-force',plan,1000),controlled('aligned-windows-budget',plan,2000),controlled('real-force-error',plan,2000,true),realChild()]);}finally{clearInterval(keepAlive);}
await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,checks,overallDeadlineMs:10000,resourceWaveDeadlineMs:7000,graceMs:3000,forceConfirmationMs:2000,participantBudgetMs:6000},null,2));console.log(JSON.stringify({passed:true,checks}));
