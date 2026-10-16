import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {ownedProcessIds,processSnapshot as processes,closeQaApp} from './process-tree.mjs';

const exec=promisify(execFile),pause=()=>new Promise(resolve=>setTimeout(resolve,100));
const messageScript=fileURLToPath(new URL('./send-session-message.ps1',import.meta.url));
async function waitFor(operation,label){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(await operation())return;await pause();}
  throw Error('Timed out: '+label);
}
async function killOwned(before,owned,main){
  const live=await processes();
  const targets=live.filter(row=>owned.has(row.ProcessId)&&before.some(old=>old.ProcessId===row.ProcessId&&old.CreationDate===row.CreationDate));
  targets.sort((a,b)=>(b.ProcessId===main)-(a.ProcessId===main));
  // Avoid taskkill /T: Windows can reuse a dead parent's PID for an unrelated process.
  for(const row of targets)await exec('taskkill.exe',['/PID',String(row.ProcessId),'/F'],{windowsHide:true}).catch(()=>{});
  return targets.length;
}
export async function verifyRecovery({app,profile,workspace,sessionId,changes,restart,stopped}){
  assert.equal(process.platform,'win32','Windows session messages require Windows');
  const checks=[],sessionFile=path.join(profile,'notch-sessions',sessionId+'.json'),undoFile=path.join(profile,'notch-undo',sessionId+'.json');
  const savedSession=await fs.readFile(sessionFile,'utf8'),savedUndo=await fs.readFile(undoFile,'utf8');
  async function inspect(stage){
    const db=new DatabaseSync(path.join(profile,'main.sqlite'),{readOnly:true});
    try{
      assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row=>row.integrity_check),['ok']);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
      const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const table=tables.find(t=>db.prepare('PRAGMA table_info('+t.name+')').all().some(c=>c.name==='checkpoint_user_message_id'));
      const rows=db.prepare('SELECT change_set_id,turn_id,checkpoint_user_message_id FROM '+table.name+' WHERE session_id=? ORDER BY ordinal').all(sessionId);
      assert.deepEqual(rows,changes,'Native turn identities must survive '+stage);
    }finally{db.close();}
    assert.equal(await fs.readFile(sessionFile,'utf8'),savedSession,'Saved transcript changed during '+stage);
    assert.equal(await fs.readFile(undoFile,'utf8'),savedUndo,'Saved checkpoints changed during '+stage);
    const state=await app.evaluate(async({app},{sessionId,workspace})=>{
      const host=globalThis.__notchHost;
      return {chat:await host.loadSession(sessionId,workspace),checkpoints:(await host.openCheckpoints(sessionId,workspace)).list()};
    },{sessionId,workspace});
    for(const prompt of ['Undo check one','Undo check two','Undo check three'])assert.ok(JSON.stringify(state.chat).includes(prompt),'Missing saved prompt: '+prompt);
    assert.equal(state.checkpoints.length,3);
    const page=await app.firstWindow();
    await page.getByText('Undo check one',{exact:true}).first().waitFor();
    const preview=await page.evaluate(v=>window.notchDesktop.previewTurnFileChangesUndo(v),{sessionId,changeSetId:changes[1].change_set_id});
    assert.equal(preview.canRewind,true,JSON.stringify(preview));assert.equal(preview.filesChanged.length,2);
    assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'two');
    assert.equal((await fs.readFile(path.join(workspace,'created.txt'),'utf8')).trim(),'new');
    checks.push({stage,integrity:'ok',foreignKeys:'ok',savedTranscriptUnchanged:true,checkpoints:3,nativeUndoPreview:true});
    console.log('Recovery passed: '+stage);
  }
  async function terminate(action){
    const child=app.process(),before=await processes(),owned=ownedProcessIds(child.pid,before);
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    await action(child.pid,before,owned);
    let timer;const result=await Promise.race([exit,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Terminated app did not exit')),15000);})]).finally(()=>clearTimeout(timer));
    stopped();app=null;
    // A real OS session end kills the process tree; targeted messages do not.
    const remaining=await killOwned(before,owned);
    app=await restart();return {...result,osSessionChildrenCleaned:remaining};
  }
  const kill=async(_pid,before,owned)=>killOwned(before,owned,await app.evaluate(()=>process.pid));
  await terminate(kill);await inspect('forced-termination-after-saved-turns');
  for(const target of [sessionFile,undoFile]){
    await app.evaluate(async(_electron,{target,sessionId,workspace,isSession})=>{
      const fs=process.getBuiltinModule('fs').promises,rename=fs.rename;
      globalThis.__recoveryPause=false;
      fs.rename=async(from,to)=>{
        if(to===target){globalThis.__recoveryPause=true;await new Promise(()=>{});}
        return rename(from,to);
      };
      const host=globalThis.__notchHost;
      const operation=isSession?host.loadSession(sessionId,workspace).then(state=>host.saveSession(sessionId,{...state,unacknowledged:'must not replace saved transcript'})):host.openCheckpoints(sessionId,workspace).then(manager=>manager.beginTurn('unacknowledged-turn'));
      void operation.catch(error=>{globalThis.__recoveryError=String(error)});
    },{target,sessionId,workspace,isSession:target===sessionFile});
    await waitFor(()=>app.evaluate(()=>globalThis.__recoveryPause),'durable temporary file before atomic rename');
    const temporary=(await fs.readdir(path.dirname(target))).find(name=>name.startsWith(path.basename(target)+'.')&&name.endsWith('.tmp'));
    assert.ok(temporary,'The save must be interrupted with a real temporary file on disk');
    JSON.parse(await fs.readFile(path.join(path.dirname(target),temporary),'utf8'));
    await terminate(kill);await inspect(target===sessionFile?'forced-during-chat-save':'forced-during-undo-save');
  }
  async function sessionMessage(message,word,flags){
    const {owner,handle}=await app.evaluate(({BrowserWindow})=>({owner:process.pid,handle:BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()).getNativeWindowHandle().readBigUInt64LE().toString()}));
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',messageScript,'-WindowHandle',handle,'-OwnerPid',String(owner),'-Message',String(message),'-Word',String(word),'-Flags',String(flags)],{windowsHide:true,timeout:10000});
    return JSON.parse(stdout);
  }
  // Exercise the actual Win32 path, including cancellation; never request an OS shutdown.
  let query=await sessionMessage(17,0,0);assert.notEqual(query.sent,0,JSON.stringify(query));assert.equal(query.result,1);
  const canceled=await sessionMessage(22,0,0);assert.notEqual(canceled.sent,0);await inspect('windows-shutdown-canceled');
  for(const [stage,flags]of [['windows-shutdown-restart',0],['windows-logoff',0x80000000],['windows-critical-close-app',0x40000001]]){
    query=await sessionMessage(17,0,flags);assert.notEqual(query.sent,0,JSON.stringify(query));assert.equal(query.result,1,'The app must respect the Windows session ending request');
    const exit=await terminate(()=>sessionMessage(22,1,flags));assert.equal(exit.code,0,JSON.stringify(exit));
    await inspect(stage);checks.at(-1).exit=exit;
  }
  await closeQaApp(app);stopped();app=await restart({early:true});
  await terminate(kill);await inspect('forced-during-startup');
  return checks;
}

export async function verifyInterruptedUndo({app,workspace,undoFile,target,restart,stopped}){
  async function terminate(){
    const child=app.process(),before=await processes(),owned=ownedProcessIds(child.pid,before),exit=new Promise(resolve=>child.once('exit',resolve));
    await killOwned(before,owned,await app.evaluate(()=>process.pid));
    let timer;await Promise.race([exit,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Interrupted undo app did not exit')),15000);})]).finally(()=>clearTimeout(timer));
    stopped();app=await restart();
  }
  // Stop halfway through a two-file restore, after the restore transaction was saved.
  await app.evaluate((_electron,{workspace})=>{
    const fs=process.getBuiltinModule('fs').promises,unlink=fs.unlink;
    globalThis.__recoveryPause=false;
    fs.unlink=async file=>{if(file===workspace+'\\created.txt'){globalThis.__recoveryPause=true;await new Promise(()=>{});}return unlink(file);};
  },{workspace});
  const page=await app.firstWindow();
  const pending=page.evaluate(v=>window.notchDesktop.undoTurnFileChanges(v),target).catch(error=>String(error));
  await waitFor(()=>app.evaluate(()=>globalThis.__recoveryPause),'partially restored file undo');
  assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'one');
  assert.ok(JSON.parse(await fs.readFile(undoFile,'utf8')).restoring,'Undo recovery transaction must be durable before files change');
  await terminate();await pending;
  const resumed=await app.firstWindow();
  const preview=await resumed.evaluate(v=>window.notchDesktop.previewTurnFileChangesUndo(v),target);assert.equal(preview.canRewind,true,JSON.stringify(preview));
  await resumed.evaluate(v=>window.notchDesktop.undoTurnFileChanges(v),target);
  assert.equal(await fs.readFile(path.join(workspace,'file.txt'),'utf8'),'one');await assert.rejects(fs.access(path.join(workspace,'created.txt')));
  const history=JSON.parse(await fs.readFile(undoFile,'utf8'));assert.equal(history.checkpoints.length,1);assert.equal(history.restoring,undefined);
  return {stage:'forced-during-partial-file-undo',recovered:true,remainingCheckpoints:1};
}
