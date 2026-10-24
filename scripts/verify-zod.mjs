import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]),checked=[];
for(const entry of await fs.readdir(root,{recursive:true,withFileTypes:true})){
 if(entry.name!=='package.json'||path.basename(entry.parentPath)!=='zod')continue;
 const folder=entry.parentPath,manifest=JSON.parse(await fs.readFile(path.join(folder,entry.name),'utf8'));
 assert(['3.25.76','4.6.6'].includes(manifest.version),`Unreviewed Zod ${manifest.version}: ${folder}`);
 const require=createRequire(path.join(folder,'package.json'));
 for(const relative of ['',...(manifest.version==='3.25.76'?['v4']:[])]){
  const target=path.join(folder,relative);
  for(const z of [(await import(pathToFileURL(path.join(target,'index.js')))).z,require(path.join(target,'index.cjs')).z]){
   let count=0;const element=z.string().transform(value=>{count++;return value;});
   const result=await z.array(element).max(1).safeParseAsync(['a','b']);assert.equal(result.success,false);assert.equal(count,0,`${target} visits oversized input`);
   assert.deepEqual(z.array(z.string()).parse(['a']),['a']);
  }
 }
 checked.push({path:path.relative(root,folder),version:manifest.version});
}
assert(checked.length,'No packaged Zod copies found');console.log(JSON.stringify({passed:true,copies:checked},null,2));
