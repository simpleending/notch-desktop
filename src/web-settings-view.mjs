import { uiMessage } from "./ui-messages.mjs";
import { searchProviders } from './web-search-providers.mjs';
export function createWebSettings(React) {
  const h = React.createElement;
  return function WebSettings() {
    const [state, setState] = React.useState(null), [keys, setKeys] = React.useState({}), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('');
    const request = React.useRef(0);
    const load = async () => {
      const revision = ++request.current; setBusy(true); setMessage('');
      try { const value = await window.notchModels.web(); if (revision === request.current) setState(value); }
      catch (error) { if (revision === request.current) setMessage(error.message); }
      finally { if (revision === request.current) setBusy(false); }
    };
    React.useEffect(() => { void load(); return () => { request.current++; }; }, []);
    const update = async (patch, success = '') => {
      const revision = ++request.current;
      setBusy(true); setMessage('');
      try {
        const value = await window.notchModels.web(patch);
        if (revision === request.current) {
          setState(value);
          const provider = searchProviders.find(item => Object.hasOwn(patch, item.key));
          if (provider) setKeys(previous => ({ ...previous, [provider.id]: '' }));
          setMessage(success);
        }
      }
      catch (error) { if (revision === request.current) setMessage(error.message); }
      finally { if (revision === request.current) setBusy(false); }
    };
    const install = async () => {
      const revision = ++request.current;
      setBusy(true); setMessage('Downloading Chromium. This may take a few minutes.');
      try { await window.notchModels.webInstall(); const value = await window.notchModels.web(); if (revision === request.current) { setState(value); setMessage('Chromium is ready.'); } }
      catch (error) { if (revision === request.current) setMessage(error.message); }
      finally { if (revision === request.current) setBusy(false); }
    };
    return h('section', { className: 'notch-web-settings', 'aria-labelledby': 'notch-web-title' },
      h('h3', { id: 'notch-web-title', tabIndex: -1 }, 'Web research'),
      !state && message ? h('button', { type: 'button', disabled: busy, onClick: load }, 'Retry web settings') : null,
      h('p', null, 'Search for sources and read pages with a temporary browser. Queries and visited URLs go to external services. Browser actions follow your task access mode.'),
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong', null, 'Web access'), h('small', null, 'Applies to new tool calls.')),
        h('select', { 'aria-label': 'Web access', value: String(state?.enabled ?? true), disabled: busy || !state, onChange: e => update({ enabled: e.target.value === 'true' }) }, h('option', { value: 'true' }, 'Enabled'), h('option', { value: 'false' }, 'Disabled'))),
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong', null, 'Search provider'), h('small', null, 'Search queries go directly to the selected provider. DuckDuckGo requires no key.')),
        h('select', { 'aria-label': 'Search provider', value: state?.searchProvider || 'duckduckgo', disabled: busy || !state, onChange: e => update({ searchProvider: e.target.value }) },
          h('option', { value: 'duckduckgo' }, 'DuckDuckGo · no key'),
          ...searchProviders.map(({ id, label }) => h('option', { key: id, value: id }, `${label} · API key`)))),
      ...searchProviders.map(provider => {
        const key = keys[provider.id] ?? '';
        const credential = state?.credentials?.[provider.id];
        const label = `${provider.label} API key`;
        return h('form', { key: provider.id, 'aria-label': `${provider.label} credentials`, onSubmit: e => { e.preventDefault(); if (key.trim()) void update({ [provider.key]: key.trim() }, `${provider.label} key saved.`); } },
          h('label', null, label, h('input', { type: 'password', autoComplete: 'off', 'aria-label': label, placeholder: credential?.environment ? 'Environment key active' : credential?.saved ? 'Key configured' : 'Enter a search API key', value: key, maxLength: 4096, disabled: busy || !state, onChange: e => { const value = e.target.value; setKeys(previous => ({ ...previous, [provider.id]: value })); } })),
          h('button', { type: 'submit', disabled: busy || !state || !key.trim() }, 'Save key'),
          h('button', { type: 'button', disabled: busy || !credential?.saved, onClick: () => update({ [provider.key]: null }, credential.environment ? 'Saved key removed. An environment key is still active.' : 'Saved key removed.') }, 'Remove key'),
          h('a', { href: provider.url, target: '_blank', rel: 'noopener noreferrer' }, `Get a ${provider.label} key`));
      }),
      state ? h('p', null, `${state.persistentKey ? 'Saved keys use system encryption.' : 'System encryption unavailable: keys last only for this app session.'} Known URLs can be read without a search key.`) : null,
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong', null, 'Research browser'), h('small', null, 'A fresh private session opens for each operation and closes afterward.')),
        h('select', { 'aria-label': 'Research browser', value: state?.browser || 'auto', disabled: busy || !state, onChange: e => update({ browser: e.target.value }) },
          ...[['auto','Automatic'],['msedge','Microsoft Edge'],['chrome','Google Chrome'],['chromium','Chromium']].map(([value, label]) => h('option', { key: value, value }, label)))),
      h('button', { type: 'button', disabled: busy || !state, onClick: install }, 'Install Chromium'),
      h('p', { role: 'status', 'aria-live': 'polite' }, uiMessage(message, 'No further details are available. Refresh these settings to try again.')));
  };
}
