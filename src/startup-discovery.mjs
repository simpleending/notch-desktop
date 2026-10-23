import path from 'node:path';
import {stat} from 'node:fs/promises';

/** Resolve Windows PATH entries directly so startup never needs a where.exe console. */
export async function findWindowsExecutable(command,{env=process.env,cwd=process.cwd(),exists=async file=>(await stat(file)).isFile()}={}){
  if(typeof command!=='string'||!command||/[\0*?]/.test(command))return null;
  const value=name=>Object.entries(env).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]||'';
  const extensions=path.win32.extname(command)?['']:(value('PATHEXT')||'.COM;.EXE;.BAT;.CMD').split(';').filter(ext=>/^\.[a-z0-9]+$/i.test(ext));
  const directories=path.win32.isAbsolute(command)||/[\\/]/.test(command)?['']:[cwd,...value('PATH').split(';').map(part=>part.trim().replace(/^"|"$/g,'')).filter(Boolean)];
  for(const directory of directories)for(const extension of extensions){
    const file=path.win32.resolve(cwd,directory,command+extension);
    try{if(await exists(file))return file;}catch{/* Missing or unreadable PATH entries are skipped. */}
  }
  return null;
}

const optionalLists = new Set([
  'external-application:list', 'chat-model:list', 'chat-composer-model:list',
  'app-plugin:views-list', 'app-plugin:configuration-settings-list', 'app-plugin:mcp-tool-presentations-list',
]);

export function isPluginStop(error) {
  if (!(error instanceof Error)) return false;
  if (error.message === 'APP_PLUGIN_STARTUP_CANCELLED') return true;
  return /^APP_PLUGIN_(?:HOST_(?:STOPPING|STOPPED|UNAVAILABLE|PROCESS_REPLACED|LIVENESS_STOPPED)$|HOST_(?:EXITED|SPAWN_FAILED):|(?:ACTIVATION|GENERATION)_STALE:)/.test(error.message);
}

export function stopPluginHost(host) {
  return host.notchShutdown ??= (async () => {
    const running = host.stateValue === 'running';
    host.shuttingDown = true;
    host.setState('shuttingDown'); host.liveness?.stop();
    if (host.restartTimer) clearTimeout(host.restartTimer);
    host.restartTimer = undefined;
    const child = host.process;
    try {
      if (child) {
        if (running) await host.request('host.shutdown', undefined, undefined, undefined, 2000).catch(() => {});
        // A starting host has no activated plugins; its process must spawn before kill can work.
        else await child.ready.catch(() => {});
        child.kill();
      }
    } finally {
      host.disposeProcess(); host.rejectPending(new Error('APP_PLUGIN_HOST_STOPPED'));
    }
    await Promise.allSettled([host.processStart, ...host.activationPromises.values()]);
    host.runtimeStates.resetForShutdown(); host.setState('stopped');
  })();
}

/** Cancel read-only discovery inside the IPC tracker, leaving writes and actions intact. */
export function createStartupDiscovery() {
  const controller = new AbortController();
  const discovery = {
    signal: controller.signal,
    findExecutable: command=>controller.signal.aborted?Promise.resolve(null):findWindowsExecutable(command),
    isPluginStop,
    stopPluginHost,
    stop() { controller.abort(); },
    read(channel, operation) { return optionalLists.has(channel) ? discovery.run(operation) : operation(); },
    wait(operation) {
      return discovery.run(async () => ({ value: await operation() })).then(result => {
        if (controller.signal.aborted) throw new Error('APP_PLUGIN_STARTUP_CANCELLED');
        return result.value;
      });
    },
    run(operation) {
      const signal = controller.signal;
      if (signal.aborted) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const cancel = () => resolve([]);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => signal.aborted ? [] : operation()).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancel));
      });
    },
  };
  return discovery;
}
