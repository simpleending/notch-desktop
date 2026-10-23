import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWorkbenchAssets,verifyWorkbenchImports} from '../src/workbench-patch.mjs';

test('renderer packaging includes the shared skeleton and all model source assets',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'notch-model-picker-assets-'));
  const application=path.join(temporary,'application'),renderer=path.join(application,'out/renderer'),assets=path.join(renderer,'assets');
  try {
    await mkdir(assets,{recursive:true});
    await mkdir(path.join(temporary,'resources/application-icons'),{recursive:true});
    await writeFile(path.join(renderer,'index.html'),'<html><head></head><body></body></html>');
    await installWorkbenchAssets(application,fileURLToPath(new URL('../',import.meta.url)));
    await verifyWorkbenchImports(assets);
    assert.match(await readFile(path.join(assets,'loading-skeleton.mjs'),'utf8'),/createLoadingSkeleton/);
    for(const name of ['huggingface','openrouter-dark','openrouter-light'])assert.match(await readFile(path.join(assets,`providers/${name}.svg`),'utf8'),/<svg/);
    const css=await readFile(path.join(assets,'workbench-skin.css'),'utf8');
    assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.notch-skeleton-line\{animation:none\}\}/);
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));
    await rm(temporary,{recursive:true,force:true});
  }
});
