export function createPhoneSettings(React) {
  const h = React.createElement;
  return function PhoneSettings() {
    const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
    const [urlDraft, setUrlDraft] = React.useState(null), [hostDraft, setHostDraft] = React.useState(null), [ngrokDraft, setNgrokDraft] = React.useState(''), [cloudDraft, setCloudDraft] = React.useState('');
    const [pollError, setPollError] = React.useState(''), request = React.useRef(0), acting = React.useRef(false);
    React.useEffect(() => {
      let alive = true;
      const refresh = async () => { if (acting.current) return; const revision = ++request.current; try { const value = await window.notchModels.phone('status'); if (alive && revision === request.current) { setState(value); setPollError(''); } } catch (failure) { if (alive && revision === request.current) setPollError(failure.message); } };
      void refresh();
      const timer = setInterval(refresh, 1500);
      return () => { alive = false; request.current++; clearInterval(timer); };
    }, []);
    const act = async (action, value, success = '') => {
      const revision = ++request.current; acting.current = true;
      setBusy(true); setError(''); setPollError(''); setNotice('');
      try {
        const next = await window.notchModels.phone(action, value);
        if (revision !== request.current) return;
        setState(next);
        if (action === 'update') { if (Object.hasOwn(value, 'publicUrl')) setUrlDraft(null); if (Object.hasOwn(value, 'cloudflareHost')) setHostDraft(null); if (Object.hasOwn(value, 'ngrokToken')) setNgrokDraft(''); if (Object.hasOwn(value, 'cloudflareToken')) setCloudDraft(''); }
        setNotice(success);
      } catch (failure) { if (revision === request.current) setError(failure.message || 'Phone settings could not be saved.'); }
      finally { if (revision === request.current) { acting.current = false; setBusy(false); } }
    };
    const copy = async () => {
      const address = state?.url;
      if (!address) return;
      try { await navigator.clipboard.writeText(address); setNotice('Address copied.'); }
      catch { setNotice('Select the address and copy it.'); }
    };
    const urlValue = urlDraft ?? state?.publicUrl ?? '';
    const hostValue = hostDraft ?? state?.cloudflareHost ?? '';
    const reachCopy = {
      lan: 'Phones on this Wi-Fi open the address below. On Windows, allow notch on private networks if the system asks.',
      address: 'Paste an address that already forwards to this computer. Tailscale, Caddy, and a tunnel you run yourself all fit. notch does not receive that provider account.',
      ngrok: 'Your ngrok authtoken stays on this computer. notch starts ngrok when it is installed. The address belongs to your ngrok account.',
      cloudflare: 'Your Cloudflare tunnel token stays on this computer. Use the https hostname you configured, and point that tunnel at the port below.',
    };
    return h('section', { className: 'notch-web-settings notch-phone-settings', 'aria-labelledby': 'notch-phone-title' },
      h('h3', { id: 'notch-phone-title', tabIndex: -1 }, 'Phone'),
      h('p', null, 'Use this computer from your phone. Add the page to your home screen from the browser. There is no app store and no notch account. The phone uses the folder open in notch. Model and access are chosen in the phone menu.'),
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong', null, 'Phone access'), h('small', null, 'Serves a private page from this computer while notch is open.')),
        h('input', { type: 'checkbox', 'aria-label': 'Phone access', checked: !!state?.enabled, disabled: busy || !state, onChange: event => void act('update', { enabled: event.target.checked }) })),
      state?.enabled ? h('div', { className: 'notch-phone-card' },
        state.qr ? h('img', { className: 'notch-phone-qr', alt: 'Scan to open notch on your phone', width: 168, height: 168, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.qr)}` }) : null,
        h('div', null,
          h('p', { className: 'notch-eyebrow' }, 'PAIRING CODE'),
          h('p', { className: 'notch-phone-code' }, state.pairLabel || 'Creating a code'),
          h('p', null, 'The code works four times, or until you choose New code. Anyone with it can reach the open project until you remove their phone.'),
          h('label', null, 'Phone address', h('input', { readOnly: true, 'aria-label': 'Phone address', value: state.url || '' })),
          h('div', { className: 'notch-update-actions' },
            h('button', { type: 'button', disabled: busy || !state.url, onClick: () => void copy() }, 'Copy address'),
            h('button', { type: 'button', disabled: busy, onClick: () => void act('rotate', undefined, 'A new pairing code is ready.') }, 'New code')))) : null,
      state?.enabled && state.addresses?.length > 1 ? h('p', null, `Also on this network: ${state.addresses.slice(1).map(address => `http://${address}:${state.port}`).join(', ')}`) : null,
      state?.enabled && state.tailscale?.length ? h('p', null, `Tailscale: ${state.tailscale.map(address => `http://${address}:${state.port}`).join(', ')}. The phone needs Tailscale too.`) : null,
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong', null, 'Away from this Wi-Fi'), h('small', null, reachCopy[state?.reach || 'lan'])),
        h('select', { 'aria-label': 'Away from this Wi-Fi', value: state?.reach || 'lan', disabled: busy || !state, onChange: event => void act('update', { reach: event.target.value }) },
          h('option', { value: 'lan' }, 'This Wi-Fi'), h('option', { value: 'address' }, 'An address you host'), h('option', { value: 'ngrok' }, 'ngrok authtoken'), h('option', { value: 'cloudflare' }, 'Cloudflare tunnel token'))),
      state?.reach === 'address' ? h('form', { onSubmit: event => { event.preventDefault(); void act('update', { publicUrl: urlValue.trim() }, 'Address saved.'); } },
        h('label', null, 'Your address', h('input', { type: 'url', autoComplete: 'off', 'aria-label': 'Address you host', placeholder: 'https://your-computer.example', value: urlValue, maxLength: 300, disabled: busy, onChange: event => setUrlDraft(event.target.value) })),
        h('button', { type: 'submit', disabled: busy || !urlValue.trim() }, 'Save address'),
        h('button', { type: 'button', disabled: busy || !state.publicUrl, onClick: () => void act('update', { publicUrl: '' }, 'Address removed.') }, 'Remove address')) : null,
      state?.reach === 'ngrok' ? h('form', { onSubmit: event => { event.preventDefault(); void act('update', { ngrokToken: ngrokDraft.trim() }, 'Authtoken saved on this computer.'); } },
        h('label', null, 'ngrok authtoken', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'ngrok authtoken', placeholder: state?.hasNgrokKey ? 'Authtoken saved' : 'Paste your ngrok authtoken', value: ngrokDraft, maxLength: 4000, disabled: busy, onChange: event => setNgrokDraft(event.target.value) })),
        h('button', { type: 'submit', disabled: busy || !ngrokDraft.trim() }, 'Save authtoken'),
        h('button', { type: 'button', disabled: busy || !state?.hasNgrokKey, onClick: () => void act('update', { ngrokToken: null }, 'Saved authtoken removed.') }, 'Remove authtoken')) : null,
      state?.reach === 'cloudflare' ? h(React.Fragment, null,
        h('form', { onSubmit: event => { event.preventDefault(); void act('update', { cloudflareHost: hostValue.trim() }, 'Hostname saved.'); } },
          h('label', null, 'Cloudflare hostname', h('input', { type: 'url', autoComplete: 'off', 'aria-label': 'Cloudflare hostname', placeholder: 'https://phone.your-domain', value: hostValue, maxLength: 300, disabled: busy, onChange: event => setHostDraft(event.target.value) })),
          h('button', { type: 'submit', disabled: busy || !hostValue.trim() }, 'Save hostname')),
        h('form', { onSubmit: event => { event.preventDefault(); void act('update', { cloudflareToken: cloudDraft.trim() }, 'Tunnel token saved on this computer.'); } },
          h('label', null, 'Cloudflare tunnel token', h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'Cloudflare tunnel token', placeholder: state?.hasCloudflareKey ? 'Tunnel token saved' : 'Paste your tunnel token', value: cloudDraft, maxLength: 4000, disabled: busy, onChange: event => setCloudDraft(event.target.value) })),
          h('button', { type: 'submit', disabled: busy || !cloudDraft.trim() }, 'Save token'),
          h('button', { type: 'button', disabled: busy || !state?.hasCloudflareKey, onClick: () => void act('update', { cloudflareToken: null }, 'Saved tunnel token removed.') }, 'Remove token'))) : null,
      state?.enabled ? h('p', null, `Forward a tunnel to 127.0.0.1:${state.port}. ${state.persistentKey ? 'Saved tokens use system encryption.' : 'System encryption is unavailable, so tokens last only for this app session.'}`) : null,
      state?.tunnel?.message ? h('p', { role: 'status' }, state.tunnel.message) : null,
      h('div', null, h('strong', null, 'Paired phones'), state?.devices?.length ? h('ul', { className: 'notch-phone-devices' }, state.devices.map(device => h('li', { key: device.id }, h('span', null, device.name), h('button', { type: 'button', disabled: busy, onClick: () => void act('revoke', device.id, `${device.name} removed.`) }, 'Remove')))) : h('p', null, 'No phone is paired yet.')),
      notice ? h('p', { role: 'status' }, notice) : null,
      error || pollError || state?.error ? h('p', { role: 'alert' }, error || pollError || state.error) : null);
  };
}
