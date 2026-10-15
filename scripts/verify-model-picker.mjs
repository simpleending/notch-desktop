import {_electron} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {processSnapshot,stopOwnedProcesses} from './process-tree.mjs';

const executable=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'notch-picker-layout-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/token|secret|password|api.?key|ELECTRON_RUN_AS_NODE/i.test(key)));
const checks=[],errors=[];let app,page;
try{
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:45000});
  app.on('window',window=>window.on('pageerror',error=>errors.push(error.message)));
  let setup;const until=Date.now()+30000;
  while(!setup&&Date.now()<until){setup=app.windows().find(window=>window.url().includes('first-launch-onboarding-overlay'));if(!setup)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(setup);await setup.getByRole('button',{name:/^Continue/}).click();
  const closed=setup.waitForEvent('close');await setup.getByRole('button',{name:/^Open notch/}).click();await closed;
  page=await app.firstWindow();await page.locator('.notch-welcome').waitFor();
  for(const dark of [true,false]){
    const theme=page.getByRole('switch',{name:'Dark appearance'});
    if((await theme.getAttribute('aria-checked')==='true')!==dark)await theme.click();
    for(const size of [[1000,700],[900,600],[1280,720],[1440,1000]]){
      const bounds=await app.evaluate(({BrowserWindow},{url,size})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);window.unmaximize();window.setBounds({x:40,y:40,width:size[0],height:size[1]});return window.getBounds();},{url:page.url(),size});
      await page.waitForFunction(([width,height])=>Math.abs(innerWidth-width)<=2&&Math.abs(innerHeight-height)<=2,size);
      await page.getByRole('button',{name:'Model',exact:true}).click();
      for(const name of ['Installed','Hugging Face','OpenRouter']){
        const tab=page.getByRole('tab',{name,exact:true});await tab.click();
        await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-selected')==='true',await tab.getAttribute('id'));
        // Waiting for the real tab to stop moving also covers popover resize animations.
        await tab.click({trial:true});
        const geometry=await page.locator('.notch-model-picker').evaluate(picker=>{
          const rect=picker.getBoundingClientRect(),bar=document.querySelector('[data-layout-window-titlebar]')?.getBoundingClientRect();
          return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,titlebarBottom:bar?.bottom||44,width:innerWidth,height:innerHeight,region:getComputedStyle(picker).webkitAppRegion};
        });
        assert.ok(geometry.top>=geometry.titlebarBottom+4,JSON.stringify({name,size,geometry}));
        assert.ok(geometry.bottom<=geometry.height-7&&geometry.left>=7&&geometry.right<=geometry.width-7,JSON.stringify(geometry));
        assert.equal(geometry.region,'no-drag');
        if(dark&&size[0]===1000&&name==='Hugging Face')await page.screenshot({path:reportFile.replace('.json','.png')});
        checks.push({theme:dark?'dark':'light',size,bounds,tab:name,geometry});
      }
      await page.getByRole('tab',{name:'OpenRouter',exact:true}).focus();await page.keyboard.press('ArrowLeft');
      assert.equal(await page.getByRole('tab',{name:'Hugging Face',exact:true}).getAttribute('aria-selected'),'true');
      await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'OpenRouter',exact:true}).getAttribute('aria-selected'),'true');
      await page.keyboard.press('Escape');await page.locator('.notch-model-picker').waitFor({state:'hidden'});
    }
  }
  assert.deepEqual(errors,[]);await fs.writeFile(reportFile,JSON.stringify({passed:true,executable,profile,checks,errors},null,2));console.log(JSON.stringify({passed:true,cases:checks.length,themes:2,windowSizes:4,keyboardTabs:true}));
}catch(error){if(page)await page.screenshot({path:reportFile.replace('.json','-failure.png')}).catch(()=>{});await fs.writeFile(reportFile,JSON.stringify({passed:false,executable,profile,checks,error:error.stack,errors},null,2));throw error;}
finally{if(app){const child=app.process(),before=await processSnapshot();let timer;await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000)})]).finally(()=>clearTimeout(timer));if(child.exitCode===null)await stopOwnedProcesses(child.pid,before);}}
