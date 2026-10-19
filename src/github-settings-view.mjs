export function createGitHubSettings(React) {
  const h = React.createElement;
  return function GitHubSettings() {
    const [state, setState] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const bridge = window.notchModels?.github;
    React.useEffect(() => {
      if (!bridge) return undefined;
      let alive = true;
      const refresh = () => bridge('status').then(value => { if (alive) setState(value); }).catch(failure => { if (alive) setError(failure.message); });
      void refresh();
      const timer = setInterval(refresh, 1500);
      return () => { alive = false; clearInterval(timer); };
    }, [bridge]);
    const act = async (action, value) => {
      setBusy(true); setError('');
      try { setState(await bridge(action, value)); }
      catch (failure) { setError(failure.message || 'GitHub setup could not finish.'); }
      finally { setBusy(false); }
    };
    if (!bridge) {
      return h('section', { className: 'notch-web-settings notch-github-settings', 'aria-labelledby': 'notch-github-title' },
        h('h3', { id: 'notch-github-title' }, 'GitHub'),
        h('p', null, 'Restart notch to sign in with GitHub.'));
    }
    const waiting = state?.phase === 'waiting';
    return h('section', { className: 'notch-web-settings notch-github-settings', 'aria-labelledby': 'notch-github-title' },
      h('h3', { id: 'notch-github-title' }, 'GitHub'),
      h('p', null, 'Sign in through the browser with GitHub CLI. Notch installs it when it is missing, then lists your repositories so you can clone one. The token stays in GitHub CLI’s credential store.'),
      state ? h('p', { role: 'status' }, state.message) : h('p', { role: 'status' }, 'Checking GitHub CLI…'),
      waiting ? h('div', null,
        h('p', { className: 'notch-github-code', 'aria-live': 'polite' }, state.code || '……'),
        h('a', { href: state.url || 'https://github.com/login/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open github.com/login/device')) : null,
      h('div', { className: 'notch-update-actions' },
        !state?.installed ? h('button', { type: 'button', disabled: busy || waiting, onClick: () => void act('install') }, 'Install GitHub CLI') : null,
        state?.installed && !state.account ? h('button', { type: 'button', disabled: busy || waiting, onClick: () => void act('login') }, 'Sign in with GitHub') : null,
        waiting ? h('button', { type: 'button', disabled: busy, onClick: () => void act('cancel') }, 'Cancel sign-in') : null,
        state?.account ? h('button', { type: 'button', disabled: busy || waiting, onClick: () => void act('repos') }, 'Show repositories') : null),
      Array.isArray(state?.repos) ? h('ul', { className: 'notch-github-repos' }, state.repos.length
        ? state.repos.map(repo => h('li', { key: repo.nameWithOwner },
          h('span', null, h('strong', null, repo.nameWithOwner), repo.isPrivate ? h('small', null, ' Private') : null, repo.description ? h('small', null, ` ${repo.description}`) : null),
          h('button', { type: 'button', disabled: busy || state.phase === 'cloning', onClick: () => void act('clone', repo.nameWithOwner) }, 'Clone')))
        : [h('li', { key: 'empty' }, 'No repositories on this account.')]) : null,
      error ? h('p', { role: 'alert' }, error) : null);
  };
}
