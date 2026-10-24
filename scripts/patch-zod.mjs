import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const marker='notch: reject oversized collections before parsing their elements';
export function patchZod3(source){
  for(const [name,anchor,condition] of [
    ['ZodArray','        if (ctx.common.async) {','(def.maxLength !== null && ctx.data.length > def.maxLength.value) || (def.exactLength !== null && ctx.data.length > def.exactLength.value)'],
    ['ZodSet','        const valueType = this._def.valueType;','def.maxSize !== null && ctx.data.size > def.maxSize.value'],
  ]){
    const expression=new RegExp(`class ${name} extends ZodType \\{[\\s\\S]*?\\n\\}`),body=source.match(expression)?.[0];
    assert(body,`Missing ${name} in pinned Zod 3`);
    if(body.includes(marker))continue;
    assert.equal(body.split(anchor).length,2,`Unexpected ${name} parser`);
    source=source.replace(body,body.replace(anchor,`        // ${marker}\n        if (${condition}) return { status: "aborted" };\n${anchor}`));
  }
  return source;
}

// The CLI and inherited workbench still consume Zod 3. Keep that API and backport
// the upper-bound gate; replace their optional v4 entry points with official 4.6.6.
// https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd
export async function patchZodTree(modulesRoot,official=path.resolve('node_modules/zod-v4')){
  const base=path.resolve(modulesRoot),fixed=JSON.parse(await fs.readFile(path.join(official,'package.json'),'utf8'));
  assert.equal(fixed.version,'4.6.6');
  const packages=[];
  async function scan(directory){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      if(!entry.isDirectory())continue;
      const folder=path.join(directory,entry.name);
      if(entry.name==='zod'&&await fs.access(path.join(folder,'package.json')).then(()=>true,()=>false)){packages.push(folder);continue;}
      await scan(folder);
    }
  }
  await scan(base);
  assert(packages.length,`No Zod packages found under ${base}`);
  for(const folder of packages){
    assert(folder.startsWith(base+path.sep));
    const manifest=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));assert.equal(manifest.name,'zod');
    if(manifest.version==='3.25.76'){
      for(const extension of ['js','cjs']){const file=path.join(folder,'v3/types.'+extension);await fs.writeFile(file,patchZod3(await fs.readFile(file,'utf8')));}
      const v4=path.resolve(folder,'v4');assert(v4.startsWith(base+path.sep));
      await fs.rm(v4,{recursive:true,force:true});await fs.cp(path.join(official,'v4'),v4,{recursive:true});
      await fs.writeFile(path.join(folder,'notch-security-patch.json'),JSON.stringify({advisory:'GHSA-mrhx-c7xc-m3w5',v3:'3.25.76 with early size checks',v4:fixed.version},null,2));
    }else{
      assert(/^4\./.test(manifest.version),`Review unsupported Zod ${manifest.version}`);
      if(manifest.version!==fixed.version){await fs.rm(folder,{recursive:true,force:true});await fs.cp(official,folder,{recursive:true});}
    }
  }
  return packages.map(folder=>path.relative(base,folder));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify({patchedZod:await patchZodTree(path.resolve('node_modules'))}));
