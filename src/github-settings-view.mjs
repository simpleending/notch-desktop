export function createGitHubSettings(React) {
  const h = React.createElement;
  return function GitHubSettings({ onOpenProject } = {}) {
    const [state, setState] = React.useState(null);
    const [busy, setBusy] = React.useState(null);
    const [error, setError] = React.useState('');
    const [repo, setRepo] = React.useState('');
    const request = React.useRef(0);
    const bridge = window.notchModels?.github;
    React.useEffect(() => {
      if (!bridge) return undefined;
      let alive = true;
      let timer;
      const refresh = async () => {
        const revision = request.current;
        try { const value = await bridge('status'); if (alive && revision === request.current) setState(value); }
        catch (failure) { if (alive && revision === request.current) setError(failure.message); }
        finally { if (alive) timer = setTimeout(refresh, state?.phase === 'waiting' || state?.phase === 'cloning' ? 1500 : 15000); }
      };
      void refresh();
      return () => { alive = false; clearTimeout(timer); };
    }, [bridge, state?.phase]);
    const act = async (action, value) => {
      const revision = ++request.current;
      setBusy(action); setError('');
      if (action === 'login') setState(previous => ({ ...previous, phase: 'waiting', code: null, message: 'Starting GitHub sign-in…' }));
      try {
        if (action === 'open') await onOpenProject(value);
        else { const next = await bridge(action, value); if (revision === request.current) setState(next); }
      } catch (failure) {
        if (revision === request.current) { setError(failure.message || 'GitHub setup could not finish.'); setState(previous => previous ? { ...previous, phase: 'ready' } : previous); }
      } finally { if (revision === request.current) setBusy(null); }
    };
    if (!bridge) return h('section', { className: 'notch-web-settings notch-github-settings' }, h('h3', null, 'GitHub'), h('p', null, 'Restart notch to sign in with GitHub.'));
    const waiting = state?.phase === 'waiting';
    return h('section', { className: 'notch-web-settings notch-github-settings', 'aria-labelledby': 'notch-github-title' },
      h('h3', { id: 'notch-github-title' }, 'GitHub'),
      h('p', null, 'Sign in through the browser with GitHub CLI, or use GH_TOKEN / GITHUB_TOKEN from your environment. Repository lists include organizations and collaborators. GitHub CLI uses system credential storage when available.'),
      h('p', { role: 'status' }, state?.message || 'Checking GitHub…'),
      waiting ? h('div', null, h('p', { className: 'notch-github-code', 'aria-live': 'polite' }, state.code || '……'), h('a', { href: state.url || 'https://github.com/login/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open github.com/login/device')) : null,
      h('div', { className: 'notch-update-actions' },
        !state?.installed ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('install') }, 'Install GitHub CLI') : null,
        state?.installed && !state.environmentToken ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('login') }, state.account ? 'Sign in with another account' : 'Sign in with GitHub') : null,
        waiting ? h('button', { type: 'button', disabled: busy === 'cancel', onClick: () => act('cancel') }, 'Cancel sign-in') : null,
        state?.account ? h('button', { type: 'button', disabled: !!busy || waiting, onClick: () => act('repos') }, 'Show repositories') : null),
      state?.account ? h('form', { onSubmit: event => { event.preventDefault(); void act('clone', repo.trim()); } },
        h('label', null, 'Repository (owner/repo)', h('input', { value: repo, placeholder: 'organization/project', onChange: event => setRepo(event.target.value), required: true, pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' })),
        h('button', { type: 'submit', disabled: !!busy || waiting || !repo.trim() }, 'Clone repository')) : null,
      Array.isArray(state?.repos) ? h('ul', { className: 'notch-github-repos' }, state.repos.length ? state.repos.map(row => h('li', { key: row.nameWithOwner },
        h('span', null, h('strong', null, row.nameWithOwner), row.isPrivate ? h('small', null, ' Private') : null, row.description ? h('small', null, ` ${row.description}`) : null),
        h('button', { type: 'button', disabled: !!busy, onClick: () => act('clone', row.nameWithOwner) }, 'Clone'))) : [h('li', { key: 'empty' }, 'No accessible repositories found.')]) : null,
      state?.hasMore ? h('button', { type: 'button', disabled: !!busy, onClick: () => act('repos', state.repoPage + 1) }, 'Load more repositories') : null,
      state?.clonedPath ? h('div', null, h('p', null, state.clonedPath), onOpenProject ? h('button', { type: 'button', disabled: !!busy, onClick: () => act('open', state.clonedPath) }, 'Open project') : null) : null,
      error ? h('p', { role: 'alert' }, error) : null);
  };
}
