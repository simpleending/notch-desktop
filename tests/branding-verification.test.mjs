import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {verifyRendererBranding} from '../src/branding-verification.mjs';

test('branding verification rejects copied modules with mismatched renderer exports',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notch-branding-test-')),assets=path.join(root,'out/renderer/assets');
  try {
    await fs.mkdir(assets,{recursive:true});
    const modules={'notch-setup.mjs':'createnotchSetup','workbench-skin.mjs':'createnotchWorkbench','model-menu.mjs':'createModelMenu'};
    for(const [file,name] of Object.entries(modules))await fs.writeFile(path.join(assets,file),`export function ${name}(){}`);
    const imports=Object.entries(modules).map(([file,name])=>`import {${name}} from "./${file}";`).join('\n');
    const disabled=['AppleTreeDoodle','ImageDoodle','PartnerPlanGreetingMark','MobileAppDownloadPromo','FeedbackFloatingButton','FeedbackDialog','DesktopPetSurface','ProfileStickerCanvas'];
    await fs.writeFile(path.join(assets,'index.js'),`/* notch workbench skin */\n/* notch setup renderer */\n${imports}\nfunction OnboardingOverlaySurface(){}\nfunction ProfileStickerExperience({children}){return children;}\n${disabled.map(name=>`function ${name}(){return null;}`).join('\n')}`);
    assert.equal((await verifyRendererBranding(root)).bundles,1);
    const renderer=path.join(assets,'index.js');
    await fs.writeFile(renderer,(await fs.readFile(renderer,'utf8')).replace('{createnotchWorkbench}', '{createnotchWorkbench,openClonedProject}'));
    await fs.appendFile(path.join(assets,'workbench-skin.mjs'),'\nexport async function openClonedProject(){}');
    assert.equal((await verifyRendererBranding(root)).bundles,1);
    await fs.writeFile(path.join(assets,'workbench-skin.mjs'),'export function createnotchWorkbench(){}');
    await assert.rejects(verifyRendererBranding(root),/workbench-skin.mjs/);
    await fs.appendFile(path.join(assets,'workbench-skin.mjs'),'\nexport async function openClonedProject(){}');
    await fs.writeFile(path.join(assets,'notch-setup.mjs'),'export function createNotchSetup(){}');
    await assert.rejects(verifyRendererBranding(root),/import does not match/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
