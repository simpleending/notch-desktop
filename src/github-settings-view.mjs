import { githubCloneUrl, githubRepository } from './github-repository.mjs';

export function createGitHubSettings(React) {
  const h = React.createElement;
  return function GitHubSettings({ onOpenProject, localProjects = [] } = {}) {
    const [state, setState] = React.useState(null);
    const [busy, setBusy] = React.useState(null);
    const [error, setError] = React.useState('');
    const [repo, setRepo] = React.useState('');
    const [pollError, setPollError] = React.useState('');
    const [query, setQuery] = React.useState('');
    const [owner, setOwner] = React.useState('');
    const [protocol, setProtocol] = React.useState('https');
    const request = React.useRef(0);
    const bridge = window.notchModels?.github;
    const projectPaths = JSON.stringify([...new Set(localProjects.map(project => project.path))]);
    React.useEffect(() => {
      if (!bridge) return undefined;
      let alive = true;
      let timer;
      let first = true;
      const refresh = async () => {
        const revision = request.current;
        try {
          const paths = first ? JSON.parse(projectPaths) : []; first = false;
          const value = paths.length ? await bridge('remember', paths) : await bridge('status');
          if (alive && revision === request.current) { setState(value); setPollError(''); }
        }
        catch (failure) { if (alive && revision === request.current) setPollError(failure.message); }
        finally { if (alive) timer = setTimeout(refresh, state?.phase === 'waiting' || state?.phase === 'cloning' ? 1500 : 15000); }
      };
      void refresh();
      return () => { alive = false; clearTimeout(timer); };
    }, [bridge, state?.phase, projectPaths]);
    const act = async (action, value) => {
      if (action === 'clone') {
        value = githubCloneUrl(value, protocol);
        if (!value) { setError('Enter owner/repo or an HTTPS or SSH GitHub repository URL.'); return; }
      }
      const revision = ++request.current;
      setBusy(action); setError(''); setPollError('');
      if (action === 'login') setState(previous => ({ ...previous, phase: 'waiting', code: null, message: 'Starting GitHub sign-in…' }));
      try {
        if (action === 'open') await onOpenProject(value);
        else {
          const next = await bridge(action, value);
          if (revision === request.current) {
            setState(next);
            if (action === 'openRepo' && next.clonedPath) await onOpenProject(next.clonedPath);
          }
        }
      } catch (failure) {
        if (revision === request.current) { setError(failure.message || 'GitHub setup could not finish.'); setState(previous => previous ? { ...previous, phase: 'ready' } : previous); }
      } finally { if (revision === request.current) setBusy(null); }
    };
    React.useEffect(() => {
      setQuery(''); setOwner('');
      if (state?.account && !Array.isArray(state.repos)) void act('repos');
    }, [bridge, state?.account]);
    if (!bridge) return h('section', { className: 'notch-web-settings notch-github-settings' }, h('h3', null, 'GitHub'), h('p', null, 'Restart notch to sign in with GitHub.'));
    const waiting = state?.phase === 'waiting';
    const localPath = name => state?.localClones?.[githubRepository(name)?.toLowerCase()];
    const existing = localPath(repo.trim());
    const rows = Array.isArray(state?.repos) ? state.repos : null;
    const owners = [...new Set((rows || []).map(row => row.nameWithOwner.split('/')[0]))].sort((a, b) => a.localeCompare(b));
    const search = query.trim().toLowerCase();
    const visible = rows?.filter(row => (!owner || row.nameWithOwner.split('/')[0] === owner) &&
      (!search || `${row.nameWithOwner} ${row.description || ''}`.toLowerCase().includes(search)));
    return h('section', { className: 'notch-web-settings notch-github-settings', 'aria-labelledby': 'notch-github-title' },
      h('h3', { id: 'notch-github-title', tabIndex: -1 }, 'GitHub'),
      h('p', null, 'Sign in through the browser with GitHub CLI, or use GH_TOKEN / GITHUB_TOKEN from your environment. Repository lists include organizations and collaborators. GitHub CLI uses system credential storage when available.'),
      h('p', { role: 'status' }, state?.message || 'Checking GitHub…'),
      waiting ? h('div', null, h('p', { className: 'notch-github-code', 'aria-live': 'polite' }, state.code || '……'), h('a', { href: state.url || 'https://github.com/login/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open github.com/login/device')) : null,
      h('div', { className: 'notch-update-actions' },
        !state?.installed ? h('button', { type: 'button', disabled: !state || !!busy || waiting, onClick: () => act('install') }, 'Install GitHub CLI') : null,
        state?.installed && !state.environmentToken ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('login') }, state.account ? 'Sign in with another account' : 'Sign in with GitHub') : null,
        waiting ? h('button', { type: 'button', disabled: busy === 'cancel', onClick: () => act('cancel') }, 'Cancel sign-in') : null,
        state?.account ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('repos') }, 'Show repositories') : null,
        error || pollError || state?.environmentToken && !state.account ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('status') }, 'Retry connection') : null),
      state?.account ? h('form', { onSubmit: event => { event.preventDefault(); void act(existing ? 'openRepo' : 'clone', repo.trim()); } },
        h('label', null, 'Repository (owner/repo)', h('input', { value: repo, placeholder: 'owner/repo or GitHub URL', spellCheck: false, autoCapitalize: 'none', autoComplete: 'off', maxLength: 2048, onChange: event => setRepo(event.target.value), required: true })),
        h('label', null, 'Clone protocol', h('select', { value: protocol, onChange: event => setProtocol(event.target.value), disabled: !!busy || waiting },
          h('option', { value: 'https' }, 'HTTPS'), h('option', { value: 'ssh' }, 'SSH'))),
        h('button', { type: 'submit', disabled: !!busy || waiting || !repo.trim() || !!existing && !onOpenProject }, existing ? 'Open repository' : 'Clone repository')) : null,
      state?.account && (protocol === 'ssh' || /^(?:git@|ssh:\/\/)/i.test(repo.trim())) ? h('p', null, 'SSH uses your local SSH keys or agent. Browser sign-in does not install an SSH key. A pasted URL keeps its own protocol.') : null,
      rows ? h('div', { className: 'notch-github-browser' },
        h('h4', null, 'Repositories'),
        h('p', null, 'Open a repository already on this device, or clone one to get started. Local clones are remembered after restarting notch.'),
        h('div', { className: 'notch-github-filters' },
          h('label', null, 'Filter loaded repositories', h('input', { type: 'search', value: query, placeholder: 'Name or description', onChange: event => setQuery(event.target.value) })),
          h('label', null, 'Repository owner', h('select', { value: owner, onChange: event => setOwner(event.target.value) },
            h('option', { value: '' }, 'All owners'), owners.map(name => h('option', { key: name, value: name }, name))))),
        h('p', { role: 'status', 'aria-live': 'polite' }, `${visible.length} of ${rows.length} loaded repositories${state.hasMore ? '. Load more to include older repositories.' : '.'}`),
        h('ul', { className: 'notch-github-repos', 'aria-label': 'GitHub repositories', tabIndex: 0 }, visible.length ? visible.map(row => {
          const directory = localPath(row.nameWithOwner), action = directory ? 'Open' : 'Clone';
          return h('li', { key: row.nameWithOwner },
            h('span', null, h('strong', null, row.nameWithOwner), row.isPrivate ? h('small', null, ' Private') : null, row.description ? h('small', null, ` ${row.description}`) : null,
              directory ? h('small', { className: 'notch-github-local-path', title: directory }, directory) : null),
            h('button', { type: 'button', disabled: !!busy || waiting || !!directory && !onOpenProject, 'aria-label': `${action} ${row.nameWithOwner}`, onClick: () => act(directory ? 'openRepo' : 'clone', row.nameWithOwner) }, action));
        }) : [h('li', { key: 'empty' }, rows.length ? 'No loaded repositories match these filters.' : 'No accessible repositories found.')])) : null,
      state?.hasMore ? h('button', { type: 'button', disabled: !!busy, onClick: () => act('repos', state.repoPage + 1) }, 'Load more repositories') : null,
      state?.clonedPath ? h('div', null, h('p', null, state.clonedPath), onOpenProject ? h('button', { type: 'button', disabled: !!busy, onClick: () => act('open', state.clonedPath) }, 'Open project') : null) : null,
      error || pollError ? h('p', { role: 'alert' }, error || pollError) : null);
  };
}
