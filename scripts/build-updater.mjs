import {build} from 'esbuild';
import fs from 'node:fs/promises';
await fs.mkdir('vendor/notch-updater',{recursive:true});
const result=await build({stdin:{contents:"export {autoUpdater,NsisUpdater} from 'electron-updater';",resolveDir:process.cwd(),sourcefile:'notch-updater-entry.js'},bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],outfile:'vendor/notch-updater/index.cjs',metafile:true});
const packages=new Set(Object.keys(result.metafile.inputs).flatMap(file=>{const match=file.replaceAll('\\','/').match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);return match?[match[1]]:[];}));
const notices=[];
for(const name of [...packages].sort()){
 const root='node_modules/'+name,metadata=JSON.parse(await fs.readFile(root+'/package.json','utf8'));
 const licenses=(await fs.readdir(root)).filter(file=>/^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(file));
 notices.push(`${name} ${metadata.version} (${metadata.license})\n`+(await Promise.all(licenses.map(file=>fs.readFile(root+'/'+file,'utf8')))).join('\n'));
}
await fs.writeFile('vendor/notch-updater/THIRD_PARTY_NOTICES.txt',notices.join('\n\n----------------\n\n'));
