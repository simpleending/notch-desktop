import {_electron} from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {closeQaApp,processSnapshot,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-gui-background-')),profile=path.join(root,'profile'),cwd=path.join(root,'project');
await fs.mkdir(profile);await fs.mkdir(cwd);
await fs.writeFile(path.join(profile,'openrouter-models.json'),JSON.stringify({at:Date.now(),data:[{id:'lab/background',context_length:32768,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}}]}));
const cases=[];
for(const flag of [null,'preserved-user-value']){
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const index=cases.length,proof=randomUUID();
  await fs.writeFile(path.join(cwd,`server-${index}.mjs`),`import{createServer}from'node:http';const state={proof:${JSON.stringify(proof)},runAsNode:process.env.ELECTRON_RUN_AS_NODE??null};console.log('STDOUT_'+state.proof);console.error('STDERR_'+state.proof);createServer((q,r)=>r.end(JSON.stringify(state))).listen(${port},'127.0.0.1');`);
  await fs.writeFile(path.join(cwd,`verify-${index}.mjs`),`import assert from'node:assert/strict';let state;for(let i=0;i<50&&!state;i++){try{state=await(await fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(500)})).json()}catch{await new Promise(r=>setTimeout(r,100))}}assert.equal(state?.proof,${JSON.stringify(proof)});assert.equal(state.runAsNode,${JSON.stringify(flag)});console.log('READINESS_VERIFIED');`);
  cases.push({index,port,proof,flag,launch:`"${process.execPath}" server-${index}.mjs`,verify:`"${process.execPath}" verify-${index}.mjs`});
}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
let app,owned=[],pids=[],report={passed:false,live:false,executable,root};
try{
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
  const result=await app.evaluate(async(_electron,{cwd,cases})=>{
    if(!process.versions.electron||process.env.ELECTRON_RUN_AS_NODE!==undefined)throw Error('This regression must run in GUI Electron, without Node-mode inheritance');
    const host=globalThis.__notchHost,catalog=await host.modelManager.cloudCatalog(false,true),fetcher=globalThis.fetch;
    const trace=globalThis.__backgroundQa={pids:[],checks:[],launches:[]};
    const cp=process.getBuiltinModule('child_process'),spawn=cp.ChildProcess.prototype.spawn;
    cp.ChildProcess.prototype.spawn=function(options){trace.launches.push({file:options.file,windowsHide:options.windowsHide,detached:options.detached});return spawn.call(this,options);};
    host.modelManager.cloudCatalog=async()=>catalog.map(row=>({...row,enabled:true}));host.modelManager.key=async()=> 'fixture-only';
    await host.listModels(true);
    try{
      for(const value of cases){
        if(value.flag===null)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=value.flag;
        let round=0;
        globalThis.fetch=async(url,init)=>{
          if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw Error('Unexpected inference URL');
          const body=JSON.parse(init.body),delta=round++===0?{tool_calls:[
            {index:0,id:'launch-'+value.index,type:'function',function:{name:'shell',arguments:JSON.stringify({command:value.launch,background:true})}},
            {index:1,id:'verify-'+value.index,type:'function',function:{name:'shell',arguments:JSON.stringify({command:value.verify})}},
          ]}:{content:'GUI_BACKGROUND_VERIFIED'};
          const frame=(delta,reason=null)=>({id:'fixture',model:body.model,choices:[{index:0,delta,finish_reason:reason}]});
          return new Response(`data: ${JSON.stringify(frame(delta))}\n\ndata: ${JSON.stringify(frame({},round===1?'tool_calls':'stop'))}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
        };
        const events=[];
        for await(const event of host.query({cwd,sessionId:'gui-background-'+value.index,model:'openrouter/lab/background',prompt:'Start the server and verify readiness.',tools:['Bash'],permissionMode:'bypassPermissions',maxTurns:5})){
          events.push(event);
          for(const part of event.message?.content||[])if(part.type==='tool_result'){
            const match=String(part.content).match(/^Process started \(PID (\d+)\)/);if(match)trace.pids.push(Number(match[1]));
          }
        }
        const outcome=events.at(-1);if(outcome.subtype!=='success')throw Error(JSON.stringify(outcome));
        const outputs=events.flatMap(event=>Array.isArray(event.message?.content)?event.message.content:[]).filter(part=>part.type==='tool_result');
        if(!outputs.some(part=>String(part.content).includes('READINESS_VERIFIED')))throw Error('No successful foreground readiness check');
        const receipt=outputs.find(part=>String(part.content).startsWith('Process started'));if(!receipt)throw Error('No background process receipt');
        trace.checks.push({...value,pid:trace.pids.at(-1),receipt:receipt.content});
      }
      return {electron:process.versions.electron,guiRunAsNode:null,...trace};
    }finally{delete process.env.ELECTRON_RUN_AS_NODE;globalThis.fetch=fetcher;cp.ChildProcess.prototype.spawn=spawn;}
  },{cwd,cases});
  pids=result.pids;owned=await processSnapshot();assert.equal(pids.length,2);
  if(process.platform==='win32'){
    const supervisors=result.launches.filter(row=>path.resolve(row.file)===executable);
    assert.equal(supervisors.length,2);assert(supervisors.every(row=>row.windowsHide&&!row.detached),'Background supervisors must not allocate detached Windows consoles.');
  }
  for(const value of result.checks){
    assert.deepEqual(await(await fetch(`http://127.0.0.1:${value.port}`)).json(),{proof:value.proof,runAsNode:value.flag});
    const stdout=value.receipt.match(/stdout: (.+)/)[1].trim(),stderr=value.receipt.match(/stderr: (.+)/)[1].trim();
    assert.match(await fs.readFile(stdout,'utf8'),new RegExp('STDOUT_'+value.proof));assert.match(await fs.readFile(stderr,'utf8'),new RegExp('STDERR_'+value.proof));
  }
  await closeQaApp(app);app=null;
  for(const value of cases)assert.deepEqual(await(await fetch(`http://127.0.0.1:${value.port}`)).json(),{proof:value.proof,runAsNode:value.flag});
  report={...report,passed:true,...result,survivedGuiExit:true};
}catch(error){report.error=error.stack;throw error;
}finally{
  if(app){pids=await app.evaluate(()=>globalThis.__backgroundQa?.pids||[]).catch(()=>pids);owned=await processSnapshot();await closeQaApp(app).catch(()=>{});}
  for(const pid of pids)await stopOwnedProcesses(pid,owned);
  await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,root,guiElectron:report.electron,cases:report.checks?.length,survivedGuiExit:report.survivedGuiExit,error:report.error}));
}
