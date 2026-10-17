/**
 * Notch CLI — Local terminal backend.
 *
 * Runs the command in the host process via `child_process.exec` with
 * stdout/stderr size caps, wall-clock timeout, and cooperative abort.
 * Default backend when `.notch.json`'s `terminal.backend` is `"local"`
 * or absent.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';

const DEFAULT_MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function stopTree(child: ReturnType<typeof spawn>): void {
  if(!child.pid||child.exitCode!==null)return;
  if(process.platform==='win32'){
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill());
  }else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}

export class LocalTerminal implements TerminalBackend {
  readonly id = 'local';
  readonly description = 'Execute on the host via child_process.spawn.';

  async readyCheck(): Promise<void> {
    // Always ready — we're the host.
  }

  async start(req: TerminalRunRequest): Promise<TerminalRunResult> {
    req.signal?.throwIfAborted();
    const started=Date.now(),directory=path.join(req.cwd??process.cwd(),'.notch','processes');
    await fs.mkdir(directory,{recursive:true});
    const id=randomUUID(),stdoutFile=path.join(directory,id+'.out.log'),stderrFile=path.join(directory,id+'.err.log');
    await fs.writeFile(stdoutFile,'',{flag:'wx'});await fs.writeFile(stderrFile,'',{flag:'wx'});
    let child: ReturnType<typeof spawn> | undefined;
    const abort=()=>{if(child)stopTree(child);};
    try {
      req.signal?.throwIfAborted();
      // Keep the shell attached to a detached Node supervisor: Windows cmd.exe
      // otherwise replaces redirected standard handles when creating its console.
      const bootstrap = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs');
const p=JSON.parse(process.argv[1]),win=process.platform==='win32';
if(p.runAsNode===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=p.runAsNode;
const child=spawn(win?(process.env.COMSPEC||'cmd.exe'):'/bin/sh',win?['/d','/s','/c','"'+p.command+'"']:['-lc',p.command],{cwd:p.cwd,windowsHide:true,windowsVerbatimArguments:win});
child.stdin.end();
child.stdout.on('data',data=>fs.appendFileSync(p.stdoutFile,data));
child.stderr.on('data',data=>fs.appendFileSync(p.stderrFile,data));
child.on('error',error=>{fs.appendFileSync(p.stderrFile,error.message);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});
`;
      const env={...process.env,...req.env};
      child=spawn(process.execPath,['-e',bootstrap,JSON.stringify({command:req.command,cwd:req.cwd,stdoutFile,stderrFile,runAsNode:env.ELECTRON_RUN_AS_NODE})],{
        cwd:req.cwd,env:{...env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},windowsHide:true,detached:true,stdio:'ignore',
      });
      req.signal?.addEventListener('abort',abort,{once:true});
      if(req.signal?.aborted)abort();
      const early=await new Promise<number|null|undefined>((resolve,reject)=>{
        child!.once('error',reject);child!.once('exit',code=>resolve(code));
        child!.once('spawn',()=>setTimeout(()=>resolve(undefined),250));
      });
      req.signal?.throwIfAborted();
      child.unref();
      if(early!==undefined)return {exitCode:early,stdout:(await fs.readFile(stdoutFile,'utf8')).slice(0,DEFAULT_MAX_OUTPUT),stderr:(await fs.readFile(stderrFile,'utf8')).slice(0,DEFAULT_MAX_OUTPUT),durationMs:Date.now()-started};
      return {exitCode:0,stdout:'',stderr:'',durationMs:Date.now()-started,diagnostics:{background:true,pid:child.pid,stdoutFile,stderrFile}};
    }finally{req.signal?.removeEventListener('abort',abort);}
  }

  run(req: TerminalRunRequest): Promise<TerminalRunResult> {
    if (req.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: '[aborted]', durationMs: 0 });
    const maxChars = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', `"${req.command}"`] : ['-lc', req.command];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let aborted = false;

      const child = spawn(shell, shellArgs, {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        windowsHide: true,
        windowsVerbatimArguments: isWin,
        detached: !isWin,
      });

      let stopping = false;
      const stop = () => {
        if (stopping || !child.pid || child.exitCode !== null) return;
        stopping = true;
        stopTree(child);
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        stop();
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }

      const onData = (text: string, which: 'stdout' | 'stderr'): void => {
        const current = which === 'stdout' ? stdout : stderr;
        const remaining = maxChars - current.length;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        if (text.length <= remaining) {
          if (which === 'stdout') stdout += text;
          else stderr += text;
        } else {
          if (which === 'stdout') stdout += text.slice(0, remaining);
          else stderr += text.slice(0, remaining);
          truncated = true;
        }
      };

      child.stdout.setEncoding('utf8').on('data', (text: string) => onData(text, 'stdout'));
      child.stderr.setEncoding('utf8').on('data', (text: string) => onData(text, 'stderr'));

      child.on('close', (code, sig) => {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (timedOut && !stderr.includes('[timeout]')) {
          stderr = (stderr ? `${stderr}\n` : '') + `[timeout] killed after ${timeoutMs}ms`;
        }
        if (aborted && !stderr.includes('[aborted]')) {
          stderr = (stderr ? `${stderr}\n` : '') + `[aborted]`;
        }
        resolve({
          exitCode: sig ? null : code ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          truncated,
          diagnostics: { backend: 'local', shell, pid: child.pid, signal: sig },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        resolve({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs: Date.now() - start,
          diagnostics: { backend: 'local', error: err.message },
        });
      });
    });
  }
}
