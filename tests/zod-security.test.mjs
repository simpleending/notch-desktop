import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {z as v3} from 'zod';
import {z as v4} from 'zod/v4';
import {patchZod3} from '../scripts/patch-zod.mjs';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);

for(const [name,z] of [['ESM v3',v3],['CJS v3',require('zod').z],['ESM v4',v4],['CJS v4',require('zod/v4').z]]){
 test(`${name} rejects oversized arrays and sets before visiting elements`,async()=>{
  let parsed=0;const element=z.string().transform(value=>{parsed++;return value.toUpperCase();});
  for(const schema of [z.array(element).max(2),z.array(element).length(2)]){
   for(const result of [schema.safeParse(['a','b','c']),await schema.safeParseAsync(['a','b','c'])]){assert.equal(result.success,false);assert(result.error.issues.some(issue=>issue.code==='too_big'));}
   assert.equal(parsed,0);assert.deepEqual(schema.parse(['a','b']),['A','B']);parsed=0;
  }
  const set=z.set(element).max(1);assert.equal(set.safeParse(new Set(['a','b'])).success,false);assert.equal(parsed,0);assert.deepEqual([...set.parse(new Set(['a']))],['A']);
  assert.equal(z.object({items:z.array(z.string()).max(1)}).safeParse({items:[1,2]}).error.issues.length,1);
 });
}
test('Zod backport is repeatable and rejects an unexpected parser layout',async()=>{
 const source=await fs.readFile(new URL('../node_modules/zod/v3/types.js',import.meta.url),'utf8');assert.equal(patchZod3(source),source);assert.throws(()=>patchZod3('export const broken = true;'),/Missing ZodArray/);
});
