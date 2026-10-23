import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// CREATE_NO_WINDOW does not propagate to Python's own hardware-probe subprocesses.
export const PYTHON_QUIET = `import os,subprocess
if os.name == 'nt':
    _Popen = subprocess.Popen
    class QuietPopen(_Popen):
        def __init__(self, *args, **kwargs):
            flags = kwargs.get('creationflags', 0)
            if not flags & subprocess.CREATE_NEW_CONSOLE:
                kwargs['creationflags'] = flags | subprocess.CREATE_NO_WINDOW
            super().__init__(*args, **kwargs)
    subprocess.Popen = QuietPopen
`;
export async function quietPython(directory: string) {
  const folder=path.join(directory,'python-hooks'), file=path.join(folder,'sitecustomize.py');
  await mkdir(folder,{recursive:true});
  if(await readFile(file,'utf8').catch(()=>null)!==PYTHON_QUIET)await writeFile(file,PYTHON_QUIET);
  return folder;
}
