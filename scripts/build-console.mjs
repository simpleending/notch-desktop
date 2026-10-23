import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,copyFile,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function buildConsole(output) {
  if(process.platform!=='win32')return;
  const target={x64:'x86_64-pc-windows-msvc',arm64:'aarch64-pc-windows-msvc'}[process.arch];
  if(!target)throw Error('Unsupported hidden console architecture.');
  const root=path.resolve(import.meta.dirname,'../native/windows-console');
  await promisify(execFile)('cargo',['build','--release','--locked','--target',target,'--manifest-path',path.join(root,'Cargo.toml')],{windowsHide:true,timeout:300000,env:{...process.env,[`CARGO_TARGET_${target.replaceAll('-','_').toUpperCase()}_RUSTFLAGS`]:'-C target-feature=+crt-static'}});
  await mkdir(output,{recursive:true});
  await copyFile(path.join(root,'target',target,'release/notch-console.exe'),path.join(output,`notch-console-win32-${process.arch}.exe`));
  const metadata=JSON.parse((await promisify(execFile)('cargo',['metadata','--locked','--format-version','1','--manifest-path',path.join(root,'Cargo.toml')],{windowsHide:true})).stdout),notices=[];
  for(const dependency of metadata.packages.filter(row=>row.source)){
    const directory=path.dirname(dependency.manifest_path),licenses=(await readdir(directory)).filter(name=>/^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(name));
    if(!licenses.length)throw Error(`Missing console host license: ${dependency.name}`);
    notices.push(`${dependency.name} ${dependency.version} (${dependency.license})\n${dependency.repository||''}\n${(await Promise.all(licenses.map(name=>readFile(path.join(directory,name),'utf8')))).join('\n')}`);
  }
  await writeFile(path.join(output,'CONSOLE-THIRD-PARTY-NOTICES.txt'),notices.join('\n\n----------------\n\n'));
}
