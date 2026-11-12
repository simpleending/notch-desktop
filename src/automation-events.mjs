import fs from 'node:fs';
import path from 'node:path';

export function normalizeWatchFiles(files) {
  if (!Array.isArray(files) || files.length > 10 || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0'))) throw Error('Choose up to ten absolute file paths to watch.');
  return [...new Set(files.map(file => path.resolve(file)))];
}
/** Explicit files only: no recursive project scan and no unauthenticated webhook listener. */
export function createAutomationEvents({ run, eligible, onError = () => {}, now = Date.now, watch = fs.watchFile, unwatch = fs.unwatchFile }) {
  const tasks = new Map(); let closed = false;
  function remove(id) { const row = tasks.get(id); if (!row) return; clearTimeout(row.timer); for (const [file, listener] of row.listeners) unwatch(file, listener); tasks.delete(id); }
  return {
    set(id, files) {
      files = normalizeWatchFiles(files); remove(id); if (closed || !files.length) return;
      const row = { listeners: [], timer: undefined, lastRun: -Infinity }; tasks.set(id, row);
      for (const file of files) {
        const listener = (current, previous) => {
          if (closed || current.mtimeMs === previous.mtimeMs && current.size === previous.size || !eligible(id) || now() - row.lastRun < 60000) return;
          clearTimeout(row.timer); row.timer = setTimeout(() => {
            if (closed || !eligible(id)) return;
            row.lastRun = now(); void Promise.resolve().then(() => run(id)).catch(onError);
          }, 1000); row.timer.unref?.();
        };
        watch(file, { persistent: false, interval: 2000 }, listener); row.listeners.push([file, listener]);
      }
    },
    close() { closed = true; for (const id of tasks.keys()) remove(id); },
  };
}
