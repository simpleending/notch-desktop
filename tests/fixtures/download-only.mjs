import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const home=process.env.NOTCH_DOWNLOAD_FIXTURE_HOME;
assert(home&&path.basename(home).startsWith('notch-download-only-'));
os.homedir=()=>home;os.platform=()=> 'linux';os.totalmem=()=>8*2**30;os.freemem=()=>128*2**20;
const repo='Nimbus-Labs/Nimbus-4B-GGUF',model=`hf.co/${repo}:Q4_K_M`,folder=path.join(home,'.notch/cache/hub-models');
fs.mkdirSync(folder,{recursive:true});
fs.writeFileSync(path.join(folder,'ollama-'+repo.replace('/','--')+'.json'),JSON.stringify({repo,model,runner:'ollama',bytes:3*2**30,license:'apache-2.0',fetchedAt:Date.now()}));
const calls=[];
globalThis.fetch=async(url,init)=>{
 const route=new URL(url).pathname;calls.push(route);
 if(route==='/api/tags')return Response.json({models:process.env.NOTCH_DOWNLOAD_REUSED?[{name:model}]:[]});
 if(route==='/api/pull')return new Response(JSON.stringify({status:'success'})+'\n');
 if(route==='/api/show')return Response.json({capabilities:['tools'],model_info:{'general.architecture':'llama','llama.context_length':32768}});
 throw Error('Unexpected request during a file-only download: '+url);
};
process.on('exit',()=>fs.writeFileSync(path.join(home,'requests.json'),JSON.stringify(calls)));
