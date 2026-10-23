let pending = 0;
const listeners = new Set(), refreshers = new Set();
const notify = () => { for (const listener of listeners) listener(); };
export const modelActivityBusy = () => pending > 0;
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// Keep the composer pending until its own catalog reflects the completed operation.
export async function withModelActivity(operation) {
  pending++; notify();
  try { return await operation(); }
  finally {
    try { await Promise.allSettled([...refreshers].map(refresh => Promise.resolve().then(refresh))); }
    finally { pending--; notify(); }
  }
}

export function useModelActivity(React, refresh) {
  React.useEffect(() => { if (!refresh) return; refreshers.add(refresh); return () => refreshers.delete(refresh); }, [refresh]);
  return React.useSyncExternalStore(subscribe, modelActivityBusy, modelActivityBusy);
}

export function createModelLoadingDots(React) {
  return function ModelLoadingDots() {
    return React.createElement('div', { role: 'status', 'aria-label': 'Preparing model', className: 'notch-model-loading-dots', 'data-chat-composer-model-loading': true },
      ...[0, 1, 2].map(index => React.createElement('span', { key: index, 'aria-hidden': true })));
  };
}
