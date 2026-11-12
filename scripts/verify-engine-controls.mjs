import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';

// Real upstream control/server packages with tiny engine fixtures; no GUI or model download.
const base=path.resolve(process.argv[2]||'release/runtime-review');
const report={modelDownloads:false,realControlPackages:true,checks:[]};
for(const provider of ['strata','colibri']){
  const runtime=path.join(base,provider),work=await fs.mkdtemp(path.join(base,provider+'-checks-'));
  for(const name of ['temp','local','roaming','profiles','instances','components','models'])await fs.mkdir(path.join(work,name));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|^STRATA_|^PYTHON/i.test(key))),PYTHONPATH:runtime,PYTHONNOUSERSITE:'1',PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',TEMP:path.join(work,'temp'),TMP:path.join(work,'temp'),LOCALAPPDATA:path.join(work,'local'),APPDATA:path.join(work,'roaming'),STRATA_PROFILE_DIR:path.join(work,'profiles'),STRATA_RUNTIME_DIR:path.join(work,'instances'),STRATA_COMPONENTS_DIR:path.join(work,'components'),STRATA_INSTALL_DIR:path.join(work,'models'),STRATA_SETTINGS_FILE:path.join(work,'settings.json'),STRATA_API_KEY:'none',STRATA_NO_ACQUIRE:'1',COLI_SETUP_HOME:path.join(work,'colibri-state'),COLI_COLOR:'0'};
  const child=spawn(path.join(base,'strata/python/python.exe'),[path.resolve('tests/fixtures/'+provider+'-lifecycle.py'),work],{cwd:runtime,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let id=0,errors='',readyResolve,readyReject;const pending=new Map();
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stderr.on('data',data=>{errors=(errors+data).slice(-12000);});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.once('error',readyReject);child.once('exit',code=>{readyReject(Error(provider+' exited '+code+': '+errors));for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error(errors));}pending.clear();});
  readline.createInterface({input:child.stdout}).on('line',line=>{let data;try{data=JSON.parse(line);}catch{return;}if(data.ready){readyResolve(data);return;}const row=pending.get(data.id);if(row){pending.delete(data.id);clearTimeout(row.timer);data.error?row.reject(Error(data.error)):row.resolve(data.value);}});
  function call(op,extra={}){return new Promise((resolve,reject)=>{const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(Error(provider+' timed out '+op));},60000);pending.set(request,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:request,op,...extra})+'\n');});}
  try{
    const startTimer=setTimeout(()=>readyReject(Error('Control startup timed out: '+errors)),20000);
    try{assert.equal((await ready).console,0);}finally{clearTimeout(startTimer);}
    assert.equal((await call('status')).running,false);
    assert.equal((await call('start',{model:'alpha',ownerPid:process.pid})).running,true);
    if(provider==='strata')assert.equal((await call('stale-stop')).rejected,true);
    await call('stop');assert.equal((await call('status')).running,false);
    await call('start',{model:'beta',ownerPid:process.pid});await call('stop');
    await call('fail',{model:'alpha',enabled:true});await assert.rejects(call('start',{model:'alpha',ownerPid:process.pid}));
    assert.equal((await call('status')).running,false);await call('fail',{model:'alpha',enabled:false});
    await call('start',{model:'alpha',ownerPid:process.pid});await call('stop');
    const evidence=await call('evidence');assert(evidence.engines.every(row=>!row.alive));
    report.checks.push({provider,passed:true,engines:evidence.engines.length,launch:true,stop:true,switch:true,failedStartRecovery:true});
    console.log(provider+': launch, stop, switch and failed-start recovery passed');
  }catch(error){report.checks.push({provider,passed:false,error:error.message,stderr:errors});throw error;}
  finally{child.stdin.end();const timer=setTimeout(()=>child.kill(),10000);await exited;clearTimeout(timer);await fs.writeFile(path.join(base,'control-verification.json'),JSON.stringify(report,null,2));}
}
