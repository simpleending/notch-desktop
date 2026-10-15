import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';
import {patchFunction,patchClassMethod,patchMcpShutdownBudget} from '../src/bundle-patch.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const source=extractFile(path.join(path.dirname(executable),'resources/app.asar'),path.join('out','main','index.js')).toString();
function declaration(name){let code;patchFunction(source,name,value=>{code=value;return value;});const start=source.indexOf(`function ${name}(`);return (source.slice(start-6,start)==='async '?'async ':'')+code;}
let finish;patchClassMethod(source,'eue','finishShutdown',body=>{finish=body;return body;});
const grace=Number(source.match(/\bmOr=([\d.e]+)/)?.[1]),confirmation=Number(source.match(/\bFVe=([\d.e]+)/)?.[1]);
assert.equal(grace,3000);assert.equal(confirmation,1000);assert.match(source,/\bqZ=1e4\b/);assert.match(source,/\bf2r=7e3\b/);
const helpers=['o1e','I2r','E2r','B8e','SD','y2r','C2r','qW','Vue','Gz','Q2r','CIe','Oue','B2r','S3r','yo'].map(declaration).join('\n');
const originalPlan=declaration('D3r').replace('yo("mcp.shutdown","critical",5e3,','yo("mcp.shutdown","critical",4e3,');
const Service=new Function(declaration('Mre')+`;const mOr=${grace},FVe=${confirmation};return class{async finishShutdown(t){${finish}}}`)();

async function check(kind,plan,failed=0){
  let release;const pending=new Promise(resolve=>{release=resolve;}),events=[],service=new Service();
  service.logger={info:()=>events.push('force-confirmed')};
  service.processService={forceTerminateAll:()=>new Promise(resolve=>setTimeout(()=>{events.push('process-exit-confirmed');release();resolve({attempted:1,terminated:1-failed,failed});},confirmation))};
  let completion;service.shutdown=()=>completion??=service.finishShutdown([pending]);
  const empty=new Proxy({},{get:()=>()=>Promise.resolve()}),services=new Proxy({mcpService:service},{get:(target,key)=>target[key]??empty});
  const run=new Function('const Crt=()=>Promise.resolve();\n'+helpers+'\n'+plan+';return D3r;')();
  const started=performance.now(),outcome=await run(services,{globalDeadlineMs:started+10000,resourceWaveDeadlineMs:started+7000,signal:new AbortController().signal});
  await completion.catch(()=>{});
  const mcp=outcome.outcomes.find(row=>row.name==='mcp.shutdown');assert.ok(mcp);assert.deepEqual(events,['process-exit-confirmed','force-confirmed']);
  if(kind==='old-collision')assert.equal(mcp.status,'timedOut');
  else if(failed){assert.equal(mcp.status,'failed');assert.equal(mcp.failureCode,'MCP_SHUTDOWN_FORCE_FAILED');assert.equal(outcome.resourceSafe,false);}
  else{assert.equal(mcp.status,'graceful');assert.equal(outcome.completed,true,JSON.stringify(outcome));assert.equal(outcome.resourceSafe,true);assert.equal(outcome.stateSafe,true);assert.equal(service.shutdownForcedProcessCount,1);}
  return {kind,elapsedMs:Math.round(performance.now()-started),outcome:mcp,events};
}
const keepAlive=setInterval(()=>{},1000);let checks;
try{checks=await Promise.all([check('old-collision',originalPlan),check('aligned-deadline',patchMcpShutdownBudget(originalPlan)),check('real-force-error',patchMcpShutdownBudget(originalPlan),1)]);}finally{clearInterval(keepAlive);}
await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,checks,overallDeadlineMs:10000,resourceWaveDeadlineMs:7000},null,2));
console.log(JSON.stringify({passed:true,checks}));
