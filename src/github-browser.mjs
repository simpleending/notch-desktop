import { uiMessage } from "./ui-messages.mjs";
import { createGitHubSettings } from './github-settings-view.mjs';
import { createOriginSettings } from './origin-settings-view.mjs';

export const GITHUB_BROWSER_EVENT = 'notch:open-github';
export function openGitHubBrowser() {
  window.dispatchEvent(new CustomEvent(GITHUB_BROWSER_EVENT));
}

export function createGitHubBrowser(React, useTheme) {
  const h = React.createElement, GitHubSettings = createGitHubSettings(React), OriginSettings = createOriginSettings(React);
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
    const [provider, setProvider] = React.useState('github');
    const { resolvedTheme } = useTheme();
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
        error ? h('p', { role: 'alert' }, uiMessage(error)) : null),
      h('div', { className: 'notch-repository-providers', role: 'group', 'aria-label': 'Repository service' },
        h('button', { type: 'button', 'aria-pressed': provider === 'github', onClick: () => setProvider('github') },
          h('img', { src: new URL(`./github/github-mark-${resolvedTheme?.endsWith('-dark') ? 'white' : 'black'}.svg`, import.meta.url).href, width: 16, height: 16, alt: '' }), 'GitHub'),
        h('button', { type: 'button', 'aria-pressed': provider === 'origin', onClick: () => setProvider('origin') },
          h('img', { src: new URL(`./origin/origin-repo-mark-${resolvedTheme?.endsWith('-dark') ? 'dark' : 'light'}.svg`, import.meta.url).href, width: 18, height: 18, alt: '' }), 'Origin')),
      h(provider === 'origin' ? OriginSettings : GitHubSettings, { onOpenProject, localProjects: projects }));
  }
  return { Entry, Browser };
}
