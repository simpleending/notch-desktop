import { createGitHubSettings } from './github-settings-view.mjs';

export const GITHUB_BROWSER_EVENT = 'notch:open-github';
export function openGitHubBrowser() {
  window.dispatchEvent(new CustomEvent(GITHUB_BROWSER_EVENT));
}

export function createGitHubBrowser(React, useTheme) {
  const h = React.createElement, GitHubSettings = createGitHubSettings(React);
  function Entry({ variant = 'welcome', className = '' } = {}) {
    const { resolvedTheme } = useTheme();
    return h('button', { type: 'button', className: `notch-github-entry notch-github-entry-${variant} ${className}`,
      'data-notch-github-entry': variant, 'aria-label': 'Browse GitHub repositories', 'aria-haspopup': 'dialog',
      title: 'Browse GitHub repositories', onClick: openGitHubBrowser },
      h('img', { className: 'notch-github-mark', src: new URL(`./github/github-mark-${resolvedTheme.endsWith('-dark') ? 'white' : 'black'}.svg`, import.meta.url).href,
        width: 16, height: 16, alt: '', 'aria-hidden': true }), variant === 'sidebar' ? 'GitHub' : 'Clone from GitHub');
  }
  function Browser({ projects = [], onOpenProject }) {
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const open = async directory => {
      if (busy) return;
      setBusy(true); setError('');
      try {
        if (!directory) directory = await window.notchModels.github('pickLocal');
        if (directory) await onOpenProject(directory);
      } catch (failure) { setError(failure.message || 'The project could not be opened.'); }
      finally { setBusy(false); }
    };
    return h('div', { className: 'notch-github-dialog' },
      h('section', { className: 'notch-local-projects', 'aria-label': 'Projects on this device' },
        h('div', { className: 'notch-local-projects-heading' }, h('h3', null, 'On this device'),
          h('button', { type: 'button', disabled: busy, onClick: () => open() }, 'Open local repository…')),
        projects.length ? h('ul', { className: 'notch-local-project-list', 'aria-label': 'Local projects', tabIndex: 0 },
          projects.map(project => h('li', { key: project.id }, h('button', { type: 'button', disabled: busy,
            'aria-label': `Open ${project.name}`, title: project.path, onClick: () => open(project.path) },
          h('strong', null, project.name), h('small', null, project.path))))) :
          h('p', null, 'Already cloned a repository? Choose its folder to open it here.'),
        error ? h('p', { role: 'alert' }, error) : null),
      h(GitHubSettings, { onOpenProject }));
  }
  return { Entry, Browser };
}
