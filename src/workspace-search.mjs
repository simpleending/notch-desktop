import { fileURLToPath } from 'node:url';

const cancelled = () => new Error('WORKSPACE_FILE_SEARCH_CANCELLED');
async function startUtility() {
  const { utilityProcess } = await import('electron');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|ELECTRON_RUN_AS_NODE/i.test(key)));
  return utilityProcess.fork(fileURLToPath(new URL('./workspace-search-worker.mjs', import.meta.url)), [], { env, serviceName: 'notch file search', stdio: 'ignore' });
}

// Keep native indexing and searches outside the editor and main process.
export function createWorkspaceSearch(startWorker = startUtility) {
  let worker, starting, sequence = 0, idle, closed = false;
  const pending = new Map();
  const service = {
    engine: null,
    async search(searchId, root, generation, query, operation = 'search', params) {
      if (closed) throw cancelled();
      if (typeof searchId !== 'string' || typeof root !== 'string' || typeof query !== 'string' || query.length > 1024 || !Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid file search request.');
      service.cancel(searchId);
      const id = ++sequence;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(new Error('File search timed out.')), 15000);
        pending.set(id, { searchId, resolve, reject, timer });
      });
      // Install a rejection handler before awaiting worker startup.
      result.catch(() => {});
      clearTimeout(idle);
      try {
        if (!worker) {
          starting ??= Promise.resolve().then(startWorker).then(child => {
            if (closed) { child.kill(); throw cancelled(); }
            worker = child;
            child.on('message', reply => {
              const request = pending.get(reply.id);
              if (!request) return;
              pending.delete(reply.id); clearTimeout(request.timer);
              if (reply.error) request.reject(new Error(reply.error));
              else { service.engine = reply.result?.fallback ? 'ripgrep' : reply.result?.engine || 'fff'; request.resolve(reply.result); }
              if (!pending.size) { idle = setTimeout(() => stop(cancelled()), 60000); idle.unref?.(); }
            });
            child.on('error', () => { if (worker === child) stop(new Error('File search worker failed.')); });
            child.on('exit', () => { if (worker === child) stop(new Error('File search worker exited.')); });
            return child;
          }).finally(() => { starting = undefined; });
          await starting;
        }
        if (pending.has(id)) worker.postMessage({ id, searchId, root, query, operation, params });
      } catch (error) {
        const request = pending.get(id);
        if (request) { pending.delete(id); clearTimeout(request.timer); request.reject(error); }
      }
      return result;
    },
    async tool(operation, root, params, signal) {
      signal?.throwIfAborted();
      if (!['grep', 'glob'].includes(operation)) throw new Error('Invalid native search operation.');
      const searchId = `tool-${++sequence}`;
      const abort = () => service.cancel(searchId);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await service.search(searchId, root, 0, '', operation, params);
        signal?.throwIfAborted();
        return result.fallback ? undefined : { content: result.content, ...(result.isError ? { isError: true } : {}) };
      } finally { signal?.removeEventListener('abort', abort); }
    },
    cancel(searchId) {
      if (worker) try { worker.postMessage({ cancelSearchId: searchId }); } catch { /* A stopped worker rejects pending requests separately. */ }
      for (const [id, request] of pending) if (request.searchId === searchId) {
        pending.delete(id); clearTimeout(request.timer); request.reject(cancelled());
      }
      if (!pending.size && worker) { clearTimeout(idle); idle = setTimeout(() => stop(cancelled()), 60000); idle.unref?.(); }
    },
    invalidate(root) { if (worker) worker.postMessage({ invalidateRoot: root }); },
    async shutdown() { closed = true; stop(cancelled()); if (starting) await starting.catch(() => {}); },
  };
  function stop(error) {
    clearTimeout(idle);
    const child = worker; worker = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); child?.kill();
  }
  return service;
}
