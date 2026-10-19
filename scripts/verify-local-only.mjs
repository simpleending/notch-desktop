import { _electron } from 'electron-qa';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processSnapshot, stopOwnedProcesses } from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]||'analysis/local-only-verification.json');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-local-only-')),profile=path.join(root,'profile');
for(const folder of ['Desktop','Documents','Downloads'])await fs.mkdir(path.join(root,folder));
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key))),HOME:root,USERPROFILE:root};
const app=await _electron.launch({executablePath:executable,args:['--lang=en-US',`--user-data-dir=${profile}`],env,timeout:45000});
const screens={},errors=[],checks=[];let passed=false,error;
try{
 app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
 await app.evaluate(({session})=>{
  globalThis.__notchLocalAuditRequests=[];
  const record=(address,source)=>{try{const url=new URL(String(address));if(/^https?:/.test(url.protocol))globalThis.__notchLocalAuditRequests.push({source,origin:url.origin,path:url.pathname});}catch{}};
  const realFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>{record(url instanceof Request?url.url:url,'node-fetch');return realFetch(url,options);};
  session.defaultSession.webRequest.onSendHeaders({urls:['http://*/*','https://*/*']},details=>record(details.url,'electron'));
 });
 let setup;const until=Date.now()+30000;
 while(!setup&&Date.now()<until){setup=app.windows().find(page=>page.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
 if(setup){await setup.getByRole('button',{name:/^Continue/}).click();
 const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;}
 const page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
 await page.waitForFunction(async()=>{
  const views=await window.notchDesktop.listAppPluginViews();
  return ['knowledge-center-workbench','sites-portal','index-settings'].every(id=>views.some(view=>view.viewId===id&&view.hostState==='running'));
 });
 const capture=async label=>{
  await page.waitForTimeout(300);
  const text=(await Promise.all(page.frames().map(frame=>frame.locator('body').innerText().catch(()=>'')))).join('\n');
  screens[label]=text;
  assert.doesNotMatch(text,/sign[ -]?in|log[ -]?in|cloud_auth_required|personal access token|notch Cloud|templates.*configured in the service/i,label);
  return text;
 };
 await capture('home');
 for(const name of ['File','Edit','View','Help']){
  await page.getByRole('button',{name,exact:true}).click();await capture('menu/'+name);await page.keyboard.press('Escape');
 }
 assert.ok(await page.getByRole('button',{name:/^(Start voice input|Start Live voice)$/i}).count()>0);
 const capabilities=await page.evaluate(()=>window.notchDesktop.getFeatureCapabilities());
 for(const key of ['cloudCollaborationEnabled','issuesEnabled','discussionsEnabled','agentTeamsEnabled','squadEnabled'])assert.equal(capabilities[key],false,key);
 const cloud=await page.evaluate(()=>window.notchDesktop.getCloudAutomationState());assert.equal(cloud.available,false);assert.equal(cloud.error,null);
 const remote=await page.evaluate(()=>window.notchDesktop.getRemoteControlState());assert.equal(remote.enabled,false);
 const policy=await page.evaluate(()=>window.notchDesktop.getDataPolicy());assert.equal(policy.shareEnabled,false);assert.equal(policy.canUpdate,false);
 checks.push('fresh account-free startup, retired capabilities off, privacy local, remote control disabled');
 await page.getByRole('button',{name:'Open user menu',exact:true}).first().click();
 await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
 const nav=page.getByRole('navigation',{name:'Settings',exact:true});
 for(const name of await nav.getByRole('button').allTextContents()){
  await nav.getByRole('button',{name:name.trim(),exact:true}).click();await capture('settings/'+name.trim());
  if(name.trim()==='Experiments'){
   const consent=page.getByRole('checkbox');if(await consent.count()){await consent.check();await page.getByRole('button',{name:'View experimental features',exact:true}).click();await capture('settings/Experiments expanded');}
  }
 }
 assert.match(screens['settings/Voice'],/Speech models|Cactus Whistle|Whisper/);
 assert.doesNotMatch(screens['settings/Keyboard shortcuts'],/Send feedback/);
 assert.equal((await page.evaluate(()=>window.notchDesktop.getRemoteSshAvailability())).supported,true);
 assert.match(screens['settings/General'],/automatic diagnostic uploads are disabled/);
 assert.doesNotMatch(screens['settings/Network'],/notch online services|foundation, model, messaging/);
 await nav.getByRole('button',{name:'Models',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Add model',exact:true}).count(),0);
 await page.getByRole('button',{name:'Browse and manage models',exact:true}).click();
 for(const name of ['Installed','Hugging Face','OpenRouter'])await page.getByRole('tab',{name,exact:true}).waitFor();
 const modelRows=page.locator('.notch-model-list button[role=option]:enabled');
 if(await modelRows.count()){await modelRows.first().click();await page.getByRole('combobox',{name:'Context limit',exact:true}).waitFor();}
 await page.keyboard.press('Escape');checks.push('Models settings uses the existing local/download/provider manager');
 checks.push('every settings page and plugin frame has no sign-in gate or retired cloud setup');
 await page.getByRole('button',{name:'Back to app',exact:true}).click();
 await page.getByRole('link',{name:'Automations',exact:true}).click();
 await page.getByRole('heading',{name:'Automations',exact:true}).waitFor();
 await capture('automations');
 assert.equal(await page.getByRole('tab',{name:'Remote',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Templates',exact:true}).count(),0);
 assert.doesNotMatch(screens.automations,/could not be loaded|Cloud request/i);
 await page.getByRole('button',{name:'Run history',exact:true}).click();await capture('automation run history');
 await page.getByRole('button',{name:'New automation',exact:true}).click();await capture('new automation');
 assert.equal(await page.getByRole('radio',{name:/cloud|remote/i}).count(),0);
 await page.keyboard.press('Escape');
 checks.push('local automation list, run history, and creation have no remote-service dependency');
 await page.getByRole('link',{name:'Extensions',exact:true}).click();
 await capture('extensions');assert.equal(await page.getByRole('button',{name:/^(Market|Marketplace)$/}).count(),0);
 for(const name of ['Plugins','Skills','Connectors','Agents']){
  const tab=page.getByRole('tab',{name:new RegExp('^'+name)});if(await tab.count()){await tab.click();await capture('extensions/'+name);}
 }
 await page.getByRole('tab',{name:/^Plugins/}).click();
 await page.getByRole('button',{name:'Add',exact:true}).click();await capture('add extension');
 await page.keyboard.press('Escape');
 checks.push('local extension tabs and Add dialog have no account marketplace');
 for(const [method,args]of [['configurenotchCloud',['fixture-not-a-token']],['setRemoteControlEnabled',[true]],['runNetworkDiagnostics',[]],['listExtensionMarket',[{kind:'plugin',scope:'public',query:'',page:1,pageSize:10}]]]){
  const outcome=await page.evaluate(async({method,args})=>{try{await window.notchDesktop[method](...args);return 'unexpected success';}catch(error){return error.message;}},{method,args});
  assert.match(outcome,/unavailable in the local edition/,method);
 }
 checks.push('direct retired-service IPC rejects locally without requesting sign-in');
 const requests=await app.evaluate(()=>globalThis.__notchLocalAuditRequests);
 assert.equal(requests.some(row=>/disabled\.notch\.invalid|qoder\.|rum\.aliyuncs\.com/.test(row.origin)),false);
 assert.deepEqual(errors,[]);checks.push('no renderer errors or retired backend HTTP requests during audited flows');
 passed=true;
}catch(failure){error=failure.stack;throw failure;}
finally{
 const requests=await app.evaluate(()=>globalThis.__notchLocalAuditRequests).catch(()=>[]);
 await fs.writeFile(reportFile,JSON.stringify({passed,executable,profile,checks,screens,errors,requests,...error?{error}:{}},null,2));
 const snapshot=await processSnapshot(),timer=setTimeout(()=>{void stopOwnedProcesses(app.process().pid,snapshot);},15000);
 try{await app.close();}finally{clearTimeout(timer);}console.log(JSON.stringify({passed,reportFile,checks,profile}));
}
