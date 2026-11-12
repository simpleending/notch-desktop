import { uiMessage } from './ui-messages.mjs';
export function createEngineUpdateView(React) {
  return function EngineUpdate({ api, provider }) {
    const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false);
    React.useEffect(() => { let alive = true; api[provider]('updates').then(value => { if (alive) setState(value); }).catch(() => {}); return () => { alive = false; }; }, []);
    return React.createElement('div', { className: 'notch-model-note' }, state && React.createElement('p', { role: 'status' }, uiMessage(state.error || `${state.message}${state.available ? ' Latest: ' + state.latest : ''}`)), React.createElement('button', { type: 'button', disabled: busy, onClick: async () => { setBusy(true); try { setState(await api[provider]('updates', true)); } catch { setState({ error: 'Could not check for updates. Try again later.' }); } finally { setBusy(false); } } }, busy ? 'Checking…' : 'Check engine updates'));
  };
}
