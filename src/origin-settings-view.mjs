import { originRepository, originCloneUrl } from './origin-repository.mjs';

export function createOriginSettings(React) {
  const h = React.createElement;
  return function OriginSettings({ onOpenProject, localProjects = [] }) {
    const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const [value, setValue] = React.useState(''), [protocol, setProtocol] = React.useState('ssh'), [query, setQuery] = React.useState('');
    const [owner, setOwner] = React.useState(''), [namespaces, setNamespaces] = React.useState([]), [repos, setRepos] = React.useState([]), [next, setNext] = React.useState('');
    const bridge = window.notchModels?.origin, paths = JSON.stringify([...new Set(localProjects.map(project => project.path))]);
    const revision = React.useRef(0);
    React.useEffect(() => {
      let live = true; const current = revision.current;
      if (bridge) bridge('remember', JSON.parse(paths)).then(result => { if (live && current === revision.current) setState(result); }).catch(failure => { if (live && current === revision.current) setError(failure.message); });
      return () => { live = false; revision.current++; };
    }, [bridge, paths]);
    const act = async (action, argument) => {
      const current = ++revision.current;
      setBusy(true); setError('');
      try {
        const result = await bridge(action, argument);
        if (current !== revision.current) return;
        setState(previous => ({ ...previous, ...result }));
        if (action === 'namespaces') { setNamespaces(result.namespaces); setOwner(''); setRepos([]); setNext(''); }
        if (action === 'repos') { setRepos(previous => [...new Map([...(argument.pageToken ? previous : []), ...result.repos].map(row => [row.name, row])).values()]); setNext(result.nextPageToken); }
        if (action === 'openRepo') await onOpenProject(result.clonedPath);
      } catch (failure) { if (current === revision.current) setError(failure.message || 'Origin could not finish this request.'); }
      finally { if (current === revision.current) setBusy(false); }
    };
    if (!bridge) return h('p', null, 'Restart notch to use Origin repositories.');
    const local = name => state?.localClones?.[originRepository(name)], existing = local(value);
    const filtered = repos.filter(row => row.name.toLowerCase().includes(query.trim().toLowerCase()));
    return h('section', { className: 'notch-web-settings notch-origin-settings', 'aria-label': 'Cursor Origin', 'aria-busy': busy },
      h('h3', null, 'Cursor Origin'),
      h('p', null, 'Clone to this device with your local Git credentials or registered SSH key. Pull and push use the project’s Git remote.'),
      h('p', null, state?.nativeCliSupported === false ? 'On Windows, configure credentials or SSH keys for Windows Git. The Origin CLI currently supports macOS, Linux and WSL; its WSL credentials are separate from Windows Git.' : 'For browser sign-in, install the official Origin CLI and run origin auth login in a terminal. The CLI manages credentials and token refresh.'),
      h('div', { className: 'notch-update-actions' }, h('a', { href: 'https://cursor.com/codebase', target: '_blank', rel: 'noopener noreferrer' }, 'Browse on Cursor'),
        h('a', { href: 'https://cursor.com/docs/origin/git', target: '_blank', rel: 'noopener noreferrer' }, 'Authentication and SSH setup')),
      busy ? h('p', { role: 'status', 'aria-live': 'polite' }, 'Working…') : null,
      h('form', { onSubmit: event => { event.preventDefault(); void act(existing ? 'openRepo' : 'clone', existing ? value : originCloneUrl(value, protocol)); } },
        h('label', null, 'Origin repository', h('input', { value, placeholder: 'owner/repo or Origin clone URL', spellCheck: false, autoCapitalize: 'none', autoComplete: 'off', maxLength: 2048, required: true, onChange: event => setValue(event.target.value) })),
        h('label', null, 'Origin clone protocol', h('select', { value: protocol, disabled: busy, onChange: event => setProtocol(event.target.value) }, h('option', { value: 'ssh' }, 'SSH'), h('option', { value: 'https' }, 'HTTPS'))),
        h('button', { type: 'submit', disabled: busy || !originRepository(value) }, existing ? 'Open Origin repository' : 'Clone Origin repository')),
      protocol === 'ssh' ? h('p', null, 'SSH uses keys on this device. Verify a first connection against the official Origin host fingerprint before continuing in a terminal.') : null,
      state?.nativeCliSupported ? h('div', null,
        h('button', { type: 'button', disabled: busy, onClick: () => act('namespaces') }, 'Load Origin repositories'),
        namespaces.length ? h('label', null, 'Origin namespace', h('select', { value: owner, disabled: busy, onChange: event => { const selected = event.target.value; setOwner(selected); setRepos([]); setNext(''); if (selected) void act('repos', { owner: selected }); } },
          h('option', { value: '' }, 'Choose a namespace'), namespaces.map(name => h('option', { key: name, value: name }, name)))) : null) : null,
      state?.namespaces?.length === 0 ? h('p', { role: 'status' }, 'No accessible Origin namespaces found. Check that Origin is enabled for your Cursor account or team.') : null,
      state?.owner === owner && owner && !repos.length && !busy ? h('p', { role: 'status' }, 'No accessible repositories in this namespace.') : null,
      repos.length ? h('div', null,
        h('label', null, 'Filter Origin repositories', h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value) })),
        h('ul', { className: 'notch-github-repos', 'aria-label': 'Origin repositories', tabIndex: 0 }, filtered.length ? filtered.map(row => {
          const directory = local(row.name), action = directory ? 'Open' : 'Clone';
          return h('li', { key: row.name }, h('span', null, h('strong', null, row.name), h('small', null, ` ${row.visibility}${row.mirror ? ' · GitHub mirror' : ''}`), directory ? h('small', { className: 'notch-github-local-path', title: directory }, directory) : null),
            h('button', { type: 'button', disabled: busy, 'aria-label': `${action} Origin ${row.name}`, onClick: () => act(directory ? 'openRepo' : 'clone', directory ? row.name : protocol === 'ssh' ? originCloneUrl(row.name, 'ssh') : row.cloneUrl) }, action));
        }) : h('li', null, 'No repositories match this filter.'))) : null,
      next ? h('button', { type: 'button', disabled: busy, onClick: () => act('repos', { owner, pageToken: next }) }, 'Load more Origin repositories') : null,
      state?.clonedPath ? h('div', null, h('p', { role: 'status' }, state.message || state.clonedPath), h('button', { type: 'button', disabled: busy, onClick: async () => { setError(''); try { await onOpenProject(state.clonedPath); } catch (failure) { setError(failure.message); } } }, 'Open project')) : null,
      error ? h('p', { role: 'alert' }, error) : null);
  };
}
