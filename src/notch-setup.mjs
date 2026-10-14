const wordmarks = {
  dark: new URL('./notch-wordmark-dark.svg', import.meta.url).href,
  light: new URL('./notch-wordmark-light.svg', import.meta.url).href,
};
function initialTheme() {
  try {
    const saved = localStorage.getItem('notch.setup.theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* Storage can be unavailable in a preview. */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function createNotchSetup(React) {
  const h = React.createElement;
  return function NotchSetup({ onComplete, onClose } = {}) {
    const bridge = window.notchOnboardingOverlay;
    const preview = new URLSearchParams(window.location.search).get('preview') === '1';
    const [theme, setTheme] = React.useState(initialTheme);
    const [step, setStep] = React.useState(0);
    const [ready, setReady] = React.useState(!bridge);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const heading = React.useRef(null);
    const completion = React.useRef(false);
    React.useEffect(() => {
      try {
        localStorage.setItem('notch.setup.theme', theme);
        localStorage.setItem('notch-ui:theme-mode', theme);
        localStorage.setItem('notch-ui:color-mode', theme);
      } catch { /* Keep the appearance usable without storage. */ }
      document.documentElement.style.colorScheme = theme;
    }, [theme]);
    React.useEffect(() => {
      if (!bridge) return;
      let active = true;
      bridge.bootstrap(preview).then(() => { if (active) setReady(true); })
        .catch(() => { if (active) setError('Setup could not load. Close and reopen notch to try again.'); })
        .finally(() => { if (active) bridge.ready().catch(() => setError('The setup window could not open. Please restart notch.')); });
      return () => { active = false; };
    }, []);
    React.useEffect(() => { heading.current?.focus(); }, [step]);
    async function finish() {
      if (completion.current || !ready) return;
      completion.current = true; setBusy(true); setError('');
      try {
        const payload = { roles: [], customWorkRole: null };
        if (bridge) await bridge.complete(payload, preview);
        else if (onComplete) await onComplete(payload);
      } catch {
        completion.current = false; setBusy(false);
        setError('Could not finish setup. Your workspace is safe. Please try again.');
      }
    }
    async function close() {
      try { if (bridge) await bridge.close(); else await onClose?.(); }
      catch { setError('Could not close setup. Please try again.'); }
    }
    const badge = (number, title, body) => h('li', { key: number },
      h('span', { className: 'notch-setup-number', 'aria-hidden': true }, number),
      h('div', null, h('h3', null, title), h('p', null, body)));
    return h('main', { className: 'notch-setup', 'data-appearance': theme, 'aria-label': 'notch setup' },
      h('header', { className: 'notch-setup-bar' },
        h('span', { className: 'notch-setup-caption' }, 'MAKE SOMETHING YOURS'),
        h('div', { className: 'notch-setup-controls' },
          h('div', { role: 'group', 'aria-label': 'Setup appearance', className: 'notch-setup-themes' },
            ...['dark', 'light'].map(value => h('button', { key: value, type: 'button', 'aria-pressed': theme === value,
              disabled: busy, onClick: () => setTheme(value) }, value))),
          h('button', { type: 'button', className: 'notch-setup-close', 'aria-label': 'Close setup', disabled: busy, onClick: close }, '×'))),
      h('div', { className: 'notch-setup-layout' },
        h('aside', { className: 'notch-setup-brand' },
          h('img', { src: wordmarks[theme], alt: 'notch', width: 202, height: 60 }),
          h('p', { className: 'notch-setup-tagline' }, 'Less between you', h('br'), 'and your next idea.'),
          h('nav', { 'aria-label': 'Setup steps' }, ...['Welcome', 'Your workflow'].map((label, index) =>
            h('button', { key: label, type: 'button', disabled: busy, 'aria-current': step === index ? 'step' : undefined,
              onClick: () => setStep(index) }, h('span', { 'aria-hidden': true }, `0${index + 1}`), label))),
          h('div', { className: 'notch-setup-signature' }, h('span', { className: 'notch-setup-dot', 'aria-hidden': true }), 'local first · by Driftrail')),
        h('section', { className: 'notch-setup-content', 'aria-labelledby': 'notch-setup-heading' },
          h('span', { className: 'notch-setup-eyebrow' }, step ? 'YOUR WORKFLOW' : 'WELCOME TO YOUR WORKSPACE'),
          h('h1', { id: 'notch-setup-heading', ref: heading, tabIndex: -1 }, step ? 'Start small. Build freely.' : 'Your code.\nYour machine.'),
          h('p', { className: 'notch-setup-intro' }, step
            ? 'A project, a model, and a clear request. That’s where the work begins.'
            : 'An open workspace for focused coding, powered by the notch CLI harness and models you choose.'),
          step ? h('ol', { className: 'notch-setup-checklist' },
            badge('01', 'Open a project', 'Choose a workspace folder before starting a coding task.'),
            badge('02', 'Choose your model', 'Pick an installed Ollama model in the composer. The CLI can download smaller models when you need them.'),
            badge('03', 'Set access for the task', 'Use approvals for changes and commands, read only to explore, or full access for work you trust.'))
            : h('div', { className: 'notch-setup-cards' },
              h('article', null, h('span', { className: 'notch-setup-card-symbol', 'aria-hidden': true }, '↳'),
                h('h2', null, 'Local by default'), h('p', null, 'Run open models with Ollama. Local inference stays on your computer.')),
              h('article', null, h('span', { className: 'notch-setup-card-symbol', 'aria-hidden': true }, '⌘'),
                h('h2', null, 'You choose the access'), h('p', null, 'Decide when the agent can read, edit, and run commands in your project.'))),
          h('footer', { className: 'notch-setup-footer' },
            h('p', { className: 'notch-setup-note' }, step ? 'You can change the model and access for each task.' : 'No account required for local models.'),
            h('div', { className: 'notch-setup-actions' }, step ? h('button', { type: 'button', disabled: busy, onClick: () => setStep(0) }, 'Back') : null,
              h('button', { type: 'button', className: 'notch-setup-primary', disabled: busy || !ready,
                onClick: step ? finish : () => setStep(1) }, busy ? 'Opening…' : step ? 'Open notch →' : 'Continue →'))),
          error ? h('p', { role: 'alert', className: 'notch-setup-error' }, error) : null)));
  };
}
