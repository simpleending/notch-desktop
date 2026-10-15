/** App discovery is optional; shutdown cancels its IPC reply and any child lookup. */
export function createStartupDiscovery() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    stop() { controller.abort(); },
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
}
