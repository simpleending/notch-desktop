export function failureStamp(session) {
  return `${session.updatedAt ?? ''}:${session.latestTurnStatus ?? ''}:${session.runtimeState === 'error' ? 'error' : ''}`;
}

export function createTaskAttention(React, storage = globalThis.localStorage, events = globalThis.window) {
  const key = 'notch.tasks.acknowledgedFailures';
  let seen;
  try { const value = JSON.parse(storage?.getItem(key) || '{}'); seen = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { seen = {}; }
  return function useTaskAttention(kind, session, active) {
    const [, refresh] = React.useState(0), id = session.sessionId, stamp = failureStamp(session);
    React.useEffect(() => {
      const update = () => refresh(value => value + 1);
      events?.addEventListener('notch-task-acknowledged', update);
      return () => events?.removeEventListener('notch-task-acknowledged', update);
    }, []);
    React.useEffect(() => {
      if (!active || kind !== 'error' || seen[id] === stamp) return;
      seen[id] = stamp;
      try { storage?.setItem(key, JSON.stringify(seen)); } catch { /* Keep acknowledgement for this window if storage is unavailable. */ }
      events?.dispatchEvent(new Event('notch-task-acknowledged'));
    }, [active, kind, id, stamp]);
    // Opening/renaming a read task can update its timestamp without a new failed response.
    return kind === 'error' && (active || seen[id] === stamp || seen[id] && !session.unread) ? null : kind;
  };
}
