import fs from 'node:fs/promises';
import path from 'node:path';
import { patchSecondaryArtwork } from './workbench-patch.mjs';

/** Verify every bundled renderer surface, including rarely shown empty/error states. */
export async function verifyRendererBranding(application) {
  let files=0, bundles=0;
  async function check(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){await check(file);continue;}
      if(!/\.(?:html|js|mjs|css|json)$/.test(entry.name))continue;
      const text=await fs.readFile(file,'utf8');files++;
      if(/qoder/i.test(text) || /\bQoduck\b|Q\s?达鸭/.test(text))throw new Error(`Original product branding remains in ${path.relative(application,file)}.`);
      if(/\bElectron\b/.test(text))throw new Error(`Runtime branding remains in ${path.relative(application,file)}.`);
      if(text.includes('function OnboardingOverlaySurface(')) {
        bundles++;
        if(!text.includes('/* notch workbench skin */') || !text.includes('/* notch setup renderer */'))throw new Error('The notch renderer patches are missing.');
        if(patchSecondaryArtwork(text)!==text)throw new Error('An inherited illustration remains in the renderer.');
        if(/jsxRuntimeExports\.jsx\((?:notchQuillPenAiLine|notchQuillPenLine|FeatherIcon|CustomInputWritingPen),/.test(text))throw new Error('An inherited assistant pen icon remains active.');
        for(const name of ['AppleTreeDoodle','ImageDoodle','PartnerPlanGreetingMark','MobileAppDownloadPromo','FeedbackFloatingButton','FeedbackDialog','DesktopPetSurface','ProfileStickerCanvas'])if(!text.includes(`function ${name}(){return null;}`))throw new Error(`An inherited surface remains active: ${name}.`);
        if(!text.includes('function ProfileStickerExperience({children}){return children;}'))throw new Error('The original profile decoration remains active.');
        for(const module of ['notch-setup.mjs','workbench-skin.mjs','model-menu.mjs']) {
          const escaped=module.replaceAll('.','\\.');
          const imported=text.match(new RegExp(`import \\{([^}]+)\\} from ["']\\./${escaped}["']`))?.[1]?.split(',').map(name=>name.trim());
          const dependency=await fs.readFile(path.join(path.dirname(file),module),'utf8');
          if(!imported?.length || imported.some(name=>!/^\w+$/.test(name) || !new RegExp(`export\\s+(?:async\\s+)?function ${name}\\(`).test(dependency)))throw new Error(`The renderer import does not match ${module}'s export.`);
        }
        if(text.includes('children:applicationIconOptions.map('))throw new Error('The original mascot is still selectable.');
      }
    }
  }
  await check(path.join(application,'out/renderer'));
  if(bundles!==1)throw new Error('Expected one branded renderer for all window surfaces.');
  return {files,bundles,originalProductNames:0,inheritedIllustrations:0};
}
