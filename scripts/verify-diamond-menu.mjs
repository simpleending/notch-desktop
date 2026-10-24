import {_electron} from 'electron-qa';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';
const executable=path.resolve(process.argv[2]),directory=path.resolve(process.argv[3]);
await fs.mkdir(directory,{recursive:true});
const profile=await fs.mkdtemp(path.join(directory,'profile-')),report={passed:false,checks:[],errors:[],profile,softwareRendering:true};
let app,page;
try{
 app=await _electron.launch({executablePath:executable,args:['--user-data-dir='+profile,'--disable-gpu','--notch-windows-startup-compatibility'],timeout:60000});
 app.on('window',window=>{window.on('pageerror',error=>report.errors.push(error.message));window.on('console',message=>{if(message.type()==='error')(report.consoleErrors??=[]).push(message.text().slice(0,2000));});});
 await app.evaluate(({app},workspace)=>{
  const path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));
  const {NotchQuery}=require(path.join(app.getAppPath(),'notch/src/notch-query.mjs')),host=globalThis.__notchHost,key='openrouter/menu-fixture';
  const rows=[{key,provider:'openrouter',displayName:'Menu test fixture',enabled:true,isDefault:true,isNew:false,priceFactor:0,source:'system',tags:[],tools:true,maxInputTokens:8192,maxOutputTokens:2048,availableContextWindows:[8192],defaultContextWindow:8192,recommendedContextWindow:8192,efforts:[],defaultEffort:null,supportsDisabled:true}];
  host.listModels=async()=>rows;host.getCachedModels=()=>rows;host.getDefaultModel=()=>key;host.resolveModelChoice=()=>key;
  host.query=request=>new NotchQuery(host,{...request,model:key,cwd:workspace},{runTurn:async turn=>{const content='Diamond menu test ready.';turn.onText(content);return{status:'completed',messages:[...turn.messages,{role:'assistant',content}]};}});
 },directory);
 let setup;const deadline=Date.now()+90000;
 while(!setup&&Date.now()<deadline){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
 assert(setup,'onboarding opens');await setup.getByRole('button',{name:/^Continue/}).click({timeout:90000});const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
 page=await app.firstWindow();await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByRole('link',{name:'New Task Ctrl+N',exact:true}).click();await page.getByRole('textbox',{name:'New Task',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'New Task',exact:true}).fill('Verify task actions');await page.getByRole('textbox',{name:'New Task',exact:true}).press('Enter');await page.getByText('Diamond menu test ready.',{exact:true}).first().waitFor();
 for(const [width,height,dark] of [[1000,700,false],[900,600,true]]){
  await app.evaluate(({BrowserWindow},{url,width,height})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);window.unmaximize();window.setBounds({x:40,y:40,width,height});},{url:page.url(),width,height});
  const theme=page.getByRole('switch',{name:'Dark appearance'});if((await theme.getAttribute('aria-checked')==='true')!==dark)await theme.click();
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  for(const [label,x,y] of [['center',viewport.width*.65,viewport.height*.45],['top',viewport.width-18,75],['bottom',viewport.width-18,viewport.height-18]]){
   if(label==='center')await page.mouse.click(x,y,{button:'right'});
   else await page.getByText('Diamond menu test ready.',{exact:true}).first().evaluate((node,{x,y})=>node.dispatchEvent(new MouseEvent('contextmenu',{clientX:x,clientY:y,button:2,bubbles:true,cancelable:true})),{x,y});
   const menu=page.locator('.notch-diamond-menu');await menu.waitFor({timeout:10000});
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('.notch-diamond-menu')).opacity==='1');
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await menu.evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
   const metrics=await menu.evaluate(node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight,items:[...node.querySelectorAll('[role=menuitem]')].map(item=>{const rect=item.getBoundingClientRect();return {label:item.getAttribute('aria-label'),glyph:item.querySelector('path')?.getAttribute('d'),left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};})};});
   assert(metrics.items.length>=3);assert.equal(new Set(metrics.items.map(item=>item.glyph)).size,metrics.items.length);
   assert(metrics.left>=0&&metrics.right<=metrics.width&&metrics.top>=50&&metrics.bottom<=metrics.height,JSON.stringify(metrics));
   for(const item of metrics.items)assert(item.label&&item.left>=metrics.left&&item.right<=metrics.right&&item.top>=metrics.top&&item.bottom<=metrics.bottom,JSON.stringify(item));
   await page.keyboard.press('ArrowDown');assert(await menu.locator('[role=menuitem]:focus').count());await page.screenshot({path:path.join(directory,`${dark?'dark':'light'}-${label}.png`),animations:'disabled'});
   await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});report.checks.push({width,height,dark,position:label,metrics});
  }
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(page){report.text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});}}
finally{
 if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>timer=setTimeout(resolve,10000))]).finally(()=>clearTimeout(timer));await stopOwnedProcesses(child.pid,before);}
 await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
